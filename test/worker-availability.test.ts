import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RlmError } from "../src/errors.js";
import { WorkerManager } from "../src/kernels/worker-manager.js";

test("backend rejects a configured executable that is not CPython 3.11+", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-python-"));
  const manager = new WorkerManager(pluginData, process.cwd(), process.execPath);
  assert.throws(
    () => manager.assertAvailable(),
    (error: unknown) =>
      error instanceof RlmError && error.category === "BACKEND_UNAVAILABLE",
  );
});

test("backend discovers the CI Python 3.11+ interpreter", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-python-"));
  const manager = new WorkerManager(pluginData, process.cwd(), "python3");
  assert.doesNotThrow(() => manager.assertAvailable());
});

test("malformed registry records never cause PID signalling", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-registry-"));
  const sessionId = "malformed-session";
  const registryRoot = join(
    pluginData,
    "process-registry",
    "workers",
    sessionId,
  );
  await mkdir(registryRoot, { recursive: true });
  const unrelated = spawn(process.execPath, [
    "-e",
    "setInterval(() => undefined, 10000)",
  ]);
  if (unrelated.pid === undefined) {
    assert.fail("unrelated process did not start");
  }
  try {
    await writeFile(
      join(registryRoot, "forged.json"),
      JSON.stringify({
        schemaVersion: 2,
        sessionId,
        laneId: "forged",
        controlSocket: "/tmp/not-owned-by-codex-rlm.sock",
        pid: unrelated.pid,
      }),
      "utf8",
    );
    const manager = new WorkerManager(pluginData, process.cwd(), "python3");
    await manager.cleanupSession(sessionId);
    assert.doesNotThrow(() => process.kill(unrelated.pid as number, 0));
  } finally {
    unrelated.kill("SIGTERM");
    await once(unrelated, "exit");
  }
});

test("unverified control replies block cleanup and preserve the registry", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-registry-"));
  const sessionId = "unverified-session";
  const laneId = "lane-1";
  const controlRoot = join(pluginData, "c");
  const registryRoot = join(
    pluginData,
    "process-registry",
    "workers",
    sessionId,
  );
  await mkdir(controlRoot, { recursive: true });
  await mkdir(registryRoot, { recursive: true });
  const controlSocket = join(controlRoot, "unverified.sock");
  const registryPath = join(registryRoot, `${laneId}.json`);
  let acceptedConnection: Socket | undefined;
  const server = createServer((connection) => {
    acceptedConnection = connection;
    connection.end('{"ok":false}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(controlSocket, resolve);
  });
  try {
    await writeFile(
      registryPath,
      JSON.stringify({
        schemaVersion: 2,
        sessionId,
        laneId,
        controlSocket,
      }),
      "utf8",
    );
    const manager = new WorkerManager(pluginData, process.cwd(), "python3");
    await assert.rejects(
      manager.cleanupSession(sessionId),
      (error: unknown) =>
        error instanceof RlmError && error.category === "WORKER_FAILED",
    );
    assert.equal((await stat(registryPath)).isFile(), true);
  } finally {
    acceptedConnection?.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
});
