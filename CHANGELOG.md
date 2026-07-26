# Changelog

All notable changes to Codex RLM are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0-alpha.4] - 2026-07-27

### Fixed

- Installed-plugin instructions now use the actual qualified skill invocation
  `$codex-rlm:rlm`; `$codex-rlm` is explicitly documented as unsupported.
- `AUTHORITY_MISSING` now returns bounded recovery guidance for missing hook
  context or missing `PreToolUse.tool_use_id` compatibility instead of only
  echoing the category.

### Changed

- Automation and prompts using the previously documented `$rlm` name must
  migrate to `$codex-rlm:rlm` for the Marketplace-installed plugin.

### Security

- Missing authority continues to fail before protected behavior, and recovery
  messages expose no session, request, capability, path, or private record.

## [0.1.0-alpha.3] - 2026-07-26

### Fixed

- Identical parallel subagent calls now consume distinct request-bound private
  authorization records instead of failing with `AUTHORITY_INVALID`.
- Parent cancellation and other already-authorized calls tolerate up to 15
  minutes of bounded Codex-to-MCP dispatch queue latency.
- `required_lane_count` now explicitly documents that it counts required
  native subagent lanes and excludes the parent lane.

### Security

- Request pseudonyms select an exact private record but do not replace
  server-side session, agent, role, operation, input, cwd, expiry, and one-time
  consumption checks.
- Missing, forged, replayed, and expired request selectors fail closed before
  protected behavior.

## [0.1.0-alpha.2] - 2026-07-26

### Added

- macOS support for the non-hardened local-process backend.
- Cross-platform worker cleanup through owner-only Unix control sockets and a
  parent-process watchdog.
- CPython 3.11+ discovery through `PATH`, with
  `RLM_PYTHON_EXECUTABLE` as an administrator override.
- Ubuntu and macOS CI coverage on Node.js 22 and 24.

### Fixed

- Missing hook rewrites now fail closed with `AUTHORITY_MISSING` instead of MCP
  input-validation errors.
- Missing or incorrectly rooted artifact evidence now returns
  `EVIDENCE_NOT_FOUND` instead of `INTERNAL_ERROR`.
- Structural hook logs rotate at a bounded size.

### Security

- Cross-controller cleanup no longer signals registry PIDs, avoiding PID-reuse
  hazards.
- The macOS backend remains a non-hardened developer preview; Python audit
  hooks are not an OS security boundary.

## [0.1.0-alpha.1] - 2026-07-26

### Added

- Initial evidence-backed RLM research workflow for Codex CLI.
- Lane-isolated persistent Python workers and deterministic notebooks.
- One-time, fail-closed RLM authority handles and lifecycle hooks.
- Structured findings, evidence gates, report assembly, and process cleanup.
- Standalone JavaScript runtime bundles for Marketplace installation.

### Security

- This developer preview uses a non-hardened local-process Python backend.
  Python audit hooks are defense in depth and are not an OS security boundary.

[0.1.0-alpha.4]: https://github.com/insung151/codex-rlm/releases/tag/v0.1.0-alpha.4
[0.1.0-alpha.3]: https://github.com/insung151/codex-rlm/releases/tag/v0.1.0-alpha.3
[0.1.0-alpha.2]: https://github.com/insung151/codex-rlm/releases/tag/v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/insung151/codex-rlm/releases/tag/v0.1.0-alpha.1
