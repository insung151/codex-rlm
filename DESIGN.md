# Codex RLM Design

Status: Architecture approved; first implementation slice implemented
Scope: Approved implementation contract plus current implementation status
Target: Codex plugin with local persistent research runtime

Implementation snapshot (2026-07-25): the local Codex CLI plugin, private
one-time authority exchange, parent/subagent lanes, non-hardened persistent Python
workers, notebooks, findings, deterministic reports, and cleanup paths are
implemented and tested. The hardened container backend, resume, package
installation, remote search, strict mode, UI, and non-CLI surfaces remain
future work. README describes executable behavior.

## Recorded decisions

The following decisions were selected during design review:

| Decision | Selection | Consequence |
| --- | --- | --- |
| D1 — initial Codex surface | A: Codex CLI first | App, IDE, and Cloud compatibility follow after the local CLI lifecycle is verified. |
| D2 — implementation language | B: TypeScript control plane plus Python kernel worker | Plugin, hooks, MCP, state, and persistence use TypeScript; model-authored code runs only in a separate Python worker. |
| D3 — MCP transport | A: local stdio | The initial runtime has no listening port or remote authentication surface. |
| D4 — Python sandbox | D: non-hardened local development backend plus hardened container backend | Development remains fast while production security claims require the container backend. |
| D5 — host tool policy | D: additive mode by default | Normal Codex tools retain their existing sandbox and approval behavior. Hooks authenticate RLM MCP calls and observe lifecycle; they do not globally deny host tools. A strict RLM-only profile is a deferred feature. |
| D6 — subagent creation | A: Codex native subagents | The parent uses native delegation; `SubagentStart` allocates an isolated RLM lane. |
| D7 — lane capability delivery | Fallback: `PreToolUse` creates a private one-time authorization record and injects only a non-secret session pseudonym | Codex CLI 0.145.0 exposes rewritten MCP arguments in its JSON event stream, so no bearer authority is injected. The server consumes the exact operation/input/role-bound private record before execution. See ADR 0001. |
| D8 — artifact placement | C: reviewable artifacts project-local, private runtime state in `PLUGIN_DATA` | Notebooks, reports, findings, and public metadata live under `.codex/rlm`; capabilities, locks, leases, and process data do not. |
| D9 — network/search | B: network denied by default with an approval-gated domain allowlist | The first slice has no remote search. A later `rlm_web_search` tool records provenance; Python keeps direct network access disabled. |
| D10 — Python package policy | C: user-approved `%pip install` | Installation requires an explicit approval path, provenance recording, and a session-scoped environment. Subagents may not install packages independently. |
| D11 — input data scope | A: project root read-only | The sandbox may read the complete canonical project root but may not write to it. Symlink escapes remain blocked. |
| D12 — lane writes | A: lane artifact directory only | A lane cannot write to the project or sibling lanes; the finalizer alone writes master artifacts. |
| D13 — evidence gate | B: every material claim requires persisted evidence | Cell count is not a quality proxy. A future high-assurance profile may add an independent verifier lane. |
| D14 — subagent termination | C: findings or explicit `no_findings` manifest required | Empty research is represented explicitly without forcing an infinite continuation loop. |
| D15 — report synthesis | C: deterministic structure plus parent-authored summary | Persisted evidence and provenance remain canonical; the model supplies interpretation without replacing the record. |
| D16 — notebook assembly | B: parent first, then lane creation order, preserving lane-local cell order | Final notebooks are deterministic; wall-clock interleaving remains in the event log. |
| D17 — resume semantics | B: evidence replay in a fresh kernel | Live objects and pickle state are not restored or trusted. |
| D18 — kernel lifecycle | B: activity lease and idle timeout | Exact limits are configuration values; cancellation and expiry must reap all owned processes. |
| D19 — artifact retention | C: retain by default with explicit cleanup | No automatic deletion of research evidence; cleanup previews terminal sessions before removal. |
| D20 — sensitive-data policy | A: user responsibility | The product does not promise automatic secret detection or DLP. Documentation must warn that project files and recorded outputs can contain sensitive data. |
| D21 — distribution | A then B: personal local marketplace, then team-internal | Public directory submission is outside the initial roadmap. |
| D22 — project identity | A: `codex-rlm` | Describe it as an RLM-inspired persistent research/REPL mode, not a paper-faithful recursive inference implementation. |

These choices do not permit the MCP control plane or Python kernel to inherit
host credentials or an unfiltered host environment. Environment minimization,
capability redaction, and control-plane secret hygiene remain architectural
requirements rather than optional DLP features.

