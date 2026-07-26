import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RlmError } from "../src/errors.js";
import {
  consumeAuthorization,
  discardAuthorizationsForSession,
  issueAuthorization,
  toolInputDigest,
  type AuthorityClock,
} from "../src/security/authority.js";

class FakeClock implements AuthorityClock {
  public value = 1_000;
  public now(): number {
    return this.value;
  }
}

test("private one-time authorization is consumed without exposing a bearer secret", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  await issueAuthorization(pluginData, {
    codexSessionDigest: "session",
    requestDigest: "request-a",
    agentDigest: null,
    role: "parent",
    operation: "rlm_status",
    inputDigest: toolInputDigest({}),
    cwd: "/project",
  });
  const files = await readdir(join(pluginData, "authority", "records"));
  assert.equal(files.length, 1);
  const recordText = await readFile(
    join(pluginData, "authority", "records", files[0] as string),
    "utf8",
  );
  assert.match(recordText, /"codexSessionDigest":"session"/);

  const authority = await consumeAuthorization(
    pluginData,
    "session",
    "request-a",
    "rlm_status",
    {},
  );
  assert.equal(authority.role, "parent");
  await assert.rejects(
    consumeAuthorization(pluginData, "session", "request-a", "rlm_status", {}),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});

test("session teardown discards only that session's private records", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  for (const codexSessionDigest of ["session-a", "session-b"]) {
    await issueAuthorization(pluginData, {
      codexSessionDigest,
      requestDigest: `request-${codexSessionDigest}`,
      agentDigest: null,
      role: "parent",
      operation: "rlm_status",
      inputDigest: toolInputDigest({}),
      cwd: "/project",
    });
  }
  await discardAuthorizationsForSession(pluginData, "session-a");
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session-a",
      "request-session-a",
      "rlm_status",
      {},
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
  assert.equal(
    (
      await consumeAuthorization(
        pluginData,
        "session-b",
        "request-session-b",
        "rlm_status",
        {},
      )
    ).codexSessionDigest,
    "session-b",
  );
});

test("expired and wrong-operation private authorizations fail before use", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  const clock = new FakeClock();
  await issueAuthorization(
    pluginData,
    {
      codexSessionDigest: "session",
      requestDigest: "request-expired",
      agentDigest: null,
      role: "parent",
      operation: "rlm_status",
      inputDigest: toolInputDigest({}),
      cwd: "/project",
    },
    clock,
    10,
  );
  clock.value = 1_011;
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session",
      "request-expired",
      "rlm_status",
      {},
      clock,
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_EXPIRED",
  );

  await issueAuthorization(pluginData, {
    codexSessionDigest: "session",
    requestDigest: "request-wrong-operation",
    agentDigest: null,
    role: "parent",
    operation: "rlm_python",
    inputDigest: toolInputDigest({ code: "1" }),
    cwd: "/project",
  });
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session",
      "request-wrong-operation",
      "rlm_complete",
      { code: "1" },
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});

test("private authorization is bound to the exact original tool input", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  const original = { code: "value = 1", timeout_ms: 1_000 };
  await issueAuthorization(pluginData, {
    codexSessionDigest: "session",
    requestDigest: "request-input",
    agentDigest: "agent",
    role: "subagent",
    operation: "rlm_python",
    inputDigest: toolInputDigest(original),
    cwd: "/project",
  });
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session",
      "request-input",
      "rlm_python",
      {
        code: "value = 2",
        timeout_ms: 1_000,
      },
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});

test("parallel identical calls consume only their request-bound records", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  const input = { code: "shared = 1" };
  for (const [requestDigest, agentDigest] of [
    ["request-agent-a", "agent-a"],
    ["request-agent-b", "agent-b"],
  ] as const) {
    await issueAuthorization(pluginData, {
      codexSessionDigest: "session",
      requestDigest,
      agentDigest,
      role: "subagent",
      operation: "rlm_python",
      inputDigest: toolInputDigest(input),
      cwd: "/project",
    });
  }

  const [first, second] = await Promise.all([
    consumeAuthorization(
      pluginData,
      "session",
      "request-agent-a",
      "rlm_python",
      input,
    ),
    consumeAuthorization(
      pluginData,
      "session",
      "request-agent-b",
      "rlm_python",
      input,
    ),
  ]);
  assert.equal(first.agentDigest, "agent-a");
  assert.equal(second.agentDigest, "agent-b");
});

test("missing, forged, and replayed request selectors fail closed", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  await issueAuthorization(pluginData, {
    codexSessionDigest: "session",
    requestDigest: "request-valid",
    agentDigest: null,
    role: "parent",
    operation: "rlm_status",
    inputDigest: toolInputDigest({}),
    cwd: "/project",
  });

  for (const requestDigest of [undefined, "request-forged"]) {
    await assert.rejects(
      consumeAuthorization(
        pluginData,
        "session",
        requestDigest,
        "rlm_status",
        {},
      ),
      (error: unknown) =>
        error instanceof RlmError &&
        error.category ===
          (requestDigest === undefined
            ? "AUTHORITY_MISSING"
            : "AUTHORITY_INVALID"),
    );
  }

  await consumeAuthorization(
    pluginData,
    "session",
    "request-valid",
    "rlm_status",
    {},
  );
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session",
      "request-valid",
      "rlm_status",
      {},
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});

test("duplicate private records for one request selector remain ambiguous", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  for (const agentDigest of ["agent-a", "agent-b"]) {
    await issueAuthorization(pluginData, {
      codexSessionDigest: "session",
      requestDigest: "request-duplicate",
      agentDigest,
      role: "subagent",
      operation: "rlm_status",
      inputDigest: toolInputDigest({}),
      cwd: "/project",
    });
  }
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session",
      "request-duplicate",
      "rlm_status",
      {},
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});

test("dispatch remains valid within 15 minutes and expires after the boundary", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  const clock = new FakeClock();
  await issueAuthorization(
    pluginData,
    {
      codexSessionDigest: "session",
      requestDigest: "request-delayed",
      agentDigest: null,
      role: "parent",
      operation: "rlm_cancel",
      inputDigest: toolInputDigest({ reason: "cleanup" }),
      cwd: "/project",
    },
    clock,
  );
  clock.value += 14 * 60_000 + 59_000;
  const authority = await consumeAuthorization(
    pluginData,
    "session",
    "request-delayed",
    "rlm_cancel",
    { reason: "cleanup" },
    clock,
  );
  assert.equal(authority.operation, "rlm_cancel");

  await issueAuthorization(
    pluginData,
    {
      codexSessionDigest: "session",
      requestDigest: "request-too-late",
      agentDigest: null,
      role: "parent",
      operation: "rlm_cancel",
      inputDigest: toolInputDigest({ reason: "cleanup" }),
      cwd: "/project",
    },
    clock,
  );
  clock.value += 15 * 60_000 + 1;
  await assert.rejects(
    consumeAuthorization(
      pluginData,
      "session",
      "request-too-late",
      "rlm_cancel",
      { reason: "cleanup" },
      clock,
    ),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_EXPIRED",
  );
});
