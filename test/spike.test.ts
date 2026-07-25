import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processHook } from "../src/spike/hook.js";
import {
  classifyTurn,
  digestIdentifier,
  readStructuralEvents,
  type StructuralEvent,
} from "../src/spike/provenance.js";
import { SessionRepository } from "../src/domain/session-repository.js";

function environment(): NodeJS.ProcessEnv {
  return {
    PLUGIN_DATA: mkdtempSync(join(tmpdir(), "codex-rlm-spike-")),
  };
}

test("PreToolUse rewrites only the replacement argument object", async () => {
  const env = environment();
  const result = await processHook(
    {
      session_id: "session-secret",
      turn_id: "turn-secret",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "mcp__rlm__rlm_diagnostic",
      tool_input: { label: "parent" },
    },
    env,
  );

  if (result === null) {
    assert.fail("expected PreToolUse output");
  }
  const specific = result.hookSpecificOutput as Record<string, unknown>;
  assert.equal(specific.permissionDecision, "allow");
  const updated = specific.updatedInput as Record<string, unknown>;
  assert.equal(updated.label, "parent");
  assert.equal(typeof updated._rlm_context, "object");
  assert.equal(updated._rlm_auth, undefined);

  const log = readFileSync(
    join(env.PLUGIN_DATA as string, "spike", "events.jsonl"),
    "utf8",
  );
  assert.doesNotMatch(log, /session-secret|turn-secret/);
});

test("SubagentStart and PreToolUse correlate by redacted session and turn", async () => {
  const env = environment();
  await processHook(
    {
      session_id: "session-a",
      turn_id: "turn-a",
      agent_id: "agent-a",
      hook_event_name: "SubagentStart",
    },
    env,
  );
  const result = await processHook(
    {
      session_id: "session-a",
      turn_id: "turn-a",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "mcp__rlm__rlm_diagnostic",
      tool_input: {},
    },
    env,
  );

  if (result === null) {
    assert.fail("expected PreToolUse output");
  }
  const specific = result.hookSpecificOutput as Record<string, unknown>;
  const updated = specific.updatedInput as Record<string, unknown>;
  const context = updated._rlm_context as Record<string, unknown>;
  assert.equal(typeof context.session, "string");
  assert.equal((context.session as string).length, 32);
  assert.equal(updated._rlm_auth, undefined);
});

test("two agents sharing one turn are classified ambiguous", () => {
  const events: StructuralEvent[] = [
    {
      source: "hook",
      event: "SubagentStart",
      session: "s",
      turn: "t",
      agent: "a",
      tool: null,
      correlation: null,
      rewriteReceived: null,
    },
    {
      source: "hook",
      event: "SubagentStart",
      session: "s",
      turn: "t",
      agent: "b",
      tool: null,
      correlation: null,
      rewriteReceived: null,
    },
  ];
  assert.equal(classifyTurn(events, "s", "t"), "ambiguous");
});

test("ordinary tool input is observed but never rewritten", async () => {
  const env = environment();
  const result = await processHook(
    {
      session_id: "session-a",
      turn_id: "turn-a",
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
    },
    env,
  );
  assert.equal(result, null);
});

test("active RLM subagent stop requires terminal findings", async () => {
  const env = environment();
  const pluginData = env.PLUGIN_DATA as string;
  const projectRoot = await mkdtemp(join(tmpdir(), "codex-rlm-hook-project-"));
  const sessionDigest = digestIdentifier(pluginData, "session-a");
  const agentDigest = digestIdentifier(pluginData, "agent-a");
  assert.ok(sessionDigest !== null);
  assert.ok(agentDigest !== null);
  const repository = new SessionRepository(pluginData);
  const session = await repository.create({
    codexSessionDigest: sessionDigest,
    objective: "hook stop gate",
    projectRoot,
    requiredLaneCount: 1,
    idempotencyKey: "hook-stop-0001",
  });
  await processHook(
    {
      session_id: "session-a",
      turn_id: "turn-a",
      agent_id: "agent-a",
      hook_event_name: "SubagentStart",
    },
    env,
  );
  const blocked = await processHook(
    {
      session_id: "session-a",
      turn_id: "turn-a",
      agent_id: "agent-a",
      hook_event_name: "SubagentStop",
    },
    env,
  );
  assert.equal(blocked?.continue, false);

  const lane = await repository.resolveLane(
    session,
    "subagent",
    agentDigest,
  );
  lane.status = "submitted";
  await repository.save(session);
  const allowed = await processHook(
    {
      session_id: "session-a",
      turn_id: "turn-a",
      agent_id: "agent-a",
      hook_event_name: "SubagentStop",
    },
    env,
  );
  assert.equal(allowed, null);
});