## 1. Problem

Codex can already inspect files, search, run commands, and delegate to
subagents. It does not, by default, provide an opt-in research mode with all of
the following properties:

1. a persistent Python REPL whose state survives across research steps;
2. automatic recording of executed code and observed outputs;
3. an additive runtime that preserves normal Codex tools while authenticating
   and isolating RLM-owned operations;
4. isolated parallel research lanes for native subagents;
5. evidence-backed finalization into a notebook and Markdown report; and
6. resumable, auditable research state.

Codex RLM supplies those properties without modifying Codex itself.

## 2. Goals

- Activate explicitly through `$rlm`.
- Keep the normal Codex experience unchanged while RLM is inactive.
- Execute research code in persistent, session-scoped Python kernels.
- Record every executed cell and its output in a valid Jupyter notebook.
- Preserve normal Codex tool behavior, sandboxing, and approval policy while
  RLM is active.
- Authenticate RLM MCP operations before execution and keep lane authority
  hidden from model context.
- Support parallel native subagents without shared mutable kernel state.
- Require structured evidence from subagents rather than relying only on prose.
- Make the parent agent the only authority that can finalize a research run.
- Recover useful artifacts after cancellation, failure, or process restart.
- Keep local data local unless an explicit network policy permits egress.

## 3. Non-goals

- Replacing Codex's agent loop or model runtime.
- Implementing recursive model calls in the original Recursive Language Model
  paper's strict sense.
- Providing an unrestricted general-purpose Python shell.
- Allowing subagents to mutate one another's RLM state.
- Treating hook instructions alone as a security sandbox.
- Hiding every built-in Codex tool from the model schema in the default
  additive profile.
- Replacing Codex's existing sandbox and approval policy for ordinary host
  tools in the default additive profile.
- Shipping the deferred strict RLM-only profile in the first implementation.

## 4. Architectural decision

Use one installable Codex plugin containing three cooperating layers:

```text
Codex RLM plugin
├── Skill layer
│   └── $rlm workflow and evidence discipline
├── Policy layer
│   └── Codex lifecycle hooks and active-session guard
└── Runtime layer
    └── bundled local MCP server
        ├── session controller
        ├── lane manager
        ├── Python kernel manager
        ├── notebook writer
        └── report finalizer
```

The skill describes desired behavior. Hooks authenticate RLM calls and manage
Codex lifecycle integration. The MCP server owns all mutable research state.
The Python sandbox provides the operating-system security boundary. Normal
Codex tools continue to use their existing sandbox and approval policy.

### Why MCP

MCP supplies typed tool schemas without shell parsing, a natural long-lived
server process for persistent kernels, and an exact tool namespace that hooks
can allow. A shell CLI would require command parsing, daemon discovery, quoting
rules, and executable-identity validation while still recreating a private
client/server protocol.

### Why hooks

A skill can direct the model but cannot authenticate a lane. `PreToolUse` hooks
write short-lived, operation-bound, one-time records to the plugin-private
exchange and inject only a non-secret session pseudonym into RLM MCP calls.
The runtime consumes the private record before execution.
`SubagentStart`, `SubagentStop`, and `SessionEnd` provide lifecycle points for
lane allocation, evidence validation, and cleanup.
The default profile does not use hooks to block ordinary Codex tools.

## 5. Runtime topology

```text
Codex parent session
│
├── RLM parent lane
│   ├── capability token P
│   ├── Python kernel P
│   └── notebook P
│
├── subagent lane A
│   ├── capability token A
│   ├── Python kernel A
│   ├── notebook A
│   └── findings A
│
├── subagent lane B
│   ├── capability token B
│   ├── Python kernel B
│   ├── notebook B
│   └── findings B
│
└── parent finalizer
    ├── validates lane manifests
    ├── assembles the master notebook
    └── writes report.md
```

A research session is not a Python kernel. It is a parent-owned container of
one or more independent lanes.

## 6. Identity and authority

Four identities remain distinct:

| Identity | Purpose |
| --- | --- |
| Codex `session_id` | Associates hook events with one Codex conversation |
| RLM session ID | Names one durable research run |
| Codex `agent_id` | Identifies a native subagent lifecycle |
| Lane capability | Authorizes operations on exactly one RLM lane |

The MCP server issues random, unguessable capability tokens. The model passes a
capability to lane-scoped tools. Capabilities encode no readable authority and
are stored hashed at rest.

