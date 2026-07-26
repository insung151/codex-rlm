import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerManager } from "../../src/kernels/worker-manager.js";
import type { LaneRecord, SessionRecord } from "../../src/domain/types.js";

const pluginDataBase = await mkdtemp(
  join(tmpdir(), "codex-rlm-owner-data-"),
);
const pluginData = join(pluginDataBase, "x".repeat(70));
await mkdir(pluginData, { recursive: true });
const projectRoot = await mkdtemp(join(tmpdir(), "codex-rlm-owner-project-"));
const artifactRoot = join(projectRoot, ".codex", "rlm", "owner-test");
const lane: LaneRecord = {
  id: "parent",
  role: "parent",
  agentDigest: null,
  creationIndex: 0,
  status: "active",
  executionCount: 0,
  runningCell: false,
};
const session: SessionRecord = {
  schemaVersion: 1,
  id: "owner-test",
  codexSessionDigest: "owner-test",
  objective: "parent death cleanup",
  projectRoot,
  artifactRoot,
  requiredLaneCount: 0,
  idempotencyKey: "owner-test",
  createdAt: new Date().toISOString(),
  backend: {
    kind: "local-process",
    hardened: false,
    warning: "test",
  },
  status: "active",
  completionIdempotencyKey: null,
  cancellationIdempotencyKey: null,
  lanes: [lane],
};
await mkdir(join(artifactRoot, "lanes", "parent", "artifacts"), {
  recursive: true,
});
const manager = new WorkerManager(pluginData, process.cwd());
await manager.execute(session, lane, "owner_value = 1", 5_000);
const [workerPid] = manager.pidsForSession(session.id);
if (workerPid === undefined) {
  throw new Error("worker did not start");
}
process.stdout.write(`${String(workerPid)}\n`);
setInterval(() => undefined, 10_000);
