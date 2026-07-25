# Codex RLM Implementation Handoff

Status: First slice implemented; future phases remain
Audience: Maintainers extending or hardening the implementation
Repository: project root
Implementation state: Local CLI first slice implemented and locally installed;
hardened backend, resume, package installation, remote search, and additional
surfaces remain

## 1. Start here

Read these documents in order:

1. [`AGENTS.md`](./AGENTS.md) — repository operating contract and invariants.
2. [`DESIGN.md`](./DESIGN.md) — approved D1–D22 product and architecture
   decisions.
3. This document — implementation order, proposed contracts, validation
   commands, and handoff context.
4. [`docs/compatibility-spike.md`](./docs/compatibility-spike.md) — the first
   technical risk to retire.

D7-C failed because rewritten MCP arguments are observable. ADR 0001 records
the selected plugin-private one-time authorization fallback. New work must
preserve that consume-before-execute contract and rerun the compatibility
matrix.

## 2. Product in one paragraph

Codex RLM is an additive Codex plugin. Invoking `$rlm` adds a persistent,
notebook-recorded research runtime while preserving ordinary Codex tools and
their existing sandbox/approval behavior. A bundled local stdio MCP server owns
RLM sessions, isolated parent/subagent lanes, Python workers, notebooks,
findings, and reports. Plugin hooks correlate native Codex lifecycle events
with RLM lanes, write short-lived one-time authorization records to a private
exchange, and inject only a non-secret session pseudonym into RLM MCP calls.
The runtime consumes each matching private record before execution. Every
subagent gets an independent kernel and notebook. Only the parent may finalize
the research session.

## 3. Product choices that must not be reopened casually

The complete table is in `DESIGN.md`. The implementation owner should treat
these as approved constraints:

- Codex CLI first.
- TypeScript control plane and separate Python worker.
- Local stdio MCP transport.
- Additive host-tool mode by default.
- Strict RLM-only mode is deferred.
- Native Codex subagents, one isolated RLM lane per subagent.
- Plugin-private short-lived one-time authorization records, selected by ADR
  0001 after Codex CLI 0.145.0 exposed rewritten MCP arguments in JSON events.
- Project-local reviewable artifacts and `PLUGIN_DATA` private runtime state.
- Network denied by default.
- User-approved session-scoped `%pip install`.
- Entire canonical project root readable but not writable by Python.
- Lane artifact directory is the only lane write location.
- Every material claim references persisted evidence.
- Subagent submits findings or an explicit `no_findings` result.
- Deterministic report structure plus parent-authored summary.
- Deterministic notebook assembly by lane creation order.
- Resume uses a fresh kernel and evidence replay.
- Artifacts persist until explicit cleanup.
- Sensitive-data detection/DLP is not promised; user bears responsibility.
- Personal local marketplace first, then internal team distribution.
- Product name `codex-rlm`, described as RLM-inspired rather than a
  paper-faithful recursive inference implementation.

## 4. What “additive” means

RLM activation must not change ordinary host-tool behavior:

```text
ordinary Bash/apply_patch/read/web/MCP/subagent call
    -> normal Codex sandbox, approval, and plugin policy

RLM MCP call
    -> PreToolUse hook
    -> inject signed short-lived authority
    -> MCP server validates session/lane/role/op/expiry
    -> execute or reject
```

The plugin does not globally deny Bash, Edit, Write, unrelated MCP tools, or
native delegation in the default profile. Tests must prove both sides:

1. unauthorized RLM calls fail before RLM side effects; and
2. non-RLM tool inputs and policy remain unchanged.

## 5. First implementation milestone

### Included

1. Minimal plugin manifest and `$rlm` skill.
2. Local stdio MCP server.
3. D7 compatibility spike and selected authority path.
4. Session and lane state machines.
5. One parent lane and at least one native-subagent lane.
6. Non-hardened local Python worker, visibly labelled.
7. Persistent state within a lane and isolation across lanes.
8. Per-lane notebook persistence.
9. Findings or `no_findings` submission.
10. Parent-only deterministic report completion.
11. Cancellation, timeout, and session-end cleanup.
12. Focused unit, integration, adversarial, and E2E tests.

### Excluded

