---
name: rlm
description: Start an explicit Codex RLM evidence-first research workflow. Use when the user invokes $codex-rlm:rlm or explicitly asks to use Codex RLM for persistent Python research, isolated subagent lanes, notebooks, findings, or an evidence-backed report. Do not treat $codex-rlm as a skill alias.
---

# Codex RLM

Treat RLM as an opt-in research workflow. Preserve ordinary Codex tool
behavior and use RLM tools only for RLM-owned state and evidence.

The plugin-qualified invocation is `$codex-rlm:rlm`. `$codex-rlm` is not a
skill alias, and the unqualified `$rlm` name applies only to standalone local
skill authoring rather than this installed plugin.

## Start

Call `rlm_start` once with the user's research objective, the number of
required native subagent lanes (excluding the parent lane), and a fresh stable
idempotency key for this logical start. For a parent plus two subagents, set
`required_lane_count` to `2`.

State clearly that `backend.hardened` is `false`. The local-process backend is
for development and does not provide an OS sandbox.

## Research

- Call `rlm_python` for Python analysis that must persist as notebook evidence.
- Reuse variables across cells inside one lane.
- Use `PROJECT_ROOT` for project reads and `ARTIFACT_ROOT` for declared lane
  outputs.
- Treat failed, timed-out, cancelled, and truncated cells as part of the
  evidence record.
- Use ordinary Codex tools normally when useful. RLM is additive and does not
  change their sandbox or approval behavior.

For independent work, spawn native Codex subagents. Tell each subagent to use
its own RLM tools and call `rlm_submit_findings` before returning. Each
subagent gets a separate persistent kernel and notebook.

## Findings

Call `rlm_submit_findings` with either:

- one or more claims, each referencing successful cells or persisted lane
  artifacts by a path relative to that lane's `ARTIFACT_ROOT`; or
- `no_findings: true` with a non-empty reason.

Natural-language subagent output is advisory. Persisted findings and referenced
evidence are authoritative.

## Complete

Only the parent calls `rlm_complete`. Before completion:

1. wait for all required subagents;
2. confirm every subagent lane submitted findings or `no_findings`;
3. ensure no cell is running; and
4. provide a parent-authored summary and stable completion idempotency key.

Completion writes the deterministic master notebook and report, validates
them, and reaps session workers before returning success. Use `rlm_cancel` only
from the parent when the user requests cancellation or safe recovery requires
it.

## Authority discipline

- Never invent a capability or reserved authority field.
- Never author `_rlm_context`. The hook injects non-secret session and request
  pseudonyms; executable authority remains in the plugin-private exchange.
- If the hook does not inject `_rlm_context`, expect `AUTHORITY_MISSING` and
  stop. Start a new conversation, invoke `$codex-rlm:rlm`, and verify the
  bundled hook is trusted in `/hooks`. Never retry by authoring the reserved
  field.
- Keep normal Codex tools under their existing sandbox and approval behavior.
- Report a missing or failed hook as a compatibility failure rather than
  bypassing it.

Read [compatibility-spike.md](references/compatibility-spike.md) when running
the compatibility matrix or interpreting an authority failure.
