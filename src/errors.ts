export const errorCategories = [
  "AUTHORITY_MISSING",
  "AUTHORITY_INVALID",
  "AUTHORITY_EXPIRED",
  "ROLE_FORBIDDEN",
  "SESSION_NOT_ACTIVE",
  "LANE_NOT_ACTIVE",
  "LANE_BUSY",
  "CELL_TIMEOUT",
  "CELL_CANCELLED",
  "OUTPUT_TRUNCATED",
  "PATH_OUTSIDE_ROOT",
  "PATH_SYMLINK_ESCAPE",
  "FINDINGS_INVALID",
  "EVIDENCE_NOT_FOUND",
  "COMPLETION_BLOCKED",
  "PERSISTENCE_FAILED",
  "WORKER_FAILED",
  "BACKEND_UNAVAILABLE",
] as const;

export type ErrorCategory = (typeof errorCategories)[number];

export const AUTHORITY_HOOK_GUIDANCE =
  "Codex RLM hook context was not injected. Start a new Codex conversation, invoke $codex-rlm:rlm, and verify the codex-rlm hook is trusted in /hooks.";

export const AUTHORITY_REQUEST_GUIDANCE =
  "Codex RLM request context is incomplete. Use a Codex release whose PreToolUse event includes tool_use_id, then start a new conversation and invoke $codex-rlm:rlm.";

export class RlmError extends Error {
  public readonly category: ErrorCategory;

  public constructor(category: ErrorCategory, detail?: string) {
    super(detail === undefined ? category : `${category}: ${detail}`);
    this.name = "RlmError";
    this.category = category;
  }
}

export function publicError(error: unknown): {
  readonly category: ErrorCategory | "INTERNAL_ERROR";
  readonly message: string;
} {
  if (error instanceof RlmError) {
    return { category: error.category, message: error.message };
  }
  return { category: "INTERNAL_ERROR", message: "INTERNAL_ERROR" };
}