- strict mode;
- resume;
- remote search;
- plugin UI;
- public marketplace publication;
- Codex App/IDE/Cloud compatibility;
- production-complete container hardening; and
- automatic secret scanning or DLP.

The session-scoped package-install path is approved. Implement it after the
minimal kernel and authority path are stable; do not let it block the first
single-lane E2E.

## 6. Recommended implementation phases

### Phase 0 — repository and toolchain

Create only the minimum files needed to run tests and a local stdio server.

Recommended baseline:

- Node.js 22 or newer;
- TypeScript with strict checking;
- one lockfile and reproducible install;
- Python 3.11 or newer for the worker protocol;
- no web framework;
- no database in the first slice; and
- no dynamic package download during plugin startup.

The exact package manager is a tactical choice. Prefer the tool with the best
local Codex plugin/MCP test support, document it in `README.md`, and keep one
lockfile. Do not mix npm, pnpm, and Bun artifacts.

Before adding an MCP SDK or notebook dependency, inspect current official types
and justify the dependency in the PR or commit narrative. A handwritten
notebook serializer is acceptable only if schema validity and display outputs
are thoroughly tested.

### Phase 1 — D7 compatibility spike

Implement the smallest disposable plugin/hook/MCP path that answers the
questions in `docs/compatibility-spike.md`.

Stop conditions:

- ADR 0001 selects a private one-time authorization exchange because rewritten
  MCP inputs are observable after injection.
- Continue testing parent/subagent correlation; deny rather than guess when a
  hook call cannot be mapped to exactly one lane.
- Do not build the domain model on an unverified identity assumption.

### Phase 2 — pure domain model

Implement state and authorization without launching Python.

Required modules:

```text
sessions/
  session-state
  lane-state
  transitions
  repository

security/
  authority
  signing
  authorization
  path-policy
```

Keep state transitions explicit and testable. Suggested states:

```text
RLM session:
  starting -> active -> finalizing -> completed
                    \-> cancelling -> cancelled
                    \-> failed

Lane:
  allocating -> active -> submitting -> submitted
                         \-> no_findings
                         \-> cancelling -> cancelled
                         \-> failed
```

Terminal states are immutable. Repeated terminal operations must be idempotent
or return a stable conflict category.

### Phase 3 — persistence

Implement project artifacts and private runtime state before Python execution.

Project artifacts:

```text
<project>/.codex/rlm/<rlm-session-id>/
├── metadata.json
├── master.ipynb
├── report.md
├── events.jsonl
└── lanes/
    └── <lane-id>/
        ├── notebook.ipynb
        ├── findings.json
        └── artifacts/
```

Private runtime state:

```text
PLUGIN_DATA/
├── sessions/
├── locks/
├── leases/
└── process-registry/
```

Never persist raw capabilities. Writes to JSON/notebook snapshots use a
per-document queue, temporary file, atomic rename, and post-write parse
validation.

### Phase 4 — Python worker

The MCP control plane must never execute model-authored Python in its own
process.

Initial worker requirements:

- one worker/kernel per lane;
- persistent globals within a lane;
- no state shared across lanes;
- canonical project root exposed read-only;
- lane artifact directory as the only RLM-owned write target;
- minimized environment;
- no inherited credentials;
- network disabled where the selected local backend can enforce it;
- execution timeout and output cap;
- stdout, stderr, cancellation, truncation, image, and JSON display result
  classification; and
- worker ownership tracked for cleanup.

The local backend is non-hardened. Every status/report artifact that identifies
the backend must say so. Do not claim that path checks inside Python equal an
OS sandbox.

### Phase 5 — MCP tools

Add tools incrementally and keep handlers thin. The proposed first-slice
contracts are in section 8.

### Phase 6 — native subagent lanes

Use `SubagentStart` to allocate/bind a lane. Inject only non-secret lane context
into the subagent. Do not expose raw capability material.

Use `SubagentStop` to require:

- no running cell;
- notebook flush and validation;
- a valid findings or `no_findings` manifest; and
- a bounded continuation count.

The parent owns delegation and finalization. A subagent cannot create lanes or
complete/cancel the parent RLM session.

### Phase 7 — report and completion

The finalizer validates all required lanes, assembles notebooks
deterministically, writes a structured report, persists terminal metadata, and
reaps kernels before reporting completion.

### Phase 8 — package installation

