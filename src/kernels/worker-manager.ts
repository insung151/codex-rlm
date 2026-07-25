import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { RlmError } from "../errors.js";
import { atomicWriteJson } from "../persistence/atomic.js";
import type { CellRecord, LaneRecord, SessionRecord } from "../domain/types.js";

interface WorkerReply {
  readonly id: string;
  readonly status: "succeeded" | "failed";
  readonly stdout: string;
  readonly stderr: string;
  readonly result: string | null;
  readonly error_name: string | null;
  readonly error_message: string | null;
  readonly truncated: boolean;
}

interface PendingRequest {
  readonly resolve: (reply: WorkerReply) => void;
  readonly reject: (error: Error) => void;
}

class LaneWorker {
  readonly process: ChildProcessWithoutNullStreams;
  readonly lines: Interface;
  readonly pending = new Map<string, PendingRequest>();
  queue: Promise<void> = Promise.resolve();

  public constructor(
    pythonExecutable: string,
    workerScript: string,
    session: SessionRecord,
    lane: LaneRecord,
  ) {
    const artifactRoot = join(
      session.artifactRoot,
      "lanes",
      lane.id,
      "artifacts",
    );
    this.process = spawn(pythonExecutable, ["-I", "-u", workerScript], {
      cwd: artifactRoot,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONIOENCODING: "utf-8",
        PYTHONDONTWRITEBYTECODE: "1",
        RLM_PROJECT_ROOT: session.projectRoot,
        RLM_ARTIFACT_ROOT: artifactRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      let reply: WorkerReply;
      try {
        reply = JSON.parse(line) as WorkerReply;
      } catch (error: unknown) {
        this.failAll(new RlmError("WORKER_FAILED"));
        return;
      }
      const request = this.pending.get(reply.id);
      if (request !== undefined) {
        this.pending.delete(reply.id);
        request.resolve(reply);
      }
    });
    this.process.once("exit", () => {
      this.failAll(new RlmError("WORKER_FAILED"));
    });
    let internalStderrBytes = 0;
    this.process.stderr.on("data", (chunk: Buffer) => {
      internalStderrBytes += chunk.length;
      if (internalStderrBytes > 64 * 1024) {
        this.process.kill("SIGKILL");
      }
    });
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      request.reject(error);
    }
    this.pending.clear();
  }

  public async execute(
    code: string,
    timeoutMs: number,
    outputLimit: number,
  ): Promise<WorkerReply> {
    const requestId = randomBytes(12).toString("hex");
    const response = new Promise<WorkerReply>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.process.stdin.write(
        `${JSON.stringify({
          id: requestId,
          code,
          output_limit: outputLimit,
        })}\n`,
      );
    });
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        response,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new RlmError("CELL_TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      this.pending.delete(requestId);
    }
  }

  public async stop(): Promise<void> {
    this.lines.close();
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      return;
    }
    this.process.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => this.process.once("exit", () => resolve())),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (this.process.exitCode === null) {
            this.process.kill("SIGKILL");
          }
          resolve();
        }, 1_000),
      ),
    ]);
  }
}

export class WorkerManager {
  readonly #pluginData: string;
  readonly #workerScript: string;
  readonly #pythonExecutable: string;
  readonly #workers = new Map<string, LaneWorker>();
  readonly #registryPaths = new Map<string, string>();

  public constructor(
    pluginData: string,
    pluginRoot: string,
    pythonExecutable = "/usr/bin/python3",
  ) {
    this.#pluginData = pluginData;
    this.#workerScript = join(pluginRoot, "worker", "rlm_worker.py");
    this.#pythonExecutable = pythonExecutable;
  }

