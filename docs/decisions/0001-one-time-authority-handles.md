# ADR 0001: Keep one-time authority in a private exchange

Status: Accepted
Date: 2026-07-25
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
   Selected because model-visible data carries no executable authority.

## Decision

For every protected RLM call, the hook:

1. validates the Codex session and exact subagent identity;
2. stores a random-named record containing the session digest, agent digest,
   role, operation, canonical input digest, cwd, and expiry under
   `PLUGIN_DATA`;
3. writes that record with private directory/file permissions; and
4. injects only the non-secret Codex session digest as `_rlm_context.session`.

The MCP server finds exactly one record matching the injected session digest,
operation, and original input digest. It atomically moves the record to the
consumed directory before any protected side effect. Zero or multiple matches,
expiry, role incompatibility, or lifecycle disagreement fail closed. Stable
errors never expose private record contents.

Consumed and expired records are bounded and reaped. Random record identifiers
and agent bindings never enter Codex-visible tool input, notebooks, reports, or
structural logs.

The stdio launcher derives the installed plugin's private data directory from
the trusted installed cache layout and passes only that exact path to the
control plane. It refuses an unrecognized layout. Development tests provide an
explicit isolated data root.

## Security and compatibility consequences

- No bearer capability or authority handle is present in Codex events.
- Exact operation and canonical-input matching prevents authority substitution.
- Consume-before-execute ordering remains a security contract.
- Concurrent identical calls for the same session are deliberately ambiguous
  and fail closed rather than selecting a record.
- Current `agent_id` mapping must be verified for every supported Codex CLI
  release, including concurrent subagents and code-mode calls.
- Hook/runtime disagreement or an unrecognized plugin install layout denies
  RLM operations without changing ordinary host-tool behavior.

## Verification evidence

- live parent rewrite reaches the MCP server with only `_rlm_context`;
- one live subagent call shows matching redacted `agent_id` equality;
- parallel subagents resolve to distinct lanes or fail closed;
- first consumption succeeds and replay fails before side effects;
- expired, wrong-operation, wrong-role, and exact-input mismatch attempts fail;
- artifacts, notebooks, reports, and bounded logs contain no bearer authority
  or reusable capability; and
- ordinary non-RLM tool input remains unchanged.
