# Codex RLM tool contracts

Status: Implemented first-slice contracts
Schema version: 1

All authorized tools receive a reserved `_rlm_context` object from
`PreToolUse`. It
contains only non-secret digests of the Codex session and Codex `tool_use_id`;
users and models do not author it. The request digest selects one exact private
record so identical parallel calls do not collide; it grants no authority
without that record. The hook writes the exact operation/input/role
authorization to the plugin-private exchange, and the server atomically
consumes that record before protected behavior. Missing, expired, replayed,
forged, or role-incompatible authority returns a stable error category. The
MCP schema accepts an absent reserved field only so a failed or timed-out hook
returns
`AUTHORITY_MISSING`; no protected action executes without it.

`rlm_start.required_lane_count` is the number of required native subagent
lanes. It excludes the parent lane: parent plus two subagents uses `2`.

| Tool | Roles | Observable result |
| --- | --- | --- |
| `rlm_start` | parent | Active session ID, project-local artifact root, non-hardened backend status |
| `rlm_status` | parent, subagent | Bounded caller-visible session and lane state |
| `rlm_python` | parent, subagent | Persisted cell number, status, bounded outputs, truncation marker |
| `rlm_submit_findings` | parent, subagent | Terminal lane state after evidence validation |
| `rlm_complete` | parent | Validated master notebook/report after worker cleanup |
| `rlm_cancel` | parent | Durable cancelled state after worker cleanup |
| `rlm_diagnostic` | parent, subagent | Consumed private-authorization role/binding diagnostic |

Cell evidence refers to a successful execution count in the caller's lane
notebook. Artifact evidence is a relative path from the caller's lane
`ARTIFACT_ROOT`; it must not include `.codex/rlm/.../lanes/<lane>/artifacts`
or another artifact-root prefix. It resolves beneath that root after lexical,
canonical-path, and symlink checks. Claims without persisted evidence are
rejected with a stable category.

The first slice exposes the stable categories listed in `src/errors.ts`.
Internal stack traces, authority records, process IDs, private paths, and
inherited environment values are not returned by tools.

`AUTHORITY_MISSING` preserves its stable category while returning bounded
recovery guidance. A completely absent context directs the user to start a new
conversation, invoke `$codex-rlm:rlm`, and verify `/hooks` trust. A
session-only context identifies missing `PreToolUse.tool_use_id` compatibility.
Neither message exposes private authority material.
