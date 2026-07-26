# D7 Codex Hook Compatibility Spike

Status: D7-C failed; private one-time authorization fallback selected in ADR 0001
Decision under test: Private authority exchange plus hook-injected correlation

## Purpose

Prove that a Codex plugin can correlate parent and native-subagent lifecycle
events with subsequent RLM MCP calls and rewrite only RLM tool arguments,
without changing ordinary Codex tool behavior or revealing authority to the
model.

This spike answers a compatibility question. It is not the production
authorization implementation.

## Official behavior relied upon

Current Codex documentation states that:

- plugin-bundled skills use the plugin component namespace, making this
  installed skill `$codex-rlm:rlm`;
- plugin-bundled hooks are supported;
- common hook input includes `session_id`, `cwd`, and event name;
- turn-scoped events include `turn_id`;
- `SubagentStart` includes `agent_id`, `agent_type`, and `turn_id`;
- `PreToolUse` includes `turn_id`, `tool_name`, `tool_use_id`, and tool input;
- `PreToolUse` can deny supported tool calls; and
- `PreToolUse` can return `permissionDecision: "allow"` with `updatedInput`
  for MCP and other local tools.

References:

- <https://learn.chatgpt.com/docs/hooks>
- <https://developers.openai.com/plugins/build/plugins>

Verify current release behavior rather than relying only on documentation.

## Minimal spike components

```text
plugin manifest
hooks/hooks.json
hook executable
minimal stdio MCP server
one diagnostic RLM tool
one ordinary non-RLM tool call
one native subagent call
```

Do not add Python, notebooks, reports, package installation, or a database to
this spike.

## Observations to capture

For each event, record redacted structural data only:

```text
event name
session_id equality class
turn_id equality class
agent_id presence/equality class
tool_name
whether updatedInput reached the MCP server
```

Do not record prompts, raw tool arguments, credentials, or authority material.

## Test matrix

### Parent call

1. Start one Codex CLI session.
2. Confirm `/skills` lists `codex-rlm:rlm` and invoke that skill explicitly.
3. Invoke the diagnostic RLM MCP tool from the parent.
4. Confirm `PreToolUse` sees a stable `session_id` and `turn_id`.
5. Inject a harmless marker into `updatedInput`.
6. Confirm the MCP server receives the marker.

### Ordinary tool control

1. Invoke an ordinary Codex tool.
2. Confirm the hook either does not match or returns no modification.
3. Confirm its input and normal sandbox/approval behavior are unchanged.

### Subagent call

1. Spawn one native subagent.
2. Capture `SubagentStart` structural identifiers.
3. Invoke the diagnostic RLM MCP tool from that subagent.
4. Determine whether its `PreToolUse` event can be correlated reliably to the
   recorded subagent identity.
5. Confirm the parent and subagent mappings cannot collide.

### Parallel subagents

1. Spawn two native subagents concurrently.
2. Have both invoke the diagnostic RLM tool.
3. Confirm every call resolves to exactly one distinct lane mapping.
4. Repeat enough times to expose ordering assumptions.

### Code mode

1. Invoke the diagnostic RLM tool through a nested/code-mode path if available.
2. Confirm the same rewrite and correlation behavior.

### Resume and compaction

1. Resume the Codex session.
2. Trigger or simulate compaction if practical.
3. Confirm state is reconstructed or explicitly invalidated safely.

## Pass criteria for design C

All must hold:

- parent and subagent calls can be distinguished deterministically;
- concurrent subagents never map to the same lane accidentally;
- the hook can inject a field that reaches the RLM MCP server;
- injected data is not shown to the model;
- non-RLM tools are not modified;
- missing hook state can reject an RLM tool without affecting normal tools; and
- session end provides enough information for cleanup.

## Failure and fallback

If any identity criterion is unreliable:

1. save the redacted evidence;
2. write an ADR explaining the failed assumption;
3. select the approved fallback: short-lived one-time private authorization
   records plus non-secret injected session/request pseudonyms;
4. update `DESIGN.md`, hook/tool contracts, and threat model; and
5. re-run this matrix for the fallback.

Do not fall back to model-visible long-lived raw capabilities.

## Recorded live result

Codex CLI 0.145.0 on Linux produced these redacted observations:

- parent `PreToolUse` rewriting reached the MCP server input;
- the rewritten reserved object was present in the CLI JSON
  `mcp_tool_call.arguments` event;
- subagent `PreToolUse` carried an `agent_id` matching its preceding
  `SubagentStart` event in this release; and
- the bundled MCP process did not receive the hook-only `PLUGIN_DATA`
  environment variable.

The second observation fails the invisibility criterion even though input
rewriting itself works. ADR 0001 therefore keeps operation-bound one-time
authorization records in the plugin-private exchange and injects only
non-secret session and request pseudonyms. The request pseudonym derives from
`tool_use_id` and disambiguates identical parallel calls without replacing the
private record. Parallel-agent and code-mode correlation remain required
compatibility tests; missing identity must fail closed.

The final installed two-agent matrix passed on the local `0.1.0` build: both
separate MCP processes persisted distinct lanes, parent status observed both,
a subagent completion attempt returned `ROLE_FORBIDDEN`, and parent
finalization reaped every registered worker. Nested code-mode correlation
remains unverified.

## Spike deliverable

Produce:

- a small automated or reproducible test harness;
- redacted results for each matrix row;
- a clear pass/fail verdict;
- the exact Codex version and surface tested; and
- either confirmation of D7-C or an ADR selecting the fallback.

## Implemented harness

The Phase 0 harness consists of:

- `hooks/hooks.json` and `src/spike/hook.ts`;
- the bundled stdio MCP diagnostic in `src/server.ts`;
- redacted structural event storage under `PLUGIN_DATA/spike/`; and
- fixture tests in `test/spike.test.ts`.

Identifiers are HMAC-digested before structural events are written. Raw hook
input, prompts, tool arguments, capabilities, and environment values are not
recorded. This harness does not implement production authority.
