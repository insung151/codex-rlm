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
    "rlm_status",
    {},
  );
  assert.equal(authority.role, "parent");
  await assert.rejects(
    consumeAuthorization(pluginData, "session", "rlm_status", {}),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});

test("session teardown discards only that session's private records", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-auth-"));
  for (const codexSessionDigest of ["session-a", "session-b"]) {
    await issueAuthorization(pluginData, {
      codexSessionDigest,
      agentDigest: null,
      role: "parent",
      operation: "rlm_status",
      inputDigest: toolInputDigest({}),
      cwd: "/project",
    });
  }
  await discardAuthorizationsForSession(pluginData, "session-a");
  await assert.rejects(
    consumeAuthorization(pluginData, "session-a", "rlm_status", {}),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
  assert.equal(
    (
      await consumeAuthorization(
        pluginData,
        "session-b",
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
    consumeAuthorization(pluginData, "session", "rlm_status", {}, clock),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_EXPIRED",
  );

  await issueAuthorization(pluginData, {
    codexSessionDigest: "session",
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
    agentDigest: "agent",
    role: "subagent",
    operation: "rlm_python",
    inputDigest: toolInputDigest(original),
    cwd: "/project",
  });
  await assert.rejects(
    consumeAuthorization(pluginData, "session", "rlm_python", {
      code: "value = 2",
      timeout_ms: 1_000,
    }),
    (error: unknown) =>
      error instanceof RlmError && error.category === "AUTHORITY_INVALID",
  );
});