Parent capabilities may create lanes and finalize the session. Subagent
capabilities may execute within one lane and submit findings, but may not read
another lane's private state, create further authorities, or finalize the
session.

## 7. Lifecycle

### 7.1 Activation

1. The user invokes `$rlm` with a research objective.
2. The skill calls `rlm_start`.
3. A hook records the Codex session as RLM-active.
4. The MCP server creates the RLM session, parent lane, kernel lease, notebook,
   and metadata.
5. Subsequent tool calls pass through the RLM tool guard.

RLM operations fail closed. If the hook cannot read or validate RLM state, RLM
MCP calls are denied until the user exits or repairs the mode. Ordinary Codex
tools remain governed by the host's existing sandbox and approval policy.

### 7.2 Subagent start

1. Codex emits `SubagentStart`.
2. The hook checks whether the parent Codex session is RLM-active.
3. The runtime allocates an isolated lane and capability for the `agent_id`.
4. The hook injects lane-specific developer context into the subagent.
5. The subagent uses only lane-scoped RLM tools.

Subagents do not share a Python kernel. Parallel work therefore remains
parallel and deterministic within each lane.

### 7.3 Subagent stop

Before accepting a subagent stop:

- no cell may still be running;
- notebook writes must be flushed and validated;
- the subagent must submit a structured findings manifest; and
- every material claim must reference one or more evidence cells or artifacts.

If recoverable requirements are missing, `SubagentStop` requests one additional
pass. A bounded retry counter prevents an infinite stop loop.

### 7.4 Completion

Only the parent capability can call `rlm_complete`.

Completion:

1. verifies that required lanes are terminal;
2. validates notebook and findings integrity;
3. checks any minimum-successful-run policy;
4. assembles a deterministic master notebook;
5. synthesizes `report.md`;
6. writes terminal metadata atomically;
7. disposes all kernels; and
8. clears the Codex RLM-active marker.

### 7.5 Cancellation and crash recovery

Cancellation flushes completed cells, marks running cells interrupted, writes
metadata, terminates kernels, and clears active policy state. On restart, the
runtime reconstructs sessions from metadata and notebooks; it does not claim
to restore in-memory Python objects.

Resume uses evidence replay in a fresh kernel. Required setup cells must be
re-executed explicitly.

## 8. Tool policy

### Default additive profile

RLM tools are added to the ordinary Codex tool surface. Bash, `apply_patch`,
native read and search, unrelated MCP tools, browser/computer tools, and native
subagent tools retain their normal Codex sandbox, approval, and plugin
permission behavior.

`PreToolUse` applies an RLM-specific policy only when the target is an RLM MCP
tool:

- inject short-lived signed lane authority;
- reject missing, stale, cross-session, or role-incompatible RLM state;
- prevent subagents from calling parent-only RLM operations; and
- preserve ordinary host-tool input unchanged.

Native tool observations may be mirrored into the bounded RLM event log for
provenance, but they are not automatically equivalent to notebook-cell
evidence. Reports distinguish RLM persisted evidence from external Codex tool
observations.

### Deferred strict profile

A future explicit strict profile may deny non-RLM tools while active. It will
require its own product surface, compatibility tests, hook trust checks, and
security documentation. Strict behavior must never activate implicitly or
change the default additive profile.

## 9. MCP tools

The first-slice tools are implemented. `rlm_create_lane`,
`rlm_list_findings`, and `rlm_draft_report` remain deferred; native
`SubagentStart` plus the first lane-scoped call creates a subagent lane.

### Parent tools

| Tool | Purpose |
| --- | --- |
| `rlm_start` | Start or resume a research session |
| `rlm_status` | Read session, lane, and completion state |
| `rlm_create_lane` | Allocate a bounded subagent research lane |
| `rlm_list_findings` | Read submitted lane manifests |
| `rlm_draft_report` | Generate a non-terminal report |
| `rlm_complete` | Validate, finalize, and dispose the session |
| `rlm_cancel` | Preserve artifacts and terminate the session |

### Lane tools

| Tool | Purpose |
| --- | --- |
| `rlm_python` | Execute one cell in the lane's persistent kernel |
| `rlm_read` | Read an allowed local file with bounded output |
| `rlm_search` | Search allowed local data or approved remote sources |
| `rlm_artifact_write` | Write only a declared lane artifact |
| `rlm_submit_findings` | Submit structured claims and evidence references |
| `rlm_lane_status` | Inspect the caller's lane |

All lane tools require a capability. Paths are resolved server-side against
configured roots; user-provided absolute paths never bypass root validation.

## 10. Findings contract

