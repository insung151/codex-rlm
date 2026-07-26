# ADR 0002: Cross-platform local worker lifecycle

- Status: Accepted
- Date: 2026-07-26

## Context

The first local-process backend registered Python workers with a Linux
`/proc/<pid>/stat` start-time value. That let another controller verify a PID
before signalling it, but made every worker start fail on macOS because
`/proc` is unavailable. The worker also relied on Linux `PR_SET_PDEATHSIG` for
abnormal owner-exit cleanup.

The backend remains explicitly non-hardened. This decision must not imply that
process separation or Python audit hooks form a production security boundary.
It must preserve one mutable worker per lane, avoid signalling an unverified
PID, keep credentials and capabilities out of persistent state, and clean up
workers after both normal and abnormal owner exit.

The supported local interpreter contract is CPython 3.11 or newer. Codex RLM
must discover `python3` from the trusted plugin process environment, or accept
an administrator-supplied `RLM_PYTHON_EXECUTABLE`. It must reject an
unavailable or older interpreter before creating an RLM session.

## Alternatives considered

1. Keep the Linux registry and document macOS as unsupported.
   Rejected because the requested compatibility failure is in the control
   plane rather than in an intentional product boundary.
2. Add macOS-specific PID creation-time inspection and continue signalling
   PIDs from a separate controller.
   Rejected because platform APIs and permissions vary, and a mistaken identity
   check can signal an unrelated reused PID.
3. Route every lane through one permanent global supervisor.
   Rejected because it broadens the implementation and failure domain and risks
   collapsing the required parallel lane boundary.
4. Register a worker-owned local control endpoint and add an in-worker owner
   watchdog.
   Selected because it avoids cross-controller PID signalling, works on Linux
   and macOS, and retains independent lane processes.

## Decision

Each local worker owns a Unix-domain control socket under the plugin data
directory. The process registry stores the schema version, RLM session ID, lane
ID, and socket path; it stores no capability, credential, or raw Codex session
identifier. The socket is created with owner-only permissions.

A controller that did not spawn a registered worker requests shutdown through
that socket. The worker validates the registered session and lane identity
before acknowledging and exiting. If the endpoint is missing, malformed, or
does not identify the expected lane, the controller removes only the stale
registry record. It never falls back to signalling the recorded PID.

The spawning controller still terminates its own child directly. The Python
worker also runs a daemon watchdog that exits if its parent PID changes. Linux
keeps `PR_SET_PDEATHSIG` as an additional defense; macOS uses the watchdog.

Before session creation, the control plane probes the selected interpreter and
requires CPython 3.11 or newer. The worker receives a minimal environment plus
the session/lane control identity. Model-authored Python cannot configure the
interpreter or the control endpoint.

## Security and compatibility consequences

- Cross-controller cleanup cannot accidentally signal a reused or unrelated
  PID.
- A same-user process can inspect or tamper with local plugin data. That is
  already outside the security claims of the non-hardened backend; the socket
  and registry are nevertheless owner-only and contain no reusable authority.
- Unix-domain socket path limits apply. The runtime uses a deliberately short
  control directory and randomized socket name in plugin data, and reports
  `BACKEND_UNAVAILABLE` only when that shortened path still cannot fit.
- macOS and Linux use the same registry and cleanup protocol. Windows remains
  unsupported by this local backend until a separate transport decision is
  made.
- Network, subprocess, filesystem, and environment restrictions remain
  defense-in-depth audit-hook behavior, not an OS sandbox.

## Verification evidence

- Unit tests reject an unavailable or pre-3.11 interpreter before session
  persistence.
- Integration tests run persistent Python cells and lifecycle cleanup on Linux
  and macOS.
- An abnormal-owner test kills the Node controller and verifies that the Python
  worker exits on both platforms.
- A separate-controller cleanup test proves the registry shutdown path and
  verifies that malformed registry state does not cause PID signalling.
- CI runs the supported Node versions with Python 3.11 on Ubuntu and macOS.