  #key(sessionId: string, laneId: string): string {
    return `${sessionId}:${laneId}`;
  }

  #registryRoot(sessionId: string): string {
    return join(this.#pluginData, "process-registry", "workers", sessionId);
  }

  async #processStartTicks(pid: number): Promise<string | null> {
    try {
      const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      return fields[19] ?? null;
    } catch (error: unknown) {
      return null;
    }
  }

  async #registerWorker(
    key: string,
    sessionId: string,
    laneId: string,
    worker: LaneWorker,
  ): Promise<void> {
    const pid = worker.process.pid;
    if (pid === undefined) {
      throw new RlmError("WORKER_FAILED");
    }
    const startTicks = await this.#processStartTicks(pid);
    if (startTicks === null) {
      throw new RlmError("WORKER_FAILED");
    }
    const root = this.#registryRoot(sessionId);
    await mkdir(root, {
      recursive: true,
      mode: 0o700,
    });
    const path = join(root, `${laneId}.json`);
    await atomicWriteJson(
      path,
      {
        schemaVersion: 1,
        sessionId,
        laneId,
        pid,
        startTicks,
      },
    );
    this.#registryPaths.set(key, path);
  }

  async #unregisterWorker(key: string): Promise<void> {
    const path = this.#registryPaths.get(key);
    if (path !== undefined) {
      await rm(path, { force: true });
      this.#registryPaths.delete(key);
    }
  }

  async #registeredWorkers(
    sessionId: string,
  ): Promise<
    {
      readonly path: string;
      readonly pid: number;
      readonly startTicks: string;
    }[]
  > {
    const root = this.#registryRoot(sessionId);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error: unknown) {
      return [];
    }
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const path = join(root, entry);
          try {
            const record = JSON.parse(await readFile(path, "utf8")) as {
              readonly sessionId?: unknown;
              readonly pid?: unknown;
              readonly startTicks?: unknown;
            };
            if (
              record.sessionId !== sessionId ||
              typeof record.pid !== "number" ||
              typeof record.startTicks !== "string"
            ) {
              throw new Error("invalid worker registry record");
            }
            return {
              path,
              pid: record.pid,
              startTicks: record.startTicks,
            };
          } catch (error: unknown) {
            await rm(path, { force: true });
            return null;
          }
        }),
    );
    return records.filter(
      (
        record,
      ): record is {
        readonly path: string;
        readonly pid: number;
        readonly startTicks: string;
      } => record !== null,
    );
  }

  async #reapRegisteredSession(sessionId: string): Promise<void> {
    for (const record of await this.#registeredWorkers(sessionId)) {
      if ((await this.#processStartTicks(record.pid)) !== record.startTicks) {
        await rm(record.path, { force: true });
        continue;
      }
      try {
        process.kill(record.pid, "SIGTERM");
      } catch (error: unknown) {
        await rm(record.path, { force: true });
        continue;
      }
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (
          (await this.#processStartTicks(record.pid)) !== record.startTicks
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if ((await this.#processStartTicks(record.pid)) === record.startTicks) {
        try {
          process.kill(record.pid, "SIGKILL");
        } catch (error: unknown) {
          // The verified process exited between the final check and signal.
        }
      }
      await rm(record.path, { force: true });
    }
    await rm(this.#registryRoot(sessionId), {
      recursive: true,
      force: true,
    });
  }

  public async execute(
    session: SessionRecord,
    lane: LaneRecord,
    code: string,
    timeoutMs: number,
    outputLimit = 256 * 1024,
  ): Promise<CellRecord> {
    if (code.length > 100_000) {
      throw new RlmError("WORKER_FAILED", "cell exceeds input bound");
    }
    const key = this.#key(session.id, lane.id);
    let worker = this.#workers.get(key);
    if (worker === undefined) {
      worker = new LaneWorker(
        this.#pythonExecutable,
        this.#workerScript,
        session,
        lane,
      );
      this.#workers.set(key, worker);
      try {
        await this.#registerWorker(key, session.id, lane.id, worker);
      } catch (error: unknown) {
        await worker.stop();
        this.#workers.delete(key);
        throw error;
      }
    }

    lane.executionCount += 1;
    const executionCount = lane.executionCount;
    try {
      const reply = await worker.execute(code, timeoutMs, outputLimit);
      return {
        executionCount,
        code,
        status: reply.status,
        stdout: reply.stdout,
        stderr: reply.stderr,
        result: reply.result,
        errorName: reply.error_name,
        errorMessage: reply.error_message,
        truncated: reply.truncated,
      };
    } catch (error: unknown) {
      if (error instanceof RlmError && error.category === "CELL_TIMEOUT") {
        await worker.stop();
        this.#workers.delete(key);
        await this.#unregisterWorker(key);
        return {
          executionCount,
          code,
          status: "timed_out",
          stdout: "",
          stderr: "",
          result: null,
          errorName: "CellTimeout",
          errorMessage: "Cell exceeded its wall-time limit",
          truncated: false,
        };
      }
      throw error;
    }
  }

  public async cleanupSession(sessionId: string): Promise<void> {
    const matching = [...this.#workers.entries()].filter(([key]) =>
      key.startsWith(`${sessionId}:`),
    );
    await Promise.all(matching.map(([, worker]) => worker.stop()));
    for (const [key] of matching) {
      this.#workers.delete(key);
      await this.#unregisterWorker(key);
    }
    await this.#reapRegisteredSession(sessionId);
  }

  public async cleanupAll(): Promise<void> {
    await Promise.all([...this.#workers.values()].map((worker) => worker.stop()));
    for (const key of this.#workers.keys()) {
      await this.#unregisterWorker(key);
    }
    this.#workers.clear();
  }

  public pidsForSession(sessionId: string): number[] {
    return [...this.#workers.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}:`))
      .flatMap(([, worker]) =>
        worker.process.pid === undefined ? [] : [worker.process.pid],
      );
  }
}