Subagents submit evidence through a structured manifest:

```json
{
  "claims": [
    {
      "claim": "Timeouts account for 72% of failed requests.",
      "evidence": [
        {
          "kind": "cell",
          "lane": "lane-a",
          "cell": 5
        }
      ],
      "confidence": "high",
      "caveats": [
        "The sample covers seven days."
      ]
    }
  ]
}
```

Natural-language subagent output is advisory. The parent finalizer treats the
manifest and referenced persisted evidence as authoritative.

## 11. Persistence

Use the plugin's writable data directory for global runtime bookkeeping and a
project-local directory for reviewable research artifacts.

```text
<project>/.codex/rlm/<rlm-session-id>/
├── metadata.json
├── master.ipynb
├── report.md
├── lanes/
│   ├── parent/
│   │   ├── notebook.ipynb
│   │   ├── findings.json
│   │   └── artifacts/
│   └── <lane-id>/
│       ├── notebook.ipynb
│       ├── findings.json
│       └── artifacts/
└── events.jsonl
```

Runtime locks, hashed capabilities, process IDs, and recovery leases belong in
`PLUGIN_DATA`, not in the repository.

Writes use a per-document queue, temporary file, atomic rename, and post-write
parse validation. `events.jsonl` is append-only and must not contain secrets,
raw capabilities, or unbounded tool output.

## 12. Notebook assembly

Each lane writes independently. The runtime never appends concurrent agents to
one shared notebook.

At finalization, the master notebook is assembled deterministically:

1. parent lane first;
2. subagent lanes ordered by lane creation index; and
3. cells kept in original lane execution order.

Every cell receives provenance metadata:

```json
{
  "rlm": {
    "lane_id": "lane-a",
    "agent_id": "agent-opaque-id",
    "source_execution_count": 5
  }
}
```

Wall-clock interleaving is retained in the event log but is not used as the
canonical notebook order.

## 13. Python sandbox

Hooks protect Codex tool execution. They do not sandbox Python code inside the
MCP server. The Python runtime requires an independent boundary.

Minimum controls:

- one subprocess or container per lane;
- read-only mounts for declared input roots;
- a writable mount only for the lane artifact directory;
- network disabled by default;
- subprocess spawning denied or tightly restricted;
- CPU, memory, wall-time, and output limits;
- package installation disabled by default;
- environment variable allowlist with secrets removed;
- kernel termination on lease expiry; and
- no host Docker socket or broad home-directory mount.

The first implementation may support a local-process development backend, but
it must be labelled non-hardened. The production security claim begins only
with an OS-enforced sandbox backend.

## 14. Threat model

| Threat | Primary mitigation |
| --- | --- |
| Normal Codex tool mutates the project | Existing Codex sandbox, approval policy, and user intent; RLM records that external observation where supported |
| Unauthorized RLM lane operation | Private one-time authorization plus consume-before-execute server-side role, operation, input, and session validation |
| New Codex tool bypasses assumptions | Unknown tools denied by default |
| Subagent accesses another lane | Capability-scoped authorization |
| Shared-kernel race | One kernel per lane |
| Capability disclosure | Random tokens, hash-at-rest, output redaction |
| Path traversal | Server-side canonical path and root checks |
| Python mutates project | Read-only mounts plus isolated artifact mount |
| Python exfiltrates data | Network disabled by default |
| Notebook corruption | Serialized atomic writes and parse validation |
| Subagent invents evidence | Findings require persisted references |
| Parent finalizes early | Terminal-lane and evidence validation gates |
| Hook disabled or untrusted | Visible health check; fail activation |
| Runtime crash leaves processes | Leases, heartbeat, and recovery reaper |

## 15. Failure semantics

- RLM authority uncertainty fails closed for RLM operations without changing
  normal host-tool policy.
- A failed Python cell is recorded and does not count as a successful run.
- Truncated output is marked in notebook metadata.
- A failed lane does not automatically fail independent lanes.
- Parent completion fails while required lanes are running or unsubmitted.
- Draft reports never mark the session complete.
- Cleanup failure is reported and leaves a recoverable non-terminal state.
- No component reports completion until durable artifacts validate.

## 16. Observability

Record bounded structural events:

- session and lane lifecycle;
- tool name, duration, and outcome;
- cell number and output classification;
- policy denials;
- notebook/report validation results; and
- kernel lease and cleanup events.

Do not record:

- raw capabilities;
- inherited environment variables;
- secrets;
- full large datasets; or
- unbounded stdout/stderr.

## 17. Verification strategy

### Unit

