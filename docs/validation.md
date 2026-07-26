# First-slice validation record

Status: Passed
Date: 2026-07-25
Source version: `0.1.0`
Validated surface: Codex CLI 0.145.0 on Linux

This record distinguishes the implemented local development slice from the
deferred hardened product. Generated sessions under `.codex/rlm/` are ignored
runtime evidence and are not source artifacts.

## Invocation-guidance release-candidate addendum

Release candidate: `0.1.0-alpha.4`
Candidate date: 2026-07-27

The candidate aligns installed-plugin prompts and documentation on
`$codex-rlm:rlm`. It explicitly rejects `$codex-rlm` as a supposed alias and
records the compatibility decision in ADR 0003. Contract tests verify bounded,
non-secret `AUTHORITY_MISSING` recovery guidance for a wholly absent hook
context and for a legacy session-only context without `tool_use_id`.

## Parallel-authority release-candidate addendum

Release candidate: `0.1.0-alpha.3`
Candidate date: 2026-07-26

The candidate binds each private authorization record to a non-secret request
pseudonym derived from Codex `tool_use_id`. Automated coverage proves that
identical parallel subagent calls consume their own agent-bound records, while
missing, forged, replayed, duplicate, input-mismatched, and expired attempts
fail closed. A 15-minute one-time dispatch window covers the observed
approximately 697-second host queue delay. `required_lane_count` is explicitly
defined as subagent lanes excluding the parent.

## macOS release-candidate addendum

Release candidate: `0.1.0-alpha.2`
Candidate date: 2026-07-26

The candidate replaces Linux `/proc` PID records with worker-owned Unix
control sockets and a parent watchdog, discovers CPython 3.11+ from the trusted
runtime environment, and adds macOS to the local-process developer-preview
surface. The design and residual same-user threat are recorded in
[ADR 0002](./decisions/0002-cross-platform-local-worker-lifecycle.md).

