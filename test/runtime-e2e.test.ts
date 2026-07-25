import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RlmError } from "../src/errors.js";
import type { Role } from "../src/domain/types.js";
import {
  consumeAuthorization,
  issueAuthorization,
  toolInputDigest,
  type ConsumedAuthority,
} from "../src/security/authority.js";
import { RlmController } from "../src/runtime/controller.js";
import type { NotebookDocument } from "../src/notebooks/notebook.js";

async function authority(
  pluginData: string,
  operation: string,
  projectRoot: string,
  role: Role,
  agentDigest: string | null,
  input: unknown = {},
): Promise<ConsumedAuthority> {
  await issueAuthorization(pluginData, {
    codexSessionDigest: "codex-session-a",
    agentDigest,
    role,
    operation,
    inputDigest: toolInputDigest(input),
    cwd: projectRoot,
  });
  return consumeAuthorization(
    pluginData,
    "codex-session-a",
    operation,
    input,
  );
}

test("parent and subagent research persists evidence and cleans kernels", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-data-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-rlm-project-"));
  const pluginRoot = process.cwd();
  process.env.RLM_TEST_HOST_CREDENTIAL = "must-not-reach-worker-or-artifacts";
  const controller = new RlmController(pluginData, pluginRoot);

  const started = await controller.start(
    await authority(pluginData, "rlm_start", projectRoot, "parent", null),
    {
      objective: "Prove isolated persistent lanes",
      requiredLaneCount: 1,
      idempotencyKey: "start-e2e-0001",
    },
  );
  const sessionId = started.rlm_session_id as string;
  const artifactRoot = join(projectRoot, ".codex", "rlm", sessionId);

  const parentOne = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    { code: "value = 41\nvalue", timeoutMs: 5_000 },
  );
  const parentTwo = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    { code: "value + 1", timeoutMs: 5_000 },
  );
  assert.equal(parentOne.result, "41");
  assert.equal(parentTwo.result, "42");

  const subagentOne = await controller.python(
    await authority(
      pluginData,
      "rlm_python",
      projectRoot,
      "subagent",
      "agent-a",
    ),
    {
      code: "globals().get('value', 'isolated')",
      timeoutMs: 5_000,
    },
  );
  const subagentTwo = await controller.python(
    await authority(
      pluginData,
      "rlm_python",
      projectRoot,
      "subagent",
      "agent-a",
    ),
    {
      code: "import os\n'RLM_TEST_HOST_CREDENTIAL' in os.environ",
      timeoutMs: 5_000,
    },
  );
  assert.equal(subagentOne.result, "'isolated'");
  assert.equal(subagentTwo.result, "False");

  await controller.submitFindings(
    await authority(
      pluginData,
      "rlm_submit_findings",
      projectRoot,
      "subagent",
      "agent-a",
    ),
    {
      claims: [
        {
          claim: "The subagent lane does not inherit the parent variable.",
          evidence: [{ kind: "cell", cell: 1 }],
          confidence: "high",
          caveats: [],
        },
      ],
      noFindings: false,
      noFindingsReason: null,
    },
  );

  await controller.submitFindings(
    await authority(
      pluginData,
      "rlm_submit_findings",
      projectRoot,
      "parent",
      null,
    ),
    {
      claims: [
        {
          claim: "Parent state persisted across cells.",
          evidence: [{ kind: "cell", cell: 2 }],
          confidence: "high",
          caveats: [],
        },
      ],
      noFindings: false,
      noFindingsReason: null,
    },
  );

  await assert.rejects(
    controller.complete(
      await authority(
        pluginData,
        "rlm_complete",
        projectRoot,
        "subagent",
        "agent-a",
      ),
      { summary: "forged", idempotencyKey: "complete-forged" },
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "ROLE_FORBIDDEN",
  );
  await assert.rejects(
    controller.cancel(
      await authority(
        pluginData,
        "rlm_cancel",
        projectRoot,
        "subagent",
        "agent-a",
      ),
      { reason: "forged", idempotencyKey: "cancel-forged" },
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "ROLE_FORBIDDEN",
  );

  assert.equal(controller.pidsForSession(sessionId).length, 2);
  const completed = await controller.complete(
    await authority(pluginData, "rlm_complete", projectRoot, "parent", null),
    {
      summary: "Both lanes produced persisted evidence.",
      idempotencyKey: "complete-e2e-0001",
    },
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(controller.pidsForSession(sessionId), []);
  const completedAgain = await controller.complete(
    await authority(pluginData, "rlm_complete", projectRoot, "parent", null),
    {
      summary: "ignored on idempotent retry",
      idempotencyKey: "complete-e2e-0001",
    },
  );
  assert.equal(completedAgain.status, "completed");

  const parentNotebook = JSON.parse(
    await readFile(
      join(artifactRoot, "lanes", "parent", "notebook.ipynb"),
      "utf8",
    ),
  ) as NotebookDocument;
  const subagentNotebook = JSON.parse(
    await readFile(
      join(artifactRoot, "lanes", "lane-1", "notebook.ipynb"),
      "utf8",
    ),
  ) as NotebookDocument;
  const master = JSON.parse(
    await readFile(join(artifactRoot, "master.ipynb"), "utf8"),
  ) as NotebookDocument;
  assert.equal(parentNotebook.cells.length, 2);
  assert.equal(subagentNotebook.cells.length, 2);
  assert.deepEqual(
    master.cells.map((cell) => cell.metadata.rlm.lane_id),
    ["parent", "parent", "lane-1", "lane-1"],
  );
  const report = await readFile(join(artifactRoot, "report.md"), "utf8");
  assert.match(report, /parent:cell-2/);
  assert.match(report, /lane-1:cell-1/);
  assert.match(report, /NON-HARDENED DEVELOPMENT BACKEND/);

  const artifactFiles = await readdir(artifactRoot, { recursive: true });
  const artifactText = (
    await Promise.all(
      artifactFiles.map(async (relativePath) => {
        const path = join(artifactRoot, relativePath);
        return (await stat(path)).isFile() ? readFile(path, "utf8") : "";
      }),
    )
  ).join("\n");
  assert.doesNotMatch(artifactText, /must-not-reach-worker-or-artifacts/);
  assert.doesNotMatch(artifactText, /_rlm_auth|handle/);
});

test("timeout and cancellation preserve the cell and reap the worker", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-data-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-rlm-project-"));
  const controller = new RlmController(pluginData, process.cwd());
  const started = await controller.start(
    await authority(pluginData, "rlm_start", projectRoot, "parent", null),
    {
      objective: "Timeout cleanup",
      requiredLaneCount: 0,
      idempotencyKey: "start-timeout-0001",
    },
  );
  const sessionId = started.rlm_session_id as string;
  await import("node:fs/promises").then(({ writeFile }) =>
    writeFile(join(projectRoot, "protected.txt"), "keep", "utf8"),
  );
  const filesystemEscape = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    {
      code: "open(PROJECT_ROOT / 'forbidden.txt', 'w').write('no')",
      timeoutMs: 5_000,
    },
  );
  assert.equal(filesystemEscape.status, "failed");
  assert.equal(filesystemEscape.error_name, "PermissionError");
  await assert.rejects(readFile(join(projectRoot, "forbidden.txt")));

  const hostReadEscape = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    {
      code: "open('/etc/passwd', 'r').read(1)",
      timeoutMs: 5_000,
    },
  );
  assert.equal(hostReadEscape.status, "failed");
  assert.equal(hostReadEscape.error_name, "PermissionError");

  const projectRead = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    {
      code: "open(PROJECT_ROOT / 'protected.txt', 'r').read()",
      timeoutMs: 5_000,
    },
  );
  assert.equal(projectRead.status, "succeeded");
  assert.equal(projectRead.result, "'keep'");

  const deleteEscape = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    {
      code: "import os\nos.remove(PROJECT_ROOT / 'protected.txt')",
      timeoutMs: 5_000,
    },
  );
  assert.equal(deleteEscape.status, "failed");
  assert.equal(deleteEscape.error_name, "PermissionError");
  assert.equal(
    await readFile(join(projectRoot, "protected.txt"), "utf8"),
    "keep",
  );

  const networkEscape = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    {
      code: "import socket\nsocket.create_connection(('example.com', 80))",
      timeoutMs: 5_000,
    },
  );
  assert.equal(networkEscape.status, "failed");
  assert.equal(networkEscape.error_name, "PermissionError");

  const subprocessEscape = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    {
      code: "import subprocess\nsubprocess.run(['/bin/true'])",
      timeoutMs: 5_000,
    },
  );
  assert.equal(subprocessEscape.status, "failed");
  assert.equal(subprocessEscape.error_name, "PermissionError");

  const oversized = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    { code: "print('x' * 300000)", timeoutMs: 5_000 },
  );
  assert.equal(oversized.status, "succeeded");
  assert.equal(oversized.truncated, true);

  const result = await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    { code: "while True:\n    pass", timeoutMs: 200 },
  );
  assert.equal(result.status, "timed_out");
  assert.deepEqual(controller.pidsForSession(sessionId), []);
  const notebook = JSON.parse(
    await readFile(
      join(
        projectRoot,
        ".codex",
        "rlm",
        sessionId,
        "lanes",
        "parent",
        "notebook.ipynb",
      ),
      "utf8",
    ),
  ) as NotebookDocument;
  assert.deepEqual(
    notebook.cells.map((cell) => cell.metadata.rlm.status),
    [
      "failed",
      "failed",
      "succeeded",
      "failed",
      "failed",
      "failed",
      "succeeded",
      "timed_out",
    ],
  );
  assert.equal(notebook.cells[6]?.metadata.rlm.truncated, true);

  const cancelled = await controller.cancel(
    await authority(pluginData, "rlm_cancel", projectRoot, "parent", null),
    { reason: "test", idempotencyKey: "cancel-timeout-0001" },
  );
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(controller.pidsForSession(sessionId), []);
  const cancelledAgain = await controller.cancel(
    await authority(pluginData, "rlm_cancel", projectRoot, "parent", null),
    { reason: "retry", idempotencyKey: "cancel-timeout-0001" },
  );
  assert.equal(cancelledAgain.status, "cancelled");
});