- capability authorization and expiry;
- canonical path enforcement;
- RLM authority injection and role decisions;
- notebook output conversion;
- serialized atomic writes;
- findings schema validation;
- completion gates; and
- deterministic notebook assembly.

### Integration

- plugin hook activates and deactivates per Codex session;
- ordinary Codex tools retain their configured sandbox and approval behavior;
- unauthorized RLM calls are denied before execution;
- parent and subagent lanes receive distinct kernels;
- variables persist within a lane and do not cross lanes;
- parallel cells do not corrupt notebooks;
- subagent stop requires submitted evidence;
- parent-only completion is enforced; and
- cancellation reaps every kernel.

### End-to-end

- one-agent CSV investigation;
- two parallel subagents analyzing independent dimensions;
- malicious subagent attempting parent-only RLM operations, path traversal, and
  another lane's capability;
- runtime restart followed by evidence replay;
- failed and truncated cells preserved in the notebook; and
- final report claims trace to persisted evidence.

## 18. Proposed repository structure

```text
codex-rlm/
├── .codex-plugin/
│   └── plugin.json
├── skills/
│   └── rlm/
│       ├── SKILL.md
│       └── references/
├── hooks/
│   ├── hooks.json
│   └── src/
├── server/
│   ├── src/
│   │   ├── tools/
│   │   ├── sessions/
│   │   ├── kernels/
│   │   ├── notebooks/
│   │   ├── reports/
│   │   └── security/
│   └── test/
├── docs/
│   ├── threat-model.md
│   └── tool-contracts.md
├── DESIGN.md
└── README.md
```

This is the approved target layout. Scaffolding begins only when implementation
is explicitly requested.

## 19. Implementation validation gates

Product and architecture decisions are complete. Implementation must still
prove these assumptions before depending on them:

1. `SubagentStart` identity can be correlated with subsequent subagent
   `PreToolUse` events; only a non-secret session pseudonym appears in tool
   arguments while executable authority remains plugin-private.
2. `PreToolUse` can rewrite RLM MCP arguments consistently in the target Codex
   CLI release, including code-mode nested calls.
3. The local stdio MCP lifecycle reliably reaps parent and subagent kernels on
   completion, cancellation, timeout, and host termination.
4. The non-hardened backend is visibly distinguished from the hardened
   container backend in status, artifacts, and reports.
5. Project-root read-only exposure rejects traversal and symlink escapes.
6. User-approved package installation is session-scoped, provenance-recorded,
   parent-authorized, and unavailable to subagents.
7. Additive mode leaves ordinary Codex tool input, sandboxing, and approval
   behavior unchanged.

Current evidence:

| Gate | Status |
| --- | --- |
| Parent/subagent correlation | Passed on Codex CLI 0.145.0 for parent, one subagent, and two parallel subagents; `agent_id` remains an undocumented dependency |
| `PreToolUse` rewrite | Passed for direct MCP calls; rewritten values are observable, so ADR 0001 keeps bearer authority private and injects only a session pseudonym; nested code-mode remains unverified |
| stdio lifecycle cleanup | Passed for completion, cancellation, timeout, normal shutdown, and Linux parent death |
| backend label | Passed in status, metadata, notebook, and report |
| project path controls | Traversal, symlink, write, delete, network, and subprocess regression tests pass for the non-hardened backend |
| package installation | Not implemented |
| additive ordinary tools | Unit input-preservation and live `pwd` before/after activation passed |

## 20. First implementation slice

Implemented:

1. plugin manifest and `$rlm` skill;
2. local MCP server with `start`, `python`, `status`, `submit_findings`,
   `complete`, and `cancel`;
3. one parent lane and multiple isolated native-subagent lanes, coordinated
   across their separate MCP processes with plugin-data locks;
4. plugin-bundled `PreToolUse`, `SubagentStart`, `SubagentStop`, and
   `SessionEnd` hooks for RLM authority and lifecycle;
5. notebook and Markdown report persistence;
6. a non-hardened local Python backend labelled for development;
7. lane-scoped worker registry records that let the parent reap workers owned
   by separate subagent MCP processes; and
8. adversarial tests proving RLM authorization and lane isolation.

Resume, remote search, strict mode, UI, and public marketplace publishing were
not added. User-approved package installation is selected but remains
unimplemented after the minimal kernel path.

## 21. Design review outcome

The architecture remains approved. The first slice above was implemented after
explicit request. Validation-gate failure changes the implementation approach,
not the accepted product intent; material fallback decisions are recorded
before continuing.
