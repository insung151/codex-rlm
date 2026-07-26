import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RlmError } from "../errors.js";
import type { ConsumedAuthority } from "../security/authority.js";
import { SessionRepository } from "../domain/session-repository.js";
import { transitionLane, transitionSession } from "../domain/transitions.js";
import type {
  FindingClaim,
  FindingsManifest,
  LaneRecord,
  SessionRecord,
} from "../domain/types.js";
import { WorkerManager } from "../kernels/worker-manager.js";
import {
  appendCell,
  assembleMaster,
  readNotebook,
} from "../notebooks/notebook.js";
import {
  appendBoundedJsonLine,
  atomicWriteJson,
  atomicWriteText,
} from "../persistence/atomic.js";
import {
  resolveExistingPath,
} from "../security/path-policy.js";

function requireRole(
  authority: ConsumedAuthority,
  expected: "parent" | "subagent",
): void {
  if (authority.role !== expected) {
    throw new RlmError("ROLE_FORBIDDEN");
  }
}

function laneNotebook(session: SessionRecord, lane: LaneRecord): string {
  return join(session.artifactRoot, "lanes", lane.id, "notebook.ipynb");
}

export class RlmController {
  readonly #sessions: SessionRepository;
  readonly #workers: WorkerManager;
  readonly #ownedSessionRoles = new Map<string, Set<"parent" | "subagent">>();
  readonly #ownedLaneIds = new Map<string, Set<string>>();

  public constructor(pluginData: string, pluginRoot: string) {
    this.#sessions = new SessionRepository(pluginData);
    this.#workers = new WorkerManager(pluginData, pluginRoot);
  }

