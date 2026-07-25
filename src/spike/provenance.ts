import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export type CorrelationClass = "parent" | "subagent" | "ambiguous";

export interface StructuralEvent {
  readonly source: "hook" | "server";
  readonly event: string;
  readonly session: string | null;
  readonly turn: string | null;
  readonly agent: string | null;
  readonly tool: string | null;
  readonly correlation: CorrelationClass | null;
  readonly rewriteReceived: boolean | null;
}

const KEY_BYTES = 32;
const DIGEST_HEX_LENGTH = 32;

export function resolvePluginData(environment: NodeJS.ProcessEnv): string {
  const path = environment.PLUGIN_DATA ?? environment.RLM_PLUGIN_DATA;
  if (path === undefined || path.length === 0) {
    throw new Error("PLUGIN_DATA is required for the D7 diagnostic");
  }
  return path;
}

function readOrCreateKey(pluginData: string): Buffer {
  const keyPath = join(pluginData, "spike", "digest.key");
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });

  try {
    const descriptor = openSync(keyPath, "wx", 0o600);
    try {
      writeFileSync(descriptor, randomBytes(KEY_BYTES));
    } finally {
      closeSync(descriptor);
    }
  } catch (error: unknown) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    ) {
      throw error;
    }
  }

  const key = readFileSync(keyPath);
  if (key.length !== KEY_BYTES) {
    throw new Error("invalid D7 diagnostic key");
  }
  return key;
}

export function digestIdentifier(
  pluginData: string,
  value: string | null | undefined,
): string | null {
  if (value === undefined || value === null || value.length === 0) {
    return null;
  }
  return createHmac("sha256", readOrCreateKey(pluginData))
    .update(value, "utf8")
    .digest("hex")
    .slice(0, DIGEST_HEX_LENGTH);
}

export function appendStructuralEvent(
  pluginData: string,
  event: StructuralEvent,
): void {
  const eventPath = join(pluginData, "spike", "events.jsonl");
  mkdirSync(dirname(eventPath), { recursive: true, mode: 0o700 });
  appendFileSync(eventPath, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "a",
  });
}

export function readStructuralEvents(pluginData: string): StructuralEvent[] {
  const eventPath = join(pluginData, "spike", "events.jsonl");
  let content: string;
  try {
    content = readFileSync(eventPath, "utf8");
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }

  return content
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StructuralEvent);
}

export function classifyTurn(
  events: readonly StructuralEvent[],
  session: string | null,
  turn: string | null,
): CorrelationClass {
  if (session === null || turn === null) {
    return "ambiguous";
  }

  const matchingAgents = new Set(
    events
      .filter(
        (event) =>
          event.source === "hook" &&
          event.event === "SubagentStart" &&
          event.session === session &&
          event.turn === turn &&
          event.agent !== null,
      )
      .map((event) => event.agent),
  );

  if (matchingAgents.size === 0) {
    return "parent";
  }
  if (matchingAgents.size === 1) {
    return "subagent";
  }
  return "ambiguous";
}
