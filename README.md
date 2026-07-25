# Codex RLM

Codex RLM is an opt-in Codex CLI plugin for evidence-first research with
persistent, lane-isolated Python workers, reproducible notebooks, structured
findings, and deterministic Markdown reports.

The first implementation slice is usable on Codex CLI. It uses a visibly
non-hardened local-process Python backend for development. It does not yet
provide a production OS sandbox.

## Requirements

- Codex CLI 0.145.0 or a release that passes the compatibility matrix;
- Node.js 22 or newer and npm;
- Python 3.11 or newer at `/usr/bin/python3`; and
- Linux for the current parent-death process cleanup guarantee.

## Build and install locally

```bash
npm ci
npm run build
```

Use `$plugin-creator` in Codex to add this existing `codex-rlm` folder to the
personal local marketplace, then install it:

```bash
codex plugin add codex-rlm@personal
```

Codex runs an installed cache snapshot. Reinstall after local changes:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py .
codex plugin add codex-rlm@personal
```

Open `/hooks` once in Codex and review/trust the bundled hooks. For vetted
non-interactive automation only, Codex also supports
`--dangerously-bypass-hook-trust`.

## Use

For installation, prompt patterns, artifact inspection, cancellation, and
troubleshooting, see the [Korean user guide](./docs/user-guide.md).

Start a new Codex CLI conversation in the project and invoke:

```text
$rlm Investigate the CSV data, use two independent subagents, and produce an
evidence-backed report.
```

The workflow creates:

```text
<project>/.codex/rlm/<session-id>/
├── metadata.json
├── events.jsonl
├── master.ipynb
├── report.md
└── lanes/
    ├── parent/
    │   ├── notebook.ipynb
    │   ├── findings.json
    │   └── artifacts/
    └── lane-1/
        ├── notebook.ipynb
        ├── findings.json
        └── artifacts/
```

Capabilities, one-time authorization records, process records, and lifecycle
state stay under the plugin's private `PLUGIN_DATA` directory. Codex-visible
tool input contains only a non-secret session pseudonym; no bearer authority is
injected into or persisted by Codex events.

## Implemented behavior

- Explicit `$rlm` activation through a bundled skill.
- Additive host-tool behavior: only RLM MCP inputs are rewritten.
- Parent and native-subagent lanes with separate persistent Python processes.
- Cross-process session locking and lane-scoped state updates for native
  subagent MCP processes.
- Per-cell notebook persistence including failures, timeouts, and truncation.
- Findings validation against successful persisted cells or rooted artifacts.
- Parent-only completion and cancellation.
- Deterministic master ordering: parent, then subagent creation order.
- Cleanup on completion, cancellation, timeout, MCP shutdown, and Linux parent
  death, including workers owned by other lane MCP processes.
- Minimized worker environment without inherited host credentials.
- Stable bounded public errors and structural event logs.

## Security and current limitations

The `local-process` backend is **not hardened**. Python audit hooks deny normal
network, subprocess, `ctypes`, and out-of-artifact write paths, but these are
defense in depth inside the same host OS. They are not a container, VM,
seccomp policy, or read-only mount. Do not run hostile Python with production
secrets available on the host.

Not implemented yet:

- hardened container backend and production sandbox claim;
- resume/evidence replay;
- remote search or Python network access;
- user-approved session-scoped package installation;
- strict RLM-only host-tool mode;
- Codex App, IDE, or Cloud compatibility;
- plugin UI or public marketplace publication; and
- automatic secret detection/DLP.

Subagent `PreToolUse.agent_id` was observed in Codex CLI 0.145.0 but is not
listed in the current public field table for that event. Every supported Codex
release must rerun the parallel-agent matrix; missing or ambiguous identity
fails closed. See
[ADR 0001](./docs/decisions/0001-one-time-authority-handles.md).

An uncatchable control-plane `SIGKILL` reaps Linux workers through
`PR_SET_PDEATHSIG`, but may leave session metadata active until a future
recovery implementation reconciles it. Normal completion, cancellation,
timeout, `SessionEnd`, stdin close, `SIGINT`, and `SIGTERM` persist terminal
state and clean owned workers.

Project contents and recorded outputs can contain sensitive data. Review
notebooks and reports before sharing them.

## Validate

```bash
npm test
npm run typecheck
npm audit --omit=dev
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/rlm
```

The live CLI matrix is in
[docs/compatibility-spike.md](./docs/compatibility-spike.md). Architecture and
security invariants are in [DESIGN.md](./DESIGN.md). The final first-slice
evidence map is in [docs/validation.md](./docs/validation.md).

## License

No open-source license has been selected yet.
