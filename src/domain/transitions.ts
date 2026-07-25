import { RlmError } from "../errors.js";
import type {
  LaneRecord,
  LaneStatus,
  SessionRecord,
  SessionStatus,
} from "./types.js";

const sessionTransitions: Readonly<
  Record<SessionStatus, readonly SessionStatus[]>
> = {
  active: ["finalizing", "cancelling", "failed"],
  finalizing: ["completed", "failed"],
  completed: [],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  failed: [],
};

const laneTransitions: Readonly<Record<LaneStatus, readonly LaneStatus[]>> = {
  active: ["submitted", "no_findings", "cancelling", "failed"],
  submitted: [],
  no_findings: [],
  cancelling: ["cancelled", "failed"],
  cancelled: [],
  failed: [],
};

export function transitionSession(
  session: SessionRecord,
  next: SessionStatus,
): void {
  if (!sessionTransitions[session.status].includes(next)) {
    throw new RlmError("COMPLETION_BLOCKED", "invalid session transition");
  }
  session.status = next;
}

export function transitionLane(lane: LaneRecord, next: LaneStatus): void {
  if (!laneTransitions[lane.status].includes(next)) {
    throw new RlmError("LANE_NOT_ACTIVE", "invalid lane transition");
  }
  lane.status = next;
}