Recognize `%pip install` as a request, not as ordinary code to execute
immediately.

Required flow:

```text
cell requests package
  -> worker reports install request without installing
  -> parent-only approval surface
  -> approved package installed into session-scoped environment
  -> package/version/provenance recorded
  -> kernel restarted or updated by explicit policy
  -> original cell may be retried
```

Subagents cannot independently approve installation. Installation must not
modify system Python, project dependencies, or another RLM session.

## 7. Proposed process boundaries

```text
Codex CLI
│
├── plugin skill and hooks
│
└── stdio MCP control plane (TypeScript)
    ├── session/lane state
    ├── authority validation
    ├── persistence
    ├── report finalization
    └── Python worker manager
         ├── worker: parent lane
         ├── worker: subagent lane A
         └── worker: subagent lane B
```

The MCP process may be shared for one plugin connection, but mutable kernel
state is never shared between lanes.

## 8. First-slice MCP contracts

These names are implemented public contracts. If changed, update the skill,
docs, tests, and hook matchers together.

### `rlm_start`

Parent-only logical operation. Starts one research session for the current
Codex session and canonical project root.

Input:

```json
{
  "objective": "string",
  "required_lane_count": 0
}
```

Output:

```json
{
  "rlm_session_id": "string",
  "status": "active",
  "backend": {
    "kind": "local-process",
    "hardened": false
  },
  "artifact_root": ".codex/rlm/<id>"
}
```

`rlm_start` must be idempotent for the same Codex session and idempotency key.
Do not return raw authority.

### `rlm_status`

Input:

```json
{}
```

Output includes bounded session state, caller role, visible lanes, running cell
count, findings state, and backend hardening status. A subagent sees only its
own lane plus non-sensitive parent summary.

### `rlm_python`

Input before hook rewrite:

```json
{
  "code": "string",
  "timeout_ms": 120000
}
```

Hook-rewritten internal input includes a reserved authority envelope. The
public skill must not instruct the model to author that field.

Output:

```json
{
  "cell": 3,
  "status": "succeeded",
  "stdout": "bounded string",
  "stderr": "",
  "truncated": false,
  "display_artifacts": []
}
```

Persist the cell before returning success.

### `rlm_submit_findings`

Lane-only.

Input:

```json
{
  "claims": [
    {
      "claim": "string",
      "evidence": [
        {
          "kind": "cell",
          "cell": 3
        }
      ],
      "confidence": "high",
      "caveats": []
    }
  ],
  "no_findings": false,
  "no_findings_reason": null
}
```

Require either one or more claims or `no_findings: true` with a reason.
Evidence references must resolve inside the caller's lane.

### `rlm_complete`

Parent-only.

Input:

```json
{
  "summary": "string",
  "idempotency_key": "string"
}
```

Completion fails while required lanes are non-terminal, findings are invalid,
notebooks do not parse, or kernels cannot be brought to a known terminal state.

### `rlm_cancel`

Parent-only session cancellation. Lane cancellation may be a separate internal
operation in the first slice.

Input:

```json
{
  "reason": "string",
  "idempotency_key": "string"
}
```

Flush completed evidence, mark in-flight cells interrupted, reap workers, write
terminal metadata, and clear active RLM lifecycle state.

## 9. Authority envelope

The model-visible input does not contain authority. `PreToolUse` derives it
from trusted hook state and injects a reserved envelope into RLM MCP arguments.

Conceptual claims:

```json
{
  "codex_session_id": "opaque",
  "turn_id": "opaque",
  "rlm_session_id": "opaque",
  "lane_id": "opaque",
  "role": "parent|subagent",
  "op": "rlm_python",
  "issued_at": 0,
  "expires_at": 0,
  "nonce": "opaque"
}
```

The envelope is signed with key material stored only in `PLUGIN_DATA`.

Server validation order:

1. envelope present;
2. signature valid;
3. not expired;
4. nonce acceptable under replay policy;
5. Codex and RLM sessions active and associated;
6. lane active and associated;
7. role permits operation; and
8. requested resource belongs to lane.

Failure returns stable authorization categories without echoing the envelope.

## 10. Findings and report rules

Evidence kinds in the first slice:

