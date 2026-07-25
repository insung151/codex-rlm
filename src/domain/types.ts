export type Role = "parent" | "subagent";
export type SessionStatus =
  | "active"
  | "finalizing"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";
export type LaneStatus =
  | "active"
  | "submitted"
  | "no_findings"
  | "cancelling"
  | "cancelled"
  | "failed";

export interface BackendStatus {
  readonly kind: "local-process";
  readonly hardened: false;
  readonly warning: string;
}

export interface LaneRecord {
  readonly id: string;
  readonly role: Role;
  readonly agentDigest: string | null;
  readonly creationIndex: number;
  status: LaneStatus;
  executionCount: number;
  runningCell: boolean;
}

export interface SessionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly codexSessionDigest: string;
  readonly objective: string;
  readonly projectRoot: string;
  readonly artifactRoot: string;
  readonly requiredLaneCount: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly backend: BackendStatus;
  status: SessionStatus;
  completionIdempotencyKey: string | null;
  cancellationIdempotencyKey: string | null;
  lanes: LaneRecord[];
}

export interface EvidenceReference {
  readonly kind: "cell" | "artifact";
  readonly cell?: number;
  readonly artifact?: string;
}

export interface FindingClaim {
  readonly claim: string;
  readonly evidence: readonly EvidenceReference[];
  readonly confidence: "low" | "medium" | "high";
  readonly caveats: readonly string[];
}

export interface FindingsManifest {
  readonly schemaVersion: 1;
  readonly laneId: string;
  readonly claims: readonly FindingClaim[];
  readonly noFindings: boolean;
  readonly noFindingsReason: string | null;
  readonly submittedAt: string;
}

export interface CellRecord {
  readonly executionCount: number;
  readonly code: string;
  readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
  readonly stdout: string;
  readonly stderr: string;
  readonly result: string | null;
  readonly errorName: string | null;
  readonly errorMessage: string | null;
  readonly truncated: boolean;
}
