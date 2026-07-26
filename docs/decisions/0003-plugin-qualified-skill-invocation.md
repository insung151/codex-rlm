# ADR 0003: Use the plugin-qualified RLM skill invocation

Status: Accepted
Date: 2026-07-27

## Context

The first public previews documented `$rlm`, which is the skill's local
frontmatter name. Installed plugin components are namespaced by the plugin
name. A user reasonably tried `$codex-rlm`, but that string identifies neither
the installed skill nor a supported alias. Codex still exposed the plugin's
MCP tools, and an attempted direct `rlm_start` returned the opaque
`AUTHORITY_MISSING` category when the authority hook did not inject context.

Explicit activation, recovery guidance, the plugin manifest, the bundled
skill, and user documentation must name the same executable workflow.

## Alternatives

1. Continue documenting `$rlm`.
   Rejected because it describes standalone local skill authoring, not the
   installed plugin component.
2. Treat `$codex-rlm` as an alias.
   Rejected because it is not a skill name and Codex does not define that
   plugin-name-only string as a bundled skill invocation.
3. Add a second globally named standalone skill.
   Rejected because it would bypass plugin namespacing, create collision risk,
   and split one workflow across two installation mechanisms.
4. Use `$codex-rlm:rlm`.
   Selected because it is the installed plugin-qualified skill identity and
   remains unambiguous when other skills use the name `rlm`.

## Decision

All installed-plugin prompts, examples, runtime instructions, troubleshooting,
and validation use `$codex-rlm:rlm`. Documentation explicitly states that
`$codex-rlm` is not an alias. `$rlm` may describe only standalone local skill
authoring and is not the supported public Marketplace invocation.

`AUTHORITY_MISSING` remains a stable error category. Its bounded public message
now distinguishes:

- no injected hook context: start a new conversation, invoke
  `$codex-rlm:rlm`, and verify the bundled hook in `/hooks`; and
- session context without a request pseudonym: verify that the Codex
  `PreToolUse` event supplies `tool_use_id`.

The messages disclose no session digest, request pseudonym, private record,
capability, path, or internal runtime state.

## Security and compatibility consequences

- Invocation naming does not create or widen authority.
- Missing authority still fails before any protected side effect.
- Recovery guidance is safe for forged calls because it contains only public
  product instructions.
- Existing automation using `$rlm` must migrate to `$codex-rlm:rlm`.
- Every supported Codex release must still pass hook trust, `tool_use_id`, and
  `agent_id` compatibility gates.

## Verification evidence

- manifest, bundled skill metadata, runtime instructions, README, installation
  guide, user guide, design, and examples use the qualified name;
- `$codex-rlm` is documented as unsupported;
- absent context returns `AUTHORITY_MISSING` with hook recovery guidance;
- session-only context returns `AUTHORITY_MISSING` with `tool_use_id`
  compatibility guidance;
- missing `tool_use_id` is denied by the hook with the same bounded guidance;
  and
- ordinary non-RLM tool inputs remain unchanged.

## References

- <https://developers.openai.com/plugins/build/skills>
- <https://developers.openai.com/plugins/build/plugins>