- `cell`: a persisted lane notebook cell;
- `artifact`: a persisted file under the caller's lane artifact directory; and
- optionally `codex_tool_observation`: bounded provenance mirrored from an
  ordinary Codex tool.

Only persisted evidence is canonical. Ordinary subagent prose is not evidence.

Report structure:

```text
title and session metadata
backend and hardening status
objective
method
findings with evidence references
caveats
lane summaries
notebook provenance
parent-authored summary
```

The parent-authored summary may interpret evidence but may not remove failed,
cancelled, or truncated cells from the record.

## 11. Error categories

Prefer stable machine-readable categories:

```text
AUTHORITY_MISSING
AUTHORITY_INVALID
AUTHORITY_EXPIRED
ROLE_FORBIDDEN
SESSION_NOT_ACTIVE
LANE_NOT_ACTIVE
LANE_BUSY
CELL_TIMEOUT
CELL_CANCELLED
OUTPUT_TRUNCATED
PATH_OUTSIDE_ROOT
PATH_SYMLINK_ESCAPE
FINDINGS_INVALID
EVIDENCE_NOT_FOUND
COMPLETION_BLOCKED
PERSISTENCE_FAILED
WORKER_FAILED
BACKEND_UNAVAILABLE
```

Do not expose internal stack traces to the model by default. Preserve them in a
bounded local diagnostic log when safe.

## 12. Verification order

Run focused verification after each phase:

1. type/schema checks;
2. pure unit tests;
3. hook fixture tests;
4. persistence and crash tests;
5. Python worker tests;
6. MCP integration tests;
7. native Codex compatibility spike;
8. single-lane E2E;
9. parallel-subagent E2E; and
10. adversarial authority/path/cleanup tests.

Minimum E2E proof before declaring the first slice usable:

- `$rlm` starts without changing an ordinary Codex tool call;
- parent Python state persists across two cells;
- two subagents receive different kernels;
- one subagent cannot use parent-only tools or sibling evidence;
- findings reference real persisted cells;
- final notebook assembly is deterministic;
- report references persisted evidence;
- cancellation and completion leave no owned Python process; and
- status/report clearly labels the local backend non-hardened.

## 13. Known risks and fallback rules

### D7 identity correlation and rewritten-input visibility

Risk: hook events may not expose stable enough identity across all required
subagent tool calls. Rewritten arguments are visible in Codex JSON events.

Selected fallback: operation-bound one-time records in the plugin-private
exchange, recorded in ADR 0001. Consume exactly one matching record atomically
before the protected side effect. Inject no bearer capability.

### Hook trust

Plugin hooks require trust. RLM activation must run a health check and refuse
RLM operations when required hooks are absent or untrusted. Ordinary Codex
tools remain unaffected because the product is additive.

### Local backend

The first Python backend cannot make a production sandbox claim. Treat path and
environment filtering as defense in depth, not containment.

### Whole-project reads and no DLP

The selected policy allows reading the whole canonical project and makes the
user responsible for sensitive data. Documentation must warn that model output,
notebooks, and reports can contain project secrets. Still remove inherited host
credentials from worker environments; that is process hygiene, not DLP.

### Package installation

Approved `%pip` introduces supply-chain and reproducibility risk. Keep installs
parent-approved, session-scoped, provenance-recorded, and unavailable during
the earliest kernel bootstrap.

## 14. Definition of done for the implementation owner

Do not report the first slice complete until:

- every included milestone item is implemented;
- validation gates have recorded evidence;
- tests pass;
- generated notebooks parse;
- authority is absent from logs, notebooks, reports, and model-visible output;
- normal Codex tool behavior is unchanged;
- parent/subagent lane isolation is demonstrated;
- all owned workers are cleaned up;
- development backend warnings are visible;
- README describes implemented rather than proposed behavior; and
- known gaps are explicitly listed.

## 15. Handoff stop conditions

Stop and update the design rather than improvising when:

- D7 hook correlation is impossible;
- stdio MCP cannot support the required lifecycle;
- a normal Codex tool must be globally modified for additive mode to work;
- parent and subagent calls cannot be distinguished safely;
- project-root read-only exposure cannot reject symlink escape;
- worker cleanup cannot be made reliable;
- package approval cannot be made parent-only; or
- implementation would require exposing raw long-lived capabilities.

These are architecture feedback, not ordinary bugs.