test("normal MCP shutdown durably cancels owned active sessions", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-data-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-rlm-project-"));
  const controller = new RlmController(pluginData, process.cwd());
  const started = await controller.start(
    await authority(pluginData, "rlm_start", projectRoot, "parent", null),
    {
      objective: "normal shutdown",
      requiredLaneCount: 0,
      idempotencyKey: "start-shutdown-0001",
    },
  );
  const sessionId = started.rlm_session_id as string;
  await controller.python(
    await authority(pluginData, "rlm_python", projectRoot, "parent", null),
    { code: "shutdown_value = 1", timeoutMs: 5_000 },
  );
  assert.equal(controller.pidsForSession(sessionId).length, 1);
  await controller.cleanupAll();
  assert.deepEqual(controller.pidsForSession(sessionId), []);
  const metadata = JSON.parse(
    await readFile(
      join(projectRoot, ".codex", "rlm", sessionId, "metadata.json"),
      "utf8",
    ),
  ) as { readonly status: string; readonly lanes: { status: string }[] };
  assert.equal(metadata.status, "cancelled");
  assert.deepEqual(metadata.lanes.map((lane) => lane.status), ["cancelled"]);
});

test("simultaneous first calls create distinct parallel lanes and kernels", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-data-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-rlm-project-"));
  const parentController = new RlmController(pluginData, process.cwd());
  const firstController = new RlmController(pluginData, process.cwd());
  const secondController = new RlmController(pluginData, process.cwd());
  const started = await parentController.start(
    await authority(pluginData, "rlm_start", projectRoot, "parent", null),
    {
      objective: "parallel first-call isolation",
      requiredLaneCount: 2,
      idempotencyKey: "start-parallel-0001",
    },
  );
  const sessionId = started.rlm_session_id as string;

  const [first, second] = await Promise.all([
    firstController.python(
      await authority(
        pluginData,
        "rlm_python",
        projectRoot,
        "subagent",
        "parallel-a",
      ),
      { code: "lane_value = 100\nlane_value + 1", timeoutMs: 5_000 },
    ),
    secondController.python(
      await authority(
        pluginData,
        "rlm_python",
        projectRoot,
        "subagent",
        "parallel-b",
      ),
      { code: "lane_value = 200\nlane_value + 2", timeoutMs: 5_000 },
    ),
  ]);

  assert.deepEqual([first.result, second.result], ["101", "202"]);
  const workerPids = [
    ...firstController.pidsForSession(sessionId),
    ...secondController.pidsForSession(sessionId),
  ];
  assert.equal(workerPids.length, 2);
  const status = await parentController.status(
    await authority(pluginData, "rlm_status", projectRoot, "parent", null),
  );
  assert.deepEqual(
    (status.lanes as { readonly id: string }[]).map((lane) => lane.id),
    ["parent", "lane-1", "lane-2"],
  );
  await firstController.cleanupAll();
  const afterSubagentShutdown = await parentController.status(
    await authority(pluginData, "rlm_status", projectRoot, "parent", null),
  );
  assert.equal(afterSubagentShutdown.status, "active");
  assert.equal(
    (
      afterSubagentShutdown.lanes as {
        readonly role: string;
        readonly status: string;
      }[]
    ).filter(
      (lane) => lane.role === "subagent" && lane.status === "cancelled",
    ).length,
    1,
  );
  await parentController.cancel(
    await authority(pluginData, "rlm_cancel", projectRoot, "parent", null),
    { reason: "parallel test cleanup", idempotencyKey: "cancel-parallel-0001" },
  );
  for (const pid of workerPids) {
    assert.throws(() => process.kill(pid, 0));
  }
  await Promise.all([
    secondController.cleanupAll(),
  ]);
});
