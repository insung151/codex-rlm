import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return false;
  }
}

test(
  "worker exits when its control-plane owner is killed",
  { skip: process.platform === "win32", timeout: 10_000 },
  async () => {
    const owner = spawn(
      process.execPath,
      [".test-dist/test/fixtures/worker-owner.js"],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const lines = createInterface({ input: owner.stdout });
    const [line] = (await once(lines, "line")) as [string];
    const workerPid = Number.parseInt(line, 10);
    assert.ok(Number.isSafeInteger(workerPid));
    assert.equal(processExists(workerPid), true);

    owner.kill("SIGKILL");
    await once(owner, "exit");
    const deadline = Date.now() + 5_000;
    while (processExists(workerPid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(processExists(workerPid), false);
  },
);
