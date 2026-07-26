# ADR 0001: Keep one-time authority in a private exchange

Status: Accepted, amended
Date: 2026-07-25; amended 2026-07-26
Supersedes: Design D7-C authority transport

## Context

The approved design preferred a signed authority envelope injected by
`PreToolUse`, provided the envelope remained hidden from model-visible output.
A live compatibility spike used Codex CLI 0.145.0 on Linux with the local
stdio plugin.

The hook successfully replaced the diagnostic MCP argument object. The
replacement then appeared in the CLI JSON `mcp_tool_call.arguments` event.
Rewritten fields can therefore be persisted in Codex event or transcript data
and must contain no bearer authority, even if it is short-lived or single-use.

The same run observed that subagent `PreToolUse` included an `agent_id`
matching `SubagentStart`, although the public hook field table does not
currently document that field for `PreToolUse`. This mapping remains a
release-specific compatibility gate, not a portable security assumption.

The MCP child process also did not inherit `PLUGIN_DATA`; only plugin hooks are
documented to receive it.

The alpha.2 multi-lane matrix then demonstrated a second compatibility
constraint. Two subagents may issue the same operation with identical input at
the same time. Matching private records only by session, operation, and input
made both legitimate calls ambiguous. Codex may also queue an authorized MCP
dispatch for more than the original 15-second record lifetime; one observed
parent cancellation reached the server after approximately 697 seconds.

## Alternatives

1. Inject a reusable signed envelope.
   Rejected because rewritten arguments are observable and persistable.
2. Inject a short-lived or one-time bearer handle.
   Rejected because it still places authority in Codex-visible data and makes
   safety depend on event ordering.
3. Rely on prompt instructions or a model-provided lane ID.
   Rejected because neither is authorization.
4. Keep an operation-bound one-time record in a plugin-private exchange and
   inject only a non-secret session pseudonym.
   Selected initially because model-visible data carries no executable
   authority, but insufficient for identical parallel calls.
5. Serialize all identical RLM calls.
   Rejected because it would weaken the approved parallel-lane architecture.
6. Add a hook-derived request pseudonym to select one exact private record.
   Selected because it disambiguates calls without conveying any authority
   beyond the already visible exact request.

## Decision

For every protected RLM call, the hook:

1. validates the Codex session and exact subagent identity;
2. stores a random-named record containing the session digest, agent digest,
   role, operation, canonical input digest, cwd, and expiry under
   `PLUGIN_DATA`;
3. writes that record with private directory/file permissions; and
4. derives a non-secret request pseudonym from Codex `tool_use_id`; and
5. injects the non-secret session and request pseudonyms as `_rlm_context`.

The MCP server finds exactly one record matching the injected session and
request pseudonyms, operation, and original input digest. The request
pseudonym is a selector, not standalone authority: no call succeeds unless an
exact private record also exists, and the record remains bound to the Codex
session, agent, role, operation, canonical input, cwd, and expiry. The server
atomically moves the record to the consumed directory before any protected
side effect. Missing or forged selectors, replay, expiry, role
incompatibility, or lifecycle disagreement fail closed. Stable errors never
expose private record contents.

Private records have a 15-minute dispatch window to cover bounded host queue
latency. This does not extend an executing operation or make a record reusable.
`SessionEnd` removes outstanding records, and each accepted record is consumed
once before execution. Missing `tool_use_id` denies the RLM call.

Consumed and expired records are bounded and reaped. Random record identifiers
and agent bindings never enter Codex-visible tool input, notebooks, reports, or
structural logs.

The stdio launcher derives the installed plugin's private data directory from
the trusted installed cache layout and passes only that exact path to the
control plane. It refuses an unrecognized layout. Development tests provide an
explicit isolated data root.

## Security and compatibility consequences

- No bearer capability or standalone authority handle is present in Codex
  events.
- Exact operation and canonical-input matching prevents authority substitution.
- Consume-before-execute ordering remains a security contract.
- Concurrent identical calls use distinct request pseudonyms and retain their
  server-side agent binding.
- A copied request pseudonym cannot widen authority; it can only race the exact
  one-time request already represented by the visible arguments.
- The longer dispatch window increases the time in which that exact request
  can be raced, so one-time atomic consumption and `SessionEnd` cleanup remain
  mandatory.
- Current `agent_id` mapping must be verified for every supported Codex CLI
  release. Stable `tool_use_id` presence is also a release gate.
- Hook/runtime disagreement or an unrecognized plugin install layout denies
  RLM operations without changing ordinary host-tool behavior.

## Verification evidence

- live parent rewrite reaches the MCP server with only non-secret session and
  request pseudonyms in `_rlm_context`;
- one live subagent call shows matching redacted `agent_id` equality;
- parallel identical subagent calls consume distinct private records and
  preserve their agent bindings;
- first consumption succeeds and replay fails before side effects;
- missing or forged request selectors, expiry, wrong-operation, wrong-role,
  and exact-input mismatch attempts fail;
- delayed dispatch succeeds before 15 minutes and fails after the boundary;
- artifacts, notebooks, reports, and bounded logs contain no bearer authority
  or reusable capability; and
- ordinary non-RLM tool input remains unchanged.
