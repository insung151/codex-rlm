import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { createConnection } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
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
  readonly #ready: Promise<void>;

  public constructor(
    pythonExecutable: string,
    workerScript: string,
    session: SessionRecord,
    lane: LaneRecord,
    controlSocket: string,
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
        RLM_CONTROL_SOCKET: controlSocket,
        RLM_SESSION_ID: session.id,
        RLM_LANE_ID: lane.id,
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: false,
    });
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    this.#ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this.lines = createInterface({ input: this.process.stdout });
    this.lines.on("line", (line) => {
      let message: WorkerReply | { readonly type: "ready" };
      try {
        message = JSON.parse(line) as WorkerReply | { readonly type: "ready" };
      } catch (error: unknown) {
        this.failAll(new RlmError("WORKER_FAILED"));
        return;
      }
      if ("type" in message) {
        if (message.type === "ready") {
          resolveReady();
        }
        return;
      }
      const reply = message;
      const request = this.pending.get(reply.id);
      if (request !== undefined) {
        this.pending.delete(reply.id);
        request.resolve(reply);
      }
    });
    this.process.once("error", () => {
      rejectReady(new RlmError("WORKER_FAILED"));
    });
    this.process.once("exit", () => {
      rejectReady(new RlmError("WORKER_FAILED"));
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

  public async waitUntilReady(): Promise<void> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.#ready,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new RlmError("WORKER_FAILED", "worker startup timeout")),
            5_000,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
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
    await this.waitUntilReady();
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
  readonly #configuredPython: string | undefined;
  #pythonExecutable: string | undefined;
  readonly #workers = new Map<string, LaneWorker>();
  readonly #registryPaths = new Map<string, string>();
  readonly #controlSockets = new Map<string, string>();

  public constructor(
    pluginData: string,
    pluginRoot: string,
    pythonExecutable?: string,
  ) {
    this.#pluginData = pluginData;
    this.#workerScript = join(pluginRoot, "worker", "rlm_worker.py");
    this.#configuredPython =
      pythonExecutable ?? process.env.RLM_PYTHON_EXECUTABLE;
  }

  #key(sessionId: string, laneId: string): string {
    return `${sessionId}:${laneId}`;
  }

  #registryRoot(sessionId: string): string {
    return join(this.#pluginData, "process-registry", "workers", sessionId);
  }

  #controlRoot(): string {
    return join(this.#pluginData, "c");
  }

  public assertAvailable(): void {
    if (process.platform === "win32") {
      throw new RlmError(
        "BACKEND_UNAVAILABLE",
        "the local-process backend currently supports Linux and macOS",
      );
    }
    if (this.#pythonExecutable !== undefined) {
      return;
    }
    const candidate = this.#configuredPython ?? "python3";
    const probe = spawnSync(
      candidate,
      [
        "-I",
        "-c",
        "import json,platform,sys; print(json.dumps({'executable':sys.executable,'implementation':platform.python_implementation(),'version':list(sys.version_info[:3])}))",
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        },
      },
    );
    if (probe.error !== undefined || probe.status !== 0) {
      throw new RlmError(
        "BACKEND_UNAVAILABLE",
        "CPython 3.11 or newer was not found; set RLM_PYTHON_EXECUTABLE",
      );
    }
    try {
      const result = JSON.parse(probe.stdout) as {
        readonly executable?: unknown;
        readonly implementation?: unknown;
        readonly version?: unknown;
      };
      if (
        result.implementation !== "CPython" ||
        !Array.isArray(result.version) ||
        typeof result.version[0] !== "number" ||
        typeof result.version[1] !== "number" ||
        result.version[0] !== 3 ||
        result.version[1] < 11 ||
        typeof result.executable !== "string"
      ) {
        throw new Error("unsupported interpreter");
      }
      this.#pythonExecutable = result.executable;
    } catch (error: unknown) {
      throw new RlmError(
        "BACKEND_UNAVAILABLE",
        "the local-process backend requires CPython 3.11 or newer",
      );
    }
  }

  async #newControlSocket(): Promise<string> {
    const root = await realpath(
      await mkdir(this.#controlRoot(), {
        recursive: true,
        mode: 0o700,
      }).then(() => this.#controlRoot()),
    );
    const path = join(root, `${randomBytes(6).toString("hex")}.sock`);
    if (Buffer.byteLength(path) > 100) {
      throw new RlmError(
        "BACKEND_UNAVAILABLE",
        "plugin data path is too long for a Unix control socket",
      );
    }
    return path;
  }

  async #registerWorker(
    key: string,
    sessionId: string,
    laneId: string,
    controlSocket: string,
  ): Promise<void> {
    const root = this.#registryRoot(sessionId);
    await mkdir(root, {
      recursive: true,
      mode: 0o700,
    });
    const path = join(root, `${laneId}.json`);
    await atomicWriteJson(
      path,
      {
        schemaVersion: 2,
        sessionId,
        laneId,
        controlSocket,
      },
    );
    this.#registryPaths.set(key, path);
    this.#controlSockets.set(key, controlSocket);
  }

  async #unregisterWorker(key: string): Promise<void> {
    const path = this.#registryPaths.get(key);
    if (path !== undefined) {
      await rm(path, { force: true });
      this.#registryPaths.delete(key);
    }
    const controlSocket = this.#controlSockets.get(key);
    if (controlSocket !== undefined) {
      await rm(controlSocket, { force: true });
      this.#controlSockets.delete(key);
    }
  }

  async #registeredWorkers(
    sessionId: string,
  ): Promise<
    {
      readonly path: string;
      readonly laneId: string;
      readonly controlSocket: string;
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
              readonly laneId?: unknown;
              readonly controlSocket?: unknown;
              readonly schemaVersion?: unknown;
            };
            if (
              record.schemaVersion !== 2 ||
              record.sessionId !== sessionId ||
              typeof record.laneId !== "string" ||
              typeof record.controlSocket !== "string" ||
              !record.controlSocket.startsWith(`${this.#controlRoot()}/`)
            ) {
              throw new Error("invalid worker registry record");
            }
            return {
              path,
              laneId: record.laneId,
              controlSocket: record.controlSocket,
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
        readonly laneId: string;
        readonly controlSocket: string;
      } => record !== null,
    );
  }

  async #requestRegisteredStop(
    sessionId: string,
    laneId: string,
    controlSocket: string,
  ): Promise<"stopped" | "stale" | "failed"> {
    return new Promise<"stopped" | "stale" | "failed">((resolve) => {
      const connection = createConnection(controlSocket);
      let wire = "";
      let settled = false;
      const finish = (result: "stopped" | "stale" | "failed"): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        connection.destroy();
        resolve(result);
      };
      const timeout = setTimeout(() => finish("failed"), 1_000);
      connection.setEncoding("utf8");
      connection.once("connect", () => {
        connection.write(
          `${JSON.stringify({
            operation: "stop",
            session_id: sessionId,
            lane_id: laneId,
          })}\n`,
        );
      });
      connection.on("data", (chunk: string) => {
        wire += chunk;
        if (!wire.includes("\n")) {
          return;
        }
        try {
          const response = JSON.parse(wire.slice(0, wire.indexOf("\n"))) as {
            readonly ok?: unknown;
            readonly session_id?: unknown;
            readonly lane_id?: unknown;
          };
          const valid =
            response.ok === true &&
            response.session_id === sessionId &&
            response.lane_id === laneId;
          if (!valid) {
            finish("failed");
            return;
          }
          settled = true;
          clearTimeout(timeout);
          connection.destroy();
          void this.#waitForControlClosure(controlSocket).then((closed) =>
            resolve(closed ? "stopped" : "failed"),
          );
        } catch (error: unknown) {
          finish("failed");
        }
      });
      connection.once("error", (error: NodeJS.ErrnoException) => {
        finish(
          error.code === "ENOENT" || error.code === "ECONNREFUSED"
            ? "stale"
            : "failed",
        );
      });
      connection.once("end", () => finish("failed"));
    });
  }

  async #waitForControlClosure(controlSocket: string): Promise<boolean> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const closed = await new Promise<boolean>((resolve) => {
        const probe = createConnection(controlSocket);
        let settled = false;
        const finish = (result: boolean): void => {
          if (settled) {
            return;
          }
          settled = true;
          probe.destroy();
          resolve(result);
        };
        probe.once("connect", () => finish(false));
        probe.once("error", (error: NodeJS.ErrnoException) =>
          finish(error.code === "ENOENT" || error.code === "ECONNREFUSED"),
        );
      });
      if (closed) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  async #reapRegisteredSession(sessionId: string): Promise<void> {
    for (const record of await this.#registeredWorkers(sessionId)) {
      const result = await this.#requestRegisteredStop(
        sessionId,
        record.laneId,
        record.controlSocket,
      );
      if (result === "failed") {
        throw new RlmError(
          "WORKER_FAILED",
          "registered worker cleanup could not be verified",
        );
      }
      await rm(record.path, { force: true });
      await rm(record.controlSocket, { force: true });
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
    this.assertAvailable();
    const key = this.#key(session.id, lane.id);
    let worker = this.#workers.get(key);
    if (worker === undefined) {
      const controlSocket = await this.#newControlSocket();
      worker = new LaneWorker(
        this.#pythonExecutable as string,
        this.#workerScript,
        session,
        lane,
        controlSocket,
      );
      this.#workers.set(key, worker);
      try {
        await worker.waitUntilReady();
        await this.#registerWorker(
          key,
          session.id,
          lane.id,
          controlSocket,
        );
      } catch (error: unknown) {
        await worker.stop();
        await rm(controlSocket, { force: true });
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
