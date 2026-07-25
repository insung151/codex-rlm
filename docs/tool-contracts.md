# Codex RLM tool contracts

Status: Implemented first-slice contracts
Schema version: 1

All tools receive a reserved `_rlm_context` object from `PreToolUse`. It
contains only a non-secret digest of the Codex session; users and models do not
author it. The hook writes the exact operation/input/role authorization to the
plugin-private exchange, and the server atomically consumes that record before
protected behavior. Missing, expired, duplicate, or role-incompatible
authority returns a stable error category.

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
notebook. Artifact evidence resolves beneath the caller's lane artifact root
after canonical path and symlink checks. Claims without persisted evidence are
rejected.

The first slice exposes the stable categories listed in `src/errors.ts`.
Internal stack traces, authority records, process IDs, private paths, and
inherited environment values are not returned by tools.