  async #event(
    session: SessionRecord,
    event: string,
    detail: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await appendBoundedJsonLine(join(session.artifactRoot, "events.jsonl"), {
      at: new Date().toISOString(),
      event,
      ...detail,
    });
  }

  #trackOwnership(
    sessionId: string,
    role: "parent" | "subagent",
    laneId: string,
  ): void {
    const roles = this.#ownedSessionRoles.get(sessionId) ?? new Set();
    roles.add(role);
    this.#ownedSessionRoles.set(sessionId, roles);
    const lanes = this.#ownedLaneIds.get(sessionId) ?? new Set();
    lanes.add(laneId);
    this.#ownedLaneIds.set(sessionId, lanes);
  }

  async #activeContext(authority: ConsumedAuthority): Promise<{
    readonly session: SessionRecord;
    readonly lane: LaneRecord;
  }> {
    const session = await this.#sessions.requireActive(
      authority.codexSessionDigest,
    );
    const lane = await this.#sessions.resolveLane(
      session,
      authority.role,
      authority.agentDigest,
    );
    if (lane.status !== "active") {
      throw new RlmError("LANE_NOT_ACTIVE");
    }
    this.#trackOwnership(session.id, authority.role, lane.id);
    return { session, lane };
  }

  public async start(
    authority: ConsumedAuthority,
    input: {
      readonly objective: string;
      readonly requiredLaneCount: number;
      readonly idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    requireRole(authority, "parent");
    this.#workers.assertAvailable();
    const session = await this.#sessions.create({
      codexSessionDigest: authority.codexSessionDigest,
      objective: input.objective,
      projectRoot: authority.cwd,
      requiredLaneCount: input.requiredLaneCount,
      idempotencyKey: input.idempotencyKey,
    });
    this.#trackOwnership(session.id, "parent", "parent");
    await this.#event(session, "session_started", {
      session_id: session.id,
      backend: session.backend.kind,
      hardened: session.backend.hardened,
    });
    return {
      rlm_session_id: session.id,
      status: session.status,
      backend: session.backend,
      artifact_root: `.codex/rlm/${session.id}`,
    };
  }

  public async status(
    authority: ConsumedAuthority,
  ): Promise<Record<string, unknown>> {
    const session = await this.#sessions.findByCodexSession(
      authority.codexSessionDigest,
    );
    if (session === null) {
      throw new RlmError("SESSION_NOT_ACTIVE");
    }
    const lane = await this.#sessions.resolveLane(
      session,
      authority.role,
      authority.agentDigest,
    );
    const visibleLanes =
      authority.role === "parent"
        ? session.lanes
        : session.lanes.filter(
            (candidate) =>
              candidate.role === "parent" || candidate.id === lane.id,
          );
    return {
      rlm_session_id: session.id,
      status: session.status,
      caller_role: authority.role,
      caller_lane: lane.id,
      backend: session.backend,
      lanes: visibleLanes.map((candidate) => ({
        id: candidate.id,
        role: candidate.role,
        status: candidate.status,
        execution_count: candidate.executionCount,
        running_cell: candidate.runningCell,
      })),
    };
  }

  public async python(
    authority: ConsumedAuthority,
    input: { readonly code: string; readonly timeoutMs: number },
  ): Promise<Record<string, unknown>> {
    const { session, lane } = await this.#activeContext(authority);
    if (lane.runningCell) {
      throw new RlmError("LANE_BUSY");
    }
    lane.runningCell = true;
    await this.#sessions.save(session, { laneIds: [lane.id] });
    let cell;
    try {
      cell = await this.#workers.execute(
        session,
        lane,
        input.code,
        input.timeoutMs,
      );
      await appendCell(laneNotebook(session, lane), lane, cell);
    } finally {
      lane.runningCell = false;
      await this.#sessions.save(session, { laneIds: [lane.id] });
    }
    await this.#event(session, "cell_finished", {
      lane_id: lane.id,
      cell: cell.executionCount,
      status: cell.status,
      truncated: cell.truncated,
    });
    return {
      cell: cell.executionCount,
      status: cell.status,
      stdout: cell.stdout,
      stderr: cell.stderr,
      result: cell.result,
      error_name: cell.errorName,
      error_message: cell.errorMessage,
      truncated: cell.truncated,
      display_artifacts: [],
    };
  }

  async #validateClaims(
    session: SessionRecord,
    lane: LaneRecord,
    claims: readonly FindingClaim[],
  ): Promise<void> {
    if (claims.length === 0) {
      return;
    }
    const notebook = await readNotebook(laneNotebook(session, lane));
    for (const claim of claims) {
      if (claim.claim.trim().length === 0 || claim.evidence.length === 0) {
        throw new RlmError("FINDINGS_INVALID");
      }
      for (const evidence of claim.evidence) {
        if (evidence.kind === "cell") {
          if (
            evidence.cell === undefined ||
            !notebook.cells.some(
              (cell) =>
                cell.execution_count === evidence.cell &&
                cell.metadata.rlm.status === "succeeded",
            )
          ) {
            throw new RlmError("EVIDENCE_NOT_FOUND");
          }
        } else {
          if (evidence.artifact === undefined) {
            throw new RlmError("FINDINGS_INVALID");
          }
          const root = join(
            session.artifactRoot,
            "lanes",
            lane.id,
            "artifacts",
          );
          await resolveExistingPath(root, evidence.artifact);
        }
      }
    }
  }

  public async submitFindings(
    authority: ConsumedAuthority,
    input: {
      readonly claims: readonly FindingClaim[];
      readonly noFindings: boolean;
      readonly noFindingsReason: string | null;
    },
  ): Promise<Record<string, unknown>> {
    const { session, lane } = await this.#activeContext(authority);
    if (lane.runningCell) {
      throw new RlmError("LANE_BUSY");
    }
    if (
      (input.claims.length === 0 && !input.noFindings) ||
      (input.claims.length > 0 && input.noFindings) ||
      (input.noFindings &&
        (input.noFindingsReason === null ||
          input.noFindingsReason.trim().length === 0))
    ) {
      throw new RlmError("FINDINGS_INVALID");
    }
    await this.#validateClaims(session, lane, input.claims);
    const manifest: FindingsManifest = {
      schemaVersion: 1,
      laneId: lane.id,
      claims: input.claims,
      noFindings: input.noFindings,
      noFindingsReason: input.noFindingsReason,
      submittedAt: new Date().toISOString(),
    };
    await atomicWriteJson(
      join(session.artifactRoot, "lanes", lane.id, "findings.json"),
      manifest,
    );
    transitionLane(lane, input.noFindings ? "no_findings" : "submitted");
    await this.#sessions.save(session, { laneIds: [lane.id] });
    await this.#event(session, "findings_submitted", {
      lane_id: lane.id,
      claim_count: input.claims.length,
      no_findings: input.noFindings,
    });
    return { lane_id: lane.id, status: lane.status };
  }

  async #loadFindings(
    session: SessionRecord,
    lane: LaneRecord,
  ): Promise<FindingsManifest | null> {
    if (lane.status !== "submitted" && lane.status !== "no_findings") {
      return null;
    }
    return import("../persistence/atomic.js").then(({ readJson }) =>
      readJson<FindingsManifest>(
        join(session.artifactRoot, "lanes", lane.id, "findings.json"),
      ),
    );
  }

  public async complete(
    authority: ConsumedAuthority,
    input: { readonly summary: string; readonly idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    requireRole(authority, "parent");
    const existing = await this.#sessions.findByCodexSession(
      authority.codexSessionDigest,
    );
    if (existing === null) {
      throw new RlmError("SESSION_NOT_ACTIVE");
    }
    if (existing.status === "completed") {
      if (existing.completionIdempotencyKey !== input.idempotencyKey) {
        throw new RlmError("COMPLETION_BLOCKED");
      }
      return {
        rlm_session_id: existing.id,
        status: existing.status,
        master_notebook: `.codex/rlm/${existing.id}/master.ipynb`,
        report: `.codex/rlm/${existing.id}/report.md`,
        backend: existing.backend,
      };
    }
    if (existing.status !== "active") {
      throw new RlmError("COMPLETION_BLOCKED");
    }
    const session = existing;
    const subagents = session.lanes.filter((lane) => lane.role === "subagent");
    if (
      subagents.length < session.requiredLaneCount ||
      subagents.some(
        (lane) =>
          lane.status !== "submitted" && lane.status !== "no_findings",
      ) ||
      session.lanes.some((lane) => lane.runningCell)
    ) {
      throw new RlmError("COMPLETION_BLOCKED");
    }

    const parentLane = session.lanes.find((lane) => lane.role === "parent");
    if (parentLane?.status === "active") {
      const parentManifest: FindingsManifest = {
        schemaVersion: 1,
        laneId: parentLane.id,
        claims: [],
        noFindings: true,
        noFindingsReason:
          "Parent finalized without a separate findings submission.",
        submittedAt: new Date().toISOString(),
      };
      await atomicWriteJson(
        join(
          session.artifactRoot,
          "lanes",
          parentLane.id,
          "findings.json",
        ),
        parentManifest,
      );
      transitionLane(parentLane, "no_findings");
    }

    session.completionIdempotencyKey = input.idempotencyKey;
    transitionSession(session, "finalizing");
    await this.#sessions.save(session, {
      session: true,
      laneIds: parentLane === undefined ? [] : [parentLane.id],
    });
    const laneData = await Promise.all(
      session.lanes.map(async (lane) => ({
        lane,
        notebook: await readNotebook(laneNotebook(session, lane)),
        findings: await this.#loadFindings(session, lane),
      })),
    );
    const master = assembleMaster(laneData);
    await atomicWriteJson(join(session.artifactRoot, "master.ipynb"), master);

    const reportLines = [
      `# Codex RLM Report`,
      "",
      `- Session: \`${session.id}\``,
      `- Backend: local-process (NON-HARDENED DEVELOPMENT BACKEND)`,
      `- Objective: ${session.objective}`,
      "",
      "## Findings",
      "",
    ];
    for (const { lane, findings } of laneData) {
      if (findings === null) {
        continue;
      }
      if (findings.noFindings) {
        reportLines.push(
          `- ${lane.id}: No findings — ${findings.noFindingsReason ?? ""}`,
        );
      }
      for (const claim of findings.claims) {
        const refs = claim.evidence
          .map((evidence) =>
            evidence.kind === "cell"
              ? `${lane.id}:cell-${String(evidence.cell)}`
              : `${lane.id}:artifact-${evidence.artifact ?? ""}`,
          )
          .join(", ");
        reportLines.push(
          `- ${claim.claim} [evidence: ${refs}] (confidence: ${claim.confidence})`,
        );
      }
    }
    reportLines.push("", "## Parent summary", "", input.summary, "");
    await atomicWriteText(
      join(session.artifactRoot, "report.md"),
      reportLines.join("\n"),
    );

    await this.#workers.cleanupSession(session.id);
    transitionSession(session, "completed");
    await this.#sessions.save(session, { session: true });
    await this.#event(session, "session_completed", {
      master_cell_count: master.cells.length,
    });
    return {
      rlm_session_id: session.id,
      status: session.status,
      master_notebook: `.codex/rlm/${session.id}/master.ipynb`,
      report: `.codex/rlm/${session.id}/report.md`,
      backend: session.backend,
    };
  }

  public async cancel(
    authority: ConsumedAuthority,
    input: { readonly reason: string; readonly idempotencyKey: string },
  ): Promise<Record<string, unknown>> {
    requireRole(authority, "parent");
    const existing = await this.#sessions.findByCodexSession(
      authority.codexSessionDigest,
    );
    if (existing === null) {
      throw new RlmError("SESSION_NOT_ACTIVE");
    }
    if (existing.status === "cancelled") {
      if (existing.cancellationIdempotencyKey !== input.idempotencyKey) {
        throw new RlmError("COMPLETION_BLOCKED");
      }
      return { rlm_session_id: existing.id, status: existing.status };
    }
    if (existing.status !== "active") {
      throw new RlmError("COMPLETION_BLOCKED");
    }
    const session = existing;
    session.cancellationIdempotencyKey = input.idempotencyKey;
    transitionSession(session, "cancelling");
    for (const lane of session.lanes) {
      if (lane.status === "active") {
        transitionLane(lane, "cancelling");
        transitionLane(lane, "cancelled");
      }
      lane.runningCell = false;
    }
    await this.#sessions.save(session, {
      session: true,
      laneIds: session.lanes.map((lane) => lane.id),
    });
    await this.#workers.cleanupSession(session.id);
    transitionSession(session, "cancelled");
    await this.#sessions.save(session, { session: true });
    await this.#event(session, "session_cancelled", {
      reason_length: input.reason.length,
    });
    return { rlm_session_id: session.id, status: session.status };
  }

  public async cleanupAll(): Promise<void> {
    const ownedSessions = (
      await Promise.all(
        [...this.#ownedSessionRoles.keys()].map(async (sessionId) => {
          try {
            return await this.#sessions.get(sessionId);
          } catch (error: unknown) {
            return null;
          }
        }),
      )
    ).filter((session): session is SessionRecord => session !== null);
    for (const session of ownedSessions) {
      const roles = this.#ownedSessionRoles.get(session.id);
      if (roles?.has("parent") === true && session.status === "active") {
        transitionSession(session, "cancelling");
        for (const lane of session.lanes) {
          if (lane.status === "active") {
            transitionLane(lane, "cancelling");
          }
          lane.runningCell = false;
        }
        await this.#sessions.save(session, {
          session: true,
          laneIds: session.lanes.map((lane) => lane.id),
        });
      } else if (roles?.has("parent") !== true) {
        const ownedLaneIds = this.#ownedLaneIds.get(session.id) ?? new Set();
        for (const lane of session.lanes) {
          if (ownedLaneIds.has(lane.id) && lane.status === "active") {
            transitionLane(lane, "cancelling");
            transitionLane(lane, "cancelled");
            lane.runningCell = false;
            await this.#sessions.save(session, { laneIds: [lane.id] });
          }
        }
      }
    }
    await this.#workers.cleanupAll();
    for (const session of ownedSessions) {
      const roles = this.#ownedSessionRoles.get(session.id);
      if (roles?.has("parent") === true && session.status === "cancelling") {
        for (const lane of session.lanes) {
          if (lane.status === "cancelling") {
            transitionLane(lane, "cancelled");
          }
        }
        transitionSession(session, "cancelled");
        await this.#sessions.save(session, {
          session: true,
          laneIds: session.lanes.map((lane) => lane.id),
        });
        await this.#event(session, "session_cancelled", {
          reason: "mcp_shutdown",
        });
      } else if (
        roles?.has("parent") === true &&
        session.status === "finalizing"
      ) {
        transitionSession(session, "failed");
        await this.#sessions.save(session, { session: true });
      }
    }
  }

  public pidsForSession(sessionId: string): number[] {
    return this.#workers.pidsForSession(sessionId);
  }
}
