import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  consumeAuthorization,
  reapAuthorizations,
} from "./security/authority.js";
import { RlmController } from "./runtime/controller.js";
import { publicError, RlmError } from "./errors.js";
import { resolvePluginData } from "./spike/provenance.js";

const contextSchema = z.object({
  session: z.string().length(32),
});
const contextInput = {
  _rlm_context: contextSchema.optional().describe(
    "Reserved non-secret session pseudonym injected by the Codex RLM hook. Never author this field.",
  ),
};

const evidenceSchema = z.union([
  z.object({
    kind: z.literal("cell"),
    cell: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("artifact"),
    artifact: z
      .string()
      .min(1)
      .max(512)
      .describe("Path relative to the caller lane's ARTIFACT_ROOT."),
  }),
]);

const claimSchema = z.object({
  claim: z.string().min(1).max(10_000),
  evidence: z.array(evidenceSchema).min(1).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  caveats: z.array(z.string().max(2_000)).max(50),
});

type ToolResult = {
  content: { type: "text"; text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
};

function success(result: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function failure(error: unknown): ToolResult {
  const result = publicError(error);
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: true,
  };
}

function pluginRoot(): string {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export function createProductionServer(
  environment: NodeJS.ProcessEnv,
): {
  readonly server: McpServer;
  readonly controller: RlmController;
} {
  const pluginData = resolvePluginData(environment);
  const controller = new RlmController(pluginData, pluginRoot());
  const server = new McpServer(
    { name: "codex-rlm", version: "0.1.0-alpha.2" },
    {
      instructions:
        "Use RLM only after explicit $rlm invocation. Reserved _rlm_context is a non-secret session pseudonym injected by the hook; never author it. Authority stays in the plugin-private exchange. The local-process Python backend is non-hardened.",
    },
  );

  async function authorized(
    operation: string,
    context: z.infer<typeof contextSchema> | undefined,
    input: unknown,
    action: (
      authority: Awaited<ReturnType<typeof consumeAuthorization>>,
    ) => Promise<Record<string, unknown>>,
  ): Promise<ToolResult> {
    try {
      if (context === undefined) {
        throw new RlmError("AUTHORITY_MISSING");
      }
      const authority = await consumeAuthorization(
        pluginData,
        context.session,
        operation,
        input,
      );
      return success(await action(authority));
    } catch (error: unknown) {
      return failure(error);
    } finally {
      await reapAuthorizations(pluginData);
    }
  }

  server.registerTool(
    "rlm_start",
    {
      title: "Start Codex RLM research",
      description:
        "Start the explicit local evidence-backed RLM research session for the current Codex session and project.",
      inputSchema: {
        objective: z.string().min(1).max(20_000),
        required_lane_count: z.number().int().min(0).max(8).optional(),
        idempotency_key: z.string().min(8).max(128),
        ...contextInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({
      objective,
      required_lane_count,
      idempotency_key,
      _rlm_context,
    }) =>
      authorized(
        "rlm_start",
        _rlm_context,
        {
          objective,
          ...(required_lane_count === undefined
            ? {}
            : { required_lane_count }),
          idempotency_key,
        },
        (authority) =>
        controller.start(authority, {
          objective,
          requiredLaneCount: required_lane_count ?? 0,
          idempotencyKey: idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "rlm_status",
    {
      title: "Inspect Codex RLM session",
      description:
        "Read bounded state for the caller's active RLM session and visible lanes.",
      inputSchema: contextInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ _rlm_context }) =>
      authorized("rlm_status", _rlm_context, {}, (authority) =>
        controller.status(authority),
      ),
  );

  server.registerTool(
    "rlm_python",
    {
      title: "Run one recorded Python cell",
      description:
        "Execute one Python cell in the caller's persistent isolated lane and persist it before returning.",
      inputSchema: {
        code: z.string().min(1).max(100_000),
        timeout_ms: z.number().int().min(100).max(120_000).optional(),
        ...contextInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ code, timeout_ms, _rlm_context }) =>
      authorized(
        "rlm_python",
        _rlm_context,
        { code, ...(timeout_ms === undefined ? {} : { timeout_ms }) },
        (authority) =>
        controller.python(authority, {
          code,
          timeoutMs: timeout_ms ?? 120_000,
        }),
      ),
  );

  server.registerTool(
    "rlm_submit_findings",
    {
      title: "Submit evidence-backed lane findings",
      description:
        "Make the caller's lane terminal by submitting claims that reference persisted lane evidence, or an explicit no-findings result.",
      inputSchema: {
        claims: z.array(claimSchema).max(100),
        no_findings: z.boolean(),
        no_findings_reason: z.string().max(4_000).nullable(),
        ...contextInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ claims, no_findings, no_findings_reason, _rlm_context }) =>
      authorized(
        "rlm_submit_findings",
        _rlm_context,
        { claims, no_findings, no_findings_reason },
        (authority) =>
        controller.submitFindings(authority, {
          claims,
          noFindings: no_findings,
          noFindingsReason: no_findings_reason,
        }),
      ),
  );

  server.registerTool(
    "rlm_complete",
    {
      title: "Complete Codex RLM research",
      description:
        "Parent-only deterministic notebook/report finalization followed by kernel cleanup.",
      inputSchema: {
        summary: z.string().min(1).max(20_000),
        idempotency_key: z.string().min(8).max(128),
        ...contextInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ summary, idempotency_key, _rlm_context }) =>
      authorized(
        "rlm_complete",
        _rlm_context,
        { summary, idempotency_key },
        (authority) =>
        controller.complete(authority, {
          summary,
          idempotencyKey: idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "rlm_cancel",
    {
      title: "Cancel Codex RLM research",
      description:
        "Parent-only cancellation that preserves completed evidence and reaps all session workers.",
      inputSchema: {
        reason: z.string().min(1).max(4_000),
        idempotency_key: z.string().min(8).max(128),
        ...contextInput,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async ({ reason, idempotency_key, _rlm_context }) =>
      authorized(
        "rlm_cancel",
        _rlm_context,
        { reason, idempotency_key },
        (authority) =>
        controller.cancel(authority, {
          reason,
          idempotencyKey: idempotency_key,
        }),
      ),
  );

  server.registerTool(
    "rlm_diagnostic",
    {
      title: "Check Codex RLM authority transport",
      description:
        "Consume one hook-issued private authorization record and report only its role and operation binding.",
      inputSchema: {
        label: z.string().max(80).optional(),
        ...contextInput,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ label, _rlm_context }) =>
      authorized(
        "rlm_diagnostic",
        _rlm_context,
        { ...(label === undefined ? {} : { label }) },
        async (authority) => ({
        authorization_consumed: true,
        role: authority.role,
        agent_bound: authority.agentDigest !== null,
        implementation_stage: "runtime",
      }),
      ),
  );

  return { server, controller };
}

async function main(): Promise<void> {
  const { server, controller } = createProductionServer(process.env);
  let closing = false;
  const cleanup = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await controller.cleanupAll();
  };
  process.once("SIGINT", () => {
    void cleanup().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void cleanup().finally(() => process.exit(143));
  });
  process.stdin.once("end", () => {
    void cleanup();
  });
  await server.connect(new StdioServerTransport());
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
