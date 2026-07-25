# Codex RLM Agent Contract

Codex RLM is an opt-in research mode for Codex. It combines a workflow skill,
plugin-bundled lifecycle hooks, a local MCP runtime, isolated persistent Python
kernels, reproducible notebooks, and evidence-backed reports.

This file is the top-level operating contract for humans and coding agents
working in this repository. More specific `AGENTS.md` files may be added under
subdirectories later; when present, the closest file governs that subtree
without weakening this contract's security or evidence requirements.

## Current phase

The architecture is **approved** and the first local CLI implementation slice
is implemented. Read [`DESIGN.md`](./DESIGN.md) before making changes and
preserve its validation gates.

The hardened container backend, resume, package installation, remote search,
strict mode, UI, and non-CLI surfaces have not started. Extend them only on an
explicit request and keep README limited to executable behavior.

- Keep proposed behavior clearly distinguished from implemented behavior.
- Do not claim that a security boundary exists before an executable test proves
  it.
- Treat a failed compatibility assumption as a design feedback event; record
  the fallback decision before widening scope.
- Do not silently revisit approved product choices during implementation.

## Operating principles

- Execute clear, safe, reversible work without asking for confirmation.
- Ask only when a decision is destructive, externally side-effectful, or would
  prematurely resolve a materially branching design choice.
- Prefer the smallest change that establishes the requested behavior.
- Preserve user changes and unrelated work in a dirty worktree.
- Do not commit, publish, install globally, or register a marketplace entry
  unless explicitly asked.
- Do not add dependencies until an implementation language and dependency
  policy are approved.
- Verify every completion claim with current repository evidence.
- Treat security claims, lifecycle transitions, and persisted artifacts as
  externally observable contracts.

## Product boundaries

Codex RLM is:

- an installable Codex plugin;
- an explicit `$rlm` research workflow;
- a persistent, evidence-recording research runtime;
- an additive runtime that preserves ordinary Codex tool behavior; and
- a parent-coordinated system of isolated research lanes.

Codex RLM is not:

- a replacement for the Codex agent loop;
- a general unrestricted Python shell;
- a replacement for Codex's normal editing, sandbox, or approval behavior;
- a guarantee that unavailable tools disappear from the model's schema;
- a strict implementation of recursive model calls from the RLM paper; or
- secure merely because a prompt tells the model to follow rules.

Keep README, design documents, plugin metadata, skill wording, tool schemas, and
tests consistent with these boundaries.

## Architectural invariants

The following rules are non-negotiable unless the top-level design is
deliberately revised with corresponding threat-model and test updates.

### Responsibility separation

- The skill defines research behavior and evidence discipline.
- Plugin hooks authenticate RLM calls and integrate Codex lifecycle events.
- The MCP server owns mutable RLM session state.
- The Python sandbox enforces operating-system access boundaries.
- Notebooks and manifests preserve research evidence.
- The parent agent alone assembles and finalizes the research report.

Do not collapse these boundaries merely to reduce file count.

### Additive host tools and fail-closed RLM authority

- RLM is additive by default. Ordinary Codex tools retain their existing
  sandbox, approval, and plugin permission behavior while RLM is active.
- `PreToolUse` injects short-lived signed authority only into RLM MCP calls.
- Reject an RLM call before execution when authority is missing, stale,
  cross-session, role-incompatible, or ambiguous.
- Preserve non-RLM tool input and policy unchanged.
- Never rely on `PostToolUse` to contain side effects that already occurred;
  use it only for bounded provenance capture.
- A future strict RLM-only profile is a separate, explicit feature with its own
  tests and documentation. It must not become the default implicitly.

Every RLM authority change requires positive authorization tests and
adversarial denial tests.

### Parent and subagent isolation

- One RLM research session may contain many lanes.
- One lane owns exactly one mutable Python kernel at a time.
- Parent and subagent lanes never share live Python objects or mutable kernels.
- Subagents exchange results through persisted, immutable artifacts and
  structured findings manifests.
- Subagent capabilities cannot create authority, access sibling private state,
  or finalize the parent session.
- Only a parent capability may complete or cancel the whole RLM session.
- Parallel lanes must remain parallel; do not serialize all work through one
  global kernel.

### Capability security

- Use random, unguessable, least-authority capability tokens.
- Store capabilities hashed at rest.
- Never log, serialize to notebooks, include in reports, or echo raw
  capabilities to model-visible output after delivery.
- Bind authority server-side to the RLM session, lane, role, and expiry.
- Reject expired, unknown, cross-session, and role-incompatible capabilities.
- Do not treat model-provided lane IDs or agent IDs as authorization.

