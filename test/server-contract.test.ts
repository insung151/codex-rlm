import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProductionServer } from "../src/server.js";

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
      message: "AUTHORITY_MISSING",
    });
  } finally {
    await client.close();
    await server.close();
  }
});
