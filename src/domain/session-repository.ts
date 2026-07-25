import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { RlmError } from "../errors.js";
import { atomicWriteJson, readJson } from "../persistence/atomic.js";
import { canonicalProjectRoot } from "../security/path-policy.js";
import { initializeLaneNotebook } from "../notebooks/notebook.js";
import type {
  BackendStatus,
  LaneRecord,
  SessionRecord,
} from "./types.js";

const backend: BackendStatus = {
  kind: "local-process",
  hardened: false,
  warning:
    "NON-HARDENED DEVELOPMENT BACKEND: Python path controls are defense in depth, not an OS sandbox.",
};

interface CodexSessionIndex {
  readonly schemaVersion: 1;
  readonly rlmSessionId: string;
}

export class SessionRepository {
  readonly #pluginData: string;

  public constructor(pluginData: string) {
    this.#pluginData = pluginData;
  }

  #sessionPath(sessionId: string): string {
    return join(this.#pluginData, "sessions", `${sessionId}.json`);
  }

  #indexPath(codexSessionDigest: string): string {
    return join(
      this.#pluginData,
      "codex-sessions",
      `${codexSessionDigest}.json`,
    );
  }

  async #withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const root = join(this.#pluginData, "locks");
    const path = join(root, `${name}.lock`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        await writeFile(
          join(path, "owner.json"),
          `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`,
          { encoding: "utf8", mode: 0o600, flag: "wx" },
        );
        break;
      } catch (error: unknown) {
        let stale = false;
        try {
          const owner = JSON.parse(
            await readFile(join(path, "owner.json"), "utf8"),
          ) as { readonly pid?: unknown; readonly acquiredAt?: unknown };
          if (
            typeof owner.pid === "number" &&
            typeof owner.acquiredAt === "number" &&
            Date.now() - owner.acquiredAt > 30_000
          ) {
            try {
              process.kill(owner.pid, 0);
            } catch (killError: unknown) {
              stale = true;
            }
          }
        } catch (readError: unknown) {
          // A creator can briefly hold the directory before owner.json exists.
        }
        if (stale) {
          await rm(path, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new RlmError("PERSISTENCE_FAILED", "session lock timeout");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    try {
      return await action();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }

  async #writeSession(session: SessionRecord): Promise<void> {
    await atomicWriteJson(this.#sessionPath(session.id), session);
    await atomicWriteJson(join(session.artifactRoot, "metadata.json"), {
      schemaVersion: session.schemaVersion,
      id: session.id,
      objective: session.objective,
      createdAt: session.createdAt,
      status: session.status,
      backend: session.backend,
      lanes: session.lanes.map((lane) => ({
        id: lane.id,
        role: lane.role,
        creationIndex: lane.creationIndex,
        status: lane.status,
        executionCount: lane.executionCount,
        runningCell: lane.runningCell,
      })),
    });
  }

  public async create(input: {
    readonly codexSessionDigest: string;
    readonly objective: string;
    readonly projectRoot: string;
    readonly requiredLaneCount: number;
    readonly idempotencyKey: string;
  }): Promise<SessionRecord> {
    return this.#withLock(
      `codex-${input.codexSessionDigest}`,
      async () => {
        const existing = await this.findByCodexSession(
          input.codexSessionDigest,
        );
        if (existing !== null) {
          if (
            existing.status === "active" &&
            existing.idempotencyKey === input.idempotencyKey
          ) {
            return existing;
          }
          if (existing.status === "active") {
            throw new RlmError(
              "SESSION_NOT_ACTIVE",
              "session already active",
            );
          }
        }

        const projectRoot = await canonicalProjectRoot(input.projectRoot);
        const sessionId = `rlm-${randomBytes(12).toString("hex")}`;
        const artifactRoot = join(projectRoot, ".codex", "rlm", sessionId);
        const parentLane: LaneRecord = {
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
          id: sessionId,
          codexSessionDigest: input.codexSessionDigest,
          objective: input.objective,
          projectRoot,
          artifactRoot,
          requiredLaneCount: input.requiredLaneCount,
          idempotencyKey: input.idempotencyKey,
          createdAt: new Date().toISOString(),
          backend,
          status: "active",
          completionIdempotencyKey: null,
          cancellationIdempotencyKey: null,
          lanes: [parentLane],
        };
        await mkdir(join(artifactRoot, "lanes", "parent", "artifacts"), {
          recursive: true,
          mode: 0o700,
        });
        await initializeLaneNotebook(artifactRoot, parentLane);
        await this.#writeSession(session);
        await atomicWriteJson(this.#indexPath(input.codexSessionDigest), {
          schemaVersion: 1,
          rlmSessionId: session.id,
        } satisfies CodexSessionIndex);
        return session;
      }
    );
  }

  public async findByCodexSession(
    codexSessionDigest: string,
  ): Promise<SessionRecord | null> {
    let index: CodexSessionIndex;
    try {
      index = await readJson<CodexSessionIndex>(
        this.#indexPath(codexSessionDigest),
      );
    } catch (error: unknown) {
      return null;
    }
    return this.get(index.rlmSessionId);
  }

  public async get(sessionId: string): Promise<SessionRecord> {
    return readJson<SessionRecord>(this.#sessionPath(sessionId));
  }

  public async save(
    session: SessionRecord,
    scope: {
      readonly session?: boolean;
      readonly laneIds?: readonly string[];
    } = { session: true, laneIds: session.lanes.map((lane) => lane.id) },
  ): Promise<void> {
    await this.#withLock(`session-${session.id}`, async () => {
      const latest = await this.get(session.id);
      const merged: SessionRecord = {
        ...latest,
        status: scope.session === true ? session.status : latest.status,
        completionIdempotencyKey:
          scope.session === true
            ? session.completionIdempotencyKey
            : latest.completionIdempotencyKey,
        cancellationIdempotencyKey:
          scope.session === true
            ? session.cancellationIdempotencyKey
            : latest.cancellationIdempotencyKey,
        lanes: [...latest.lanes],
      };
      for (const laneId of scope.laneIds ?? []) {
        const incomingLane = session.lanes.find((lane) => lane.id === laneId);
        if (incomingLane === undefined) {
          throw new RlmError("PERSISTENCE_FAILED");
        }
        const index = merged.lanes.findIndex((lane) => lane.id === laneId);
        if (index === -1) {
          merged.lanes.push(incomingLane);
        } else {
          merged.lanes[index] = incomingLane;
        }
      }
      await this.#writeSession(merged);
    });
  }

  public async requireActive(
    codexSessionDigest: string,
  ): Promise<SessionRecord> {
    const session = await this.findByCodexSession(codexSessionDigest);
    if (session === null || session.status !== "active") {
      throw new RlmError("SESSION_NOT_ACTIVE");
    }
    return session;
  }

  public async resolveLane(
    session: SessionRecord,
    role: "parent" | "subagent",
    agentDigest: string | null,
  ): Promise<LaneRecord> {
    if (role === "parent") {
      const lane = session.lanes.find((candidate) => candidate.role === "parent");
      if (lane === undefined) {
        throw new RlmError("LANE_NOT_ACTIVE");
      }
      return lane;
    }
    if (agentDigest === null) {
      throw new RlmError("AUTHORITY_INVALID");
    }
    return this.#withLock(`session-${session.id}`, async () => {
      const latest = await this.get(session.id);
      let lane = latest.lanes.find(
        (candidate) => candidate.agentDigest === agentDigest,
      );
      if (lane === undefined) {
        const creationIndex =
          Math.max(...latest.lanes.map((candidate) => candidate.creationIndex)) +
          1;
        lane = {
          id: `lane-${creationIndex}`,
          role: "subagent",
          agentDigest,
          creationIndex,
          status: "active",
          executionCount: 0,
          runningCell: false,
        };
        latest.lanes.push(lane);
        await mkdir(
          join(latest.artifactRoot, "lanes", lane.id, "artifacts"),
          {
            recursive: true,
            mode: 0o700,
          },
        );
        await initializeLaneNotebook(latest.artifactRoot, lane);
        await this.#writeSession(latest);
      }
      session.lanes = latest.lanes;
      session.status = latest.status;
      session.completionIdempotencyKey = latest.completionIdempotencyKey;
      session.cancellationIdempotencyKey = latest.cancellationIdempotencyKey;
      const resolved = session.lanes.find(
        (candidate) => candidate.agentDigest === agentDigest,
      );
      if (resolved === undefined) {
        throw new RlmError("LANE_NOT_ACTIVE");
      }
      return resolved;
    });
  }
}