### Evidence and completion

- Every material report claim must reference persisted evidence.
- Natural-language subagent output is advisory; structured findings and the
  referenced cells or artifacts are authoritative.
- Failed, cancelled, and truncated cells remain visible and correctly marked.
- Draft reports never mark a session complete.
- Completion requires flushed and validated notebooks, terminal required lanes,
  satisfied evidence gates, durable terminal metadata, and kernel cleanup.
- Never report completion when cleanup or artifact validation is unresolved.

### Persistence

- Keep reviewable research artifacts project-local unless the design selects a
  different location.
- Keep locks, leases, process IDs, and capability material in the plugin data
  directory, not the repository.
- Use serialized writes, a temporary file, atomic rename, and post-write parse
  validation for notebook and metadata snapshots.
- Keep event logs bounded and free of secrets, capabilities, environment dumps,
  and unbounded outputs.
- Resume reconstructs evidence in a fresh kernel; do not claim to restore live
  in-memory Python state unless a future implementation actually checkpoints
  and verifies it.

### Python isolation

- Hooks constrain Codex tools; they do not sandbox Python.
- Production security claims require an OS-enforced Python sandbox.
- Input roots are mounted or exposed read-only.
- The lane artifact directory is the only default writable location.
- Network, subprocess creation, package installation, inherited environment
  variables, CPU, memory, wall time, and output size must be explicitly
  controlled.
- A local-process development backend must be labelled non-hardened in code,
  documentation, and test output.
- Never expose host credentials, a broad home-directory mount, or a container
  control socket to the kernel.

## Workflow

Use the smallest workflow that fits the task.

1. For design questions, inspect `DESIGN.md`, related decisions, and current
   official Codex extension documentation.
2. For implementation tasks, identify the affected architectural invariant and
   the test that proves it before editing.
3. For security-sensitive behavior, write or update the adversarial regression
   test before or alongside the implementation.
4. Make one bounded, reviewable change.
5. Run focused tests first, then the broader required checks.
6. Review the diff for secret leakage, authority widening, fail-open behavior,
   and documentation drift.
7. Report changed files, verification evidence, and remaining risks.

Do not mix unrelated architecture decisions, runtime implementation, packaging,
and marketplace publication into one change.

## Design decision protocol

Material decisions include:

- implementation language;
- MCP transport and process ownership;
- sandbox backend;
- artifact location;
- native versus MCP-owned read/search tools;
- subagent capability delivery;
- package installation policy;
- remote network policy;
- supported Codex surfaces; and
- evidence/completion thresholds.

When resolving one:

1. record the context and constraints;
2. list meaningful alternatives;
3. explain the selected option and rejected alternatives;
4. describe security and compatibility consequences;
5. define verification evidence; and
6. update `DESIGN.md` or add an ADR under `docs/decisions/`.

Use ADR filenames such as:

```text
docs/decisions/0001-runtime-language.md
docs/decisions/0002-python-sandbox.md
```

Do not bury a material design decision only in code or a commit message.

## Code quality

These rules apply once implementation begins:

- Prefer explicit domain types for sessions, lanes, capabilities, cells,
  findings, and lifecycle states.
- Avoid untyped dictionaries at trust boundaries; validate all external input.
- Keep MCP handlers thin and move authorization and state transitions into
  testable domain modules.
- Model lifecycle as explicit state transitions, not scattered booleans.
- Keep filesystem paths canonicalized and root-checked in one security module.
- Keep notebook serialization deterministic.
- Inject clocks, random-token sources, process launchers, and filesystem
  boundaries where deterministic tests need them.
- Prefer deletion and reuse over speculative abstractions.
- Do not introduce a generic plugin framework inside this plugin.
- Do not add compatibility aliases, fallbacks, or migrations without a
  demonstrated need and tests.

If TypeScript is selected:

- enable strict type checking;
- avoid `any`;
- use schemas for MCP and persisted-data boundaries; and
- keep Python worker protocol types shared or generated from one contract.

If Python is selected for any component:

- use type annotations at public and trust boundaries;
- isolate kernel-worker dependencies from control-plane dependencies; and
- never execute model code in the MCP control-plane process.

## Tool and protocol contracts

Tool names and schemas are public plugin contracts.

- Keep parent-only and lane-only tools visibly distinct in authorization logic.
- Require capability arguments for lane-scoped operations.
- Return bounded, structured results with stable error categories.
- Do not expose internal paths, process IDs, stack traces, or secret-bearing
  environment data by default.
- Make retries idempotent where operations create sessions, lanes, reports, or
  terminal state.
