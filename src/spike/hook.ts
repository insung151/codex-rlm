import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import {
  appendStructuralEvent,
  classifyTurn,
  digestIdentifier,
  readStructuralEvents,
  resolvePluginData,
  type CorrelationClass,
} from "./provenance.js";
import {
  discardAuthorizationsForSession,
  issueAuthorization,
  reapAuthorizations,
  toolInputDigest,
} from "../security/authority.js";
import { SessionRepository } from "../domain/session-repository.js";

interface HookInput {
  readonly session_id?: unknown;
  readonly turn_id?: unknown;
  readonly tool_use_id?: unknown;
  readonly agent_id?: unknown;
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectInput(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return { ...value } as Record<string, unknown>;
}

function operationFromTool(tool: string): string | null {
  const operation = tool.split("__").at(-1);
  return operation?.startsWith("rlm_") === true ? operation : null;
}

function deny(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export async function processHook(
  rawInput: unknown,
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | null> {
  if (typeof rawInput !== "object" || rawInput === null) {
    throw new Error("hook input must be an object");
  }

  const input = rawInput as HookInput;
  const pluginData = resolvePluginData(environment);
  const eventName = optionalString(input.hook_event_name);
  if (eventName === null) {
    throw new Error("hook_event_name is required");
  }

  const session = digestIdentifier(
    pluginData,
    optionalString(input.session_id),
  );
  const turn = digestIdentifier(pluginData, optionalString(input.turn_id));
  const agent = digestIdentifier(pluginData, optionalString(input.agent_id));
  const tool = optionalString(input.tool_name);

  await reapAuthorizations(pluginData);

  let correlation: CorrelationClass | null = null;
  if (eventName === "PreToolUse") {
    correlation = classifyTurn(readStructuralEvents(pluginData), session, turn);
  }

  appendStructuralEvent(pluginData, {
    source: "hook",
    event: eventName,
    session,
    turn,
    agent,
    tool,
    correlation,
    rewriteReceived: null,
  });

  if (eventName === "SessionEnd" && session !== null) {
    await discardAuthorizationsForSession(pluginData, session);
  }

  if (eventName === "SubagentStop" && session !== null && agent !== null) {
    const activeSession = await new SessionRepository(
      pluginData,
    ).findByCodexSession(session);
    if (activeSession?.status === "active") {
      const lane = activeSession.lanes.find(
        (candidate) => candidate.agentDigest === agent,
      );
      if (
        lane === undefined ||
        (lane.status !== "submitted" && lane.status !== "no_findings")
      ) {
        const attempts = readStructuralEvents(pluginData).filter(
          (event) =>
            event.event === "SubagentStop" &&
            event.session === session &&
            event.agent === agent,
        ).length;
        if (attempts <= 2) {
          return {
            continue: false,
            stopReason:
              "Submit evidence-backed RLM findings or an explicit no_findings result before stopping.",
          };
        }
        return {
          systemMessage:
            "RLM lane stopped without terminal findings after the bounded retry limit; parent completion remains blocked.",
        };
      }
    }
  }

  if (eventName !== "PreToolUse" || tool === null) {
    return null;
  }
  const operation = operationFromTool(tool);
  if (operation === null) {
    return null;
  }
  const cwd = optionalString(
    (input as HookInput & { readonly cwd?: unknown }).cwd,
  );
  const request = digestIdentifier(
    pluginData,
    optionalString(input.tool_use_id),
  );
  if (session === null || turn === null || request === null || cwd === null) {
    return deny("RLM authority context is incomplete");
  }
  if (agent !== null) {
    const matchingStarts = readStructuralEvents(pluginData).filter(
      (event) =>
        event.event === "SubagentStart" &&
        event.session === session &&
        event.agent === agent,
    );
    if (matchingStarts.length !== 1) {
      return deny("RLM subagent identity is ambiguous");
    }
  }

  await issueAuthorization(pluginData, {
    codexSessionDigest: session,
    requestDigest: request,
    agentDigest: agent,
    role: agent === null ? "parent" : "subagent",
    operation,
    inputDigest: toolInputDigest(objectInput(input.tool_input)),
    cwd,
  });

  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        ...objectInput(input.tool_input),
        _rlm_context: { session, request },
      },
    },
  };
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const output = await processHook(
      JSON.parse(await readStandardInput()),
      process.env,
    );
    if (output !== null) {
      stdout.write(`${JSON.stringify(output)}\n`);
    }
  } catch (error: unknown) {
    stdout.write(
      `${JSON.stringify(deny("Codex RLM authority hook failed closed"))}\n`,
    );
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
