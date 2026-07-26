import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProductionServer } from "../src/server.js";
import {
  AUTHORITY_HOOK_GUIDANCE,
  AUTHORITY_REQUEST_GUIDANCE,
} from "../src/errors.js";

test("installed plugin metadata invokes the qualified RLM skill", async () => {
  const manifest = JSON.parse(
    await readFile(".codex-plugin/plugin.json", "utf8"),
  ) as {
    readonly interface?: { readonly defaultPrompt?: readonly string[] };
  };
  assert.deepEqual(manifest.interface?.defaultPrompt, [
    "Use $codex-rlm:rlm to investigate this question with persisted evidence.",
  ]);

  const skill = await readFile("skills/rlm/SKILL.md", "utf8");
  const presentation = await readFile(
    "skills/rlm/agents/openai.yaml",
    "utf8",
  );
  assert.match(skill, /invokes \$codex-rlm:rlm/);
  assert.match(skill, /Do not treat \$codex-rlm as a skill alias/);
  assert.match(presentation, /Use \$codex-rlm:rlm/);
});

test("missing hook context returns AUTHORITY_MISSING before tool execution", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-server-"));
  const { server } = createProductionServer({
    ...process.env,
    PLUGIN_DATA: pluginData,
  });
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "rlm_status",
      arguments: {},
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      category: "AUTHORITY_MISSING",
      message: `AUTHORITY_MISSING: ${AUTHORITY_HOOK_GUIDANCE}`,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("legacy session-only hook context returns AUTHORITY_MISSING before tool execution", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-server-"));
  const { server } = createProductionServer({
    ...process.env,
    PLUGIN_DATA: pluginData,
  });
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "rlm_status",
      arguments: {
        _rlm_context: { session: "a".repeat(32) },
      },
    });
    assert.equal(result.isError, true);
    assert.deepEqual(result.structuredContent, {
      category: "AUTHORITY_MISSING",
      message: `AUTHORITY_MISSING: ${AUTHORITY_REQUEST_GUIDANCE}`,
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("rlm_start schema defines required_lane_count as subagents excluding parent", async () => {
  const pluginData = await mkdtemp(join(tmpdir(), "codex-rlm-server-"));
  const { server } = createProductionServer({
    ...process.env,
    PLUGIN_DATA: pluginData,
  });
  const client = new Client({ name: "contract-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    const start = listed.tools.find((tool) => tool.name === "rlm_start");
    assert.ok(start !== undefined);
    const schema = start.inputSchema as {
      readonly properties?: {
        readonly required_lane_count?: { readonly description?: string };
      };
    };
    assert.match(
      schema.properties?.required_lane_count?.description ?? "",
      /subagent lanes, excluding the parent lane/,
    );
  } finally {
    await client.close();
    await server.close();
  }
});