- Define cancellation and timeout behavior for every long-running tool.
- Version persisted schemas before compatibility requires migration.

Any tool-schema change must update:

- implementation;
- authorization tests;
- skill instructions;
- tool-contract documentation;
- compatibility tests; and
- examples that exercise the changed field.

## Testing requirements

Test observable contracts, not private implementation details.

### Required unit coverage

- capability issuance, authorization, expiry, and redaction;
- lifecycle state-transition validity;
- hook authority injection and RLM allow/deny decisions;
- canonical path and root enforcement;
- notebook output conversion and deterministic serialization;
- atomic persistence and recovery behavior;
- findings validation and evidence references;
- completion gates; and
- deterministic lane assembly.

### Required integration coverage

- RLM activation and deactivation are scoped to one Codex session;
- ordinary host tools retain their configured Codex behavior;
- unauthorized RLM calls are denied before execution;
- parent and subagent kernels are distinct;
- state persists within a lane and cannot cross lanes;
- parallel lane writes do not corrupt artifacts;
- subagent stop requires a valid findings manifest;
- subagents cannot finalize the parent session;
- cancellation and session end reap every owned process; and
- hook/runtime disagreement fails closed.

### Required adversarial coverage

- forged parent-only, cross-lane, expired, and unknown RLM tool attempts;
- path traversal and symlink escape;
- forged, leaked, expired, and cross-lane capabilities;
- oversized inputs and outputs;
- malicious notebook content;
- Python filesystem, network, subprocess, and environment escape attempts;
- interrupted atomic writes;
- MCP/runtime restart during active work; and
- premature or repeated completion.

### End-to-end baseline

Before calling the first implementation usable, demonstrate:

1. a single-lane CSV investigation;
2. two parallel subagents with isolated kernels;
3. evidence-backed findings from both lanes;
4. blocked unauthorized RLM attempts without altering ordinary host tools;
5. deterministic master notebook creation;
6. a report whose claims trace to persisted evidence; and
7. complete kernel and policy-state cleanup.

## Documentation requirements

- `README.md` describes implemented behavior only.
- `DESIGN.md` may describe proposed behavior but must label its status.
- Security documentation distinguishes tool gating from Python sandboxing.
- Examples never imply that a development backend is hardened.
- Document artifact paths, data retention, network behavior, and cleanup.
- Keep official Codex hook/plugin/MCP compatibility assumptions cited or linked
  where they materially affect the design.
- Add migration notes when a persisted schema or public tool contract changes.

## Dependency and supply-chain policy

Until the language decision is approved, add no runtime dependencies.

Afterward:

- prefer standard-library and already-selected platform capabilities;
- justify every runtime dependency at a trust boundary;
- pin or lock dependencies reproducibly;
- review packages that launch processes, parse notebooks, implement MCP, or
  enforce sandboxing with extra care;
- do not download executables at runtime without an explicit product decision;
  and
- keep optional scientific packages inside the isolated kernel environment,
  not the MCP control plane.

## Git and release discipline

- Do not commit unless explicitly requested.
- Keep commits focused on one decision or one verified behavior.
- Never commit runtime RLM sessions, raw notebooks containing private data,
  capabilities, credentials, kernel environments, or plugin data.
- Add appropriate ignore rules before generating local runtime artifacts.
- Do not publish to a marketplace or package registry without explicit
  authorization.
- Releases require changelog updates, full required verification, and a clean
  review of plugin permissions and data handling.

When commits are requested, use an intent-first message and include useful
trailers:

```text
Enforce lane isolation before enabling parallel research

Explain the constraint and why this implementation was selected.

Constraint: <external or architectural constraint>
Rejected: <alternative> | <reason>
Confidence: <low|medium|high>
Scope-risk: <narrow|moderate|broad>
Tested: <verification performed>
Not-tested: <known gaps>
```

## Files and generated data

The intended runtime paths are not yet active. Once implementation starts,
ignore at minimum:

```text
.codex/rlm/
*.capability
kernel-env/
```

Do not broadly ignore all notebooks; test fixtures and sanitized examples may
be legitimate source files. Ignore generated research paths specifically.

## Completion checklist

Before concluding any change, confirm:

- the requested outcome is complete;
- architecture invariants still hold;
- no authority was accidentally widened;
- unauthorized RLM actions fail before side effects;
- affected tests pass;
- persisted artifacts validate;
- documentation matches implemented behavior;
- no secrets or capabilities appear in the diff or logs;
- generated processes and temporary state are cleaned up; and
- remaining risks or unverified areas are stated explicitly.

If any item is false and a safe recovery path remains, continue working rather
than reporting completion.