Local candidate verification covers 22 Node tests, including
abnormal owner exit, separate-controller cleanup, rejection of forged registry
state, stable missing-hook authority errors, and the reported three-claim
artifact submission shape. The
[Ubuntu and macOS CI matrix](https://github.com/insung151/codex-rlm/actions/runs/30194963080)
passed on Node.js 22 and 24 with CPython 3.11.

The first macOS candidate runs exposed the platform's shorter Unix socket path
limit and PID-reap timing differences. Those failures were treated as design
feedback: long plugin-data paths now use a validated owner-only short control
endpoint while the registry remains plugin-private, and cleanup verifies the
endpoint and owning child state instead of probing a registry PID.

No production sandbox claim is added. The macOS and Linux local-process
backends remain non-hardened, Python network access remains disabled, and a
physical macOS Codex hook-to-MCP run remains a post-install compatibility
check distinct from automated runtime integration tests.

## Completion evidence

| Contract | Current evidence |
| --- | --- |
| Local install and `$codex-rlm:rlm` | `codex plugin list` reports `codex-rlm@personal` installed and enabled at the version above. Multiple fresh `codex exec` conversations invoked the bundled skill and called the `rlm` MCP server. |
| Additive ordinary tools | Live `pwd` before and after the final RLM session returned the same project root. The hook unit test proves non-RLM input is not rewritten. |
| Independent persistent kernels | The final matrix ran two native subagents concurrently. `lane-1` persisted `v=600` then returned `606`; `lane-2` persisted `v=500` then returned `505`. |
| Notebook recording | Both final lanes contain two successful cells, and `master.ipynb` contains lane order `lane-1`, then `lane-2`, with source execution counts 1 and 2. Unit coverage also preserves failed, timed-out, and truncated cells. |
| Evidence-backed findings | Both final lane manifests cite their own successful cell 2. Invalid or missing cell/artifact references are rejected by the controller. |
| Parent-only terminal actions | Final lane A received `ROLE_FORBIDDEN` from a live subagent `rlm_complete` attempt. Integration tests deny both subagent completion and cancellation. |
| Deterministic finalization | The final parent observed exactly two submitted lanes, submitted explicit `no_findings`, and produced a validated master notebook and report. Assembly is parent first, then lane creation index. |
| Process cleanup | No `rlm_worker.py` or RLM MCP server remained after final completion. Tests cover completion, cancellation, timeout, normal MCP shutdown, Linux parent death, and parent cleanup of workers registered by separate lane controllers. |
| No authority or credential leakage | Codex-visible arguments contain only non-secret `_rlm_context` session/request pseudonyms; private one-time records are consumed and removed on `SessionEnd`. Artifact/private-log scans found no `_rlm_auth`, test credential marker, common private-key header, or bearer authority. Worker environment inheritance is minimized and host reads outside project/artifact/runtime roots are denied as defense in depth. |
| Automated checks | `npm run typecheck`, 15 Node tests, `npm audit --omit=dev`, plugin validation, and skill validation pass. |
| User documentation | `README.md` and `docs/user-guide.md` contain requirements, build/install/reinstall, prompt examples, `$codex-rlm:rlm` lifecycle, path use, artifact inspection, cancellation, troubleshooting, security label, and limitations. |

Final live outputs were validated under the ignored
`.codex/rlm/<session-id>/` directory and intentionally were not committed.

## Regression discovered during validation

A pre-release matrix exposed a cross-process lost-update bug: both subagent
artifacts existed, but an in-memory parent cache overwrote the authoritative
lane list. Completion correctly failed closed. Stdin shutdown made that
session durably `cancelled`, and no worker remained.

The fix removed the cache, added plugin-data session locks and lane-scoped
merges, and changed the process registry to one verified PID/start-time record
per lane. A three-controller concurrent regression test passes, and the final
live session above then passed the same two-agent matrix.

## Commands

```bash
npm run typecheck
npm test
npm audit --omit=dev
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/rlm
codex plugin list
```

Live runs used `--dangerously-bypass-hook-trust` only because they were vetted
non-interactive automation. They did not bypass Codex sandbox or approval
policy.

## Developer preview packaging

Release candidate: `0.1.0-alpha.1`
Packaging date: 2026-07-26

The Marketplace package includes standalone esbuild bundles for the MCP server
and lifecycle hook. Runtime startup therefore requires Node.js but does not
require an npm install or a writable plugin source directory. The build also
generates `THIRD_PARTY_NOTICES.md` from the dependencies actually present in
the bundles.

Current packaging checks:

- `npm test`: all 15 tests pass after building the standalone bundles.
- `npm audit` and `npm audit --omit=dev`: no known vulnerabilities.
- Plugin and skill schema validation pass.
- Both generated JavaScript entry points pass `node --check`.
- Repository and bundle scans found no credential patterns, private key
  headers, local home-directory paths, raw capabilities, or personal email
  addresses.
- `codex plugin marketplace add insung151/codex-plugins` cloned the public Git
  marketplace, and `codex plugin add codex-rlm@insung151` installed and enabled
  `0.1.0-alpha.1`.
- The public Marketplace snapshot, installed Codex cache, and source bundle
  produced the same server SHA-256. Both remote snapshot and installed cache
  contained no `node_modules`; the installed hook and MCP entry points started
  and exited successfully from the standalone bundles.

## Deferred work and residual risk

- The `local-process` Python backend is explicitly non-hardened. Audit hooks
  and path checks are defense in depth, not an OS-enforced sandbox.
- Hardened container isolation, CPU/memory quotas, read-only mounts, resume
  after control-plane restart, evidence replay, remote search, and
  user-approved session package installation are not implemented.
- Subagent `PreToolUse.agent_id` is an observed Codex CLI 0.145.0 compatibility
  dependency and must be revalidated for every supported release.
- Direct MCP calls passed. Nested code-mode authority correlation remains
  unverified and is not claimed as a supported surface.
- Codex App, IDE, Cloud, strict RLM-only mode, automatic DLP, plugin UI, and
  OpenAI universal directory publication remain out of scope.
- An uncatchable control-plane `SIGKILL` reaps Linux workers through
  `PR_SET_PDEATHSIG` but can leave active metadata for future restart
  reconciliation.
- Generated notebooks and reports can contain sensitive project data and must
  be reviewed before sharing.
