# D7 compatibility diagnostic

The current executable slice tests the selected D7 fallback:
`PreToolUse` must rewrite an RLM MCP call, parent/subagent calls must be
correlatable, and a private one-time authorization record must be consumed
before the protected operation.

1. Call `rlm_diagnostic` from the parent.
2. Ask one native subagent to call the same tool.
3. Ask two native subagents to call it concurrently.
4. Confirm each result reports `authorization_consumed: true` and the expected
   role.
5. Inspect the redacted diagnostic summary produced by the repository test
   harness. Do not inspect or expose runtime-private key material.

`parent`, `subagent`, and `ambiguous` are diagnostic classifications, not
production authorization decisions. An ambiguous result must fail closed.
