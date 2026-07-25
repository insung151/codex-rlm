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
