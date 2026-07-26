import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { RlmError } from "../errors.js";
import type { Role } from "../domain/types.js";

export interface AuthorizationRecord {
  readonly schemaVersion: 2;
  readonly recordHash: string;
  readonly codexSessionDigest: string;
  readonly requestDigest: string;
  readonly agentDigest: string | null;
  readonly role: Role;
  readonly operation: string;
  readonly inputDigest: string;
  readonly cwd: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ConsumedAuthority extends AuthorizationRecord {}

export interface IssueAuthorizationInput {
  readonly codexSessionDigest: string;
  readonly requestDigest: string;
  readonly agentDigest: string | null;
  readonly role: Role;
  readonly operation: string;
  readonly inputDigest: string;
  readonly cwd: string;
}

export interface AuthorityClock {
  now(): number;
}

// Codex can queue an already-authorized MCP dispatch for several minutes.
// This window covers dispatch latency only: each record remains one-time and
// bound to one request, operation, exact input, session, agent, role, and cwd.
const DEFAULT_TTL_MS = 15 * 60_000;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function toolInputDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)), "utf8")
    .digest("hex");
}

function recordsRoot(pluginData: string): string {
  return join(pluginData, "authority", "records");
}

export async function issueAuthorization(
  pluginData: string,
  input: IssueAuthorizationInput,
  clock: AuthorityClock = Date,
  ttlMs = DEFAULT_TTL_MS,
): Promise<void> {
  const recordHash = createHash("sha256")
    .update(randomBytes(32))
    .digest("hex");
  const now = clock.now();
  const record: AuthorizationRecord = {
    schemaVersion: 2,
    recordHash,
    codexSessionDigest: input.codexSessionDigest,
    requestDigest: input.requestDigest,
    agentDigest: input.agentDigest,
    role: input.role,
    operation: input.operation,
    inputDigest: input.inputDigest,
    cwd: input.cwd,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const root = recordsRoot(pluginData);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, `${recordHash}.json`),
    `${JSON.stringify(record)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    },
  );
}

async function availableRecords(
  pluginData: string,
): Promise<{ readonly path: string; readonly record: AuthorizationRecord }[]> {
  const root = recordsRoot(pluginData);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error: unknown) {
    return [];
  }
  const results = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => {
        const path = join(root, entry);
        try {
          return {
            path,
            record: JSON.parse(
              await readFile(path, "utf8"),
            ) as AuthorizationRecord,
          };
        } catch (error: unknown) {
          return null;
        }
      }),
  );
  return results.filter(
    (
      result,
    ): result is {
      readonly path: string;
      readonly record: AuthorizationRecord;
    } => result !== null,
  );
}

export async function consumeAuthorization(
  pluginData: string,
  codexSessionDigest: string | undefined,
  requestDigest: string | undefined,
  expectedOperation: string,
  expectedInput: unknown,
  clock: AuthorityClock = Date,
): Promise<ConsumedAuthority> {
  if (
    codexSessionDigest === undefined ||
    codexSessionDigest.length === 0 ||
    requestDigest === undefined ||
    requestDigest.length === 0
  ) {
    throw new RlmError("AUTHORITY_MISSING");
  }
  const inputDigest = toolInputDigest(expectedInput);
  const matching = (await availableRecords(pluginData)).filter(
    ({ record }) =>
      record.codexSessionDigest === codexSessionDigest &&
      record.requestDigest === requestDigest &&
      record.operation === expectedOperation &&
      record.inputDigest === inputDigest,
  );
  if (matching.length !== 1) {
    throw new RlmError("AUTHORITY_INVALID");
  }
  const match = matching[0];
  if (match === undefined) {
    throw new RlmError("AUTHORITY_INVALID");
  }
  const consumedRoot = join(recordsRoot(pluginData), "consumed");
  const consumed = join(
    consumedRoot,
    `${match.record.recordHash}.json`,
  );
  await mkdir(consumedRoot, { recursive: true, mode: 0o700 });
  try {
    await rename(match.path, consumed);
  } catch (error: unknown) {
    throw new RlmError("AUTHORITY_INVALID");
  }
  if (match.record.expiresAt < clock.now()) {
    throw new RlmError("AUTHORITY_EXPIRED");
  }
  return match.record;
}

export async function reapAuthorizations(
  pluginData: string,
  clock: AuthorityClock = Date,
): Promise<void> {
  const root = recordsRoot(pluginData);
  for (const directory of [root, join(root, "consumed")]) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error: unknown) {
      continue;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const path = join(directory, entry);
          try {
            const record = JSON.parse(
              await readFile(path, "utf8"),
            ) as AuthorizationRecord;
            if (record.expiresAt < clock.now()) {
              await rm(path, { force: true });
            }
          } catch (error: unknown) {
            await rm(path, { force: true });
          }
        }),
    );
  }
}

export async function discardAuthorizationsForSession(
  pluginData: string,
  codexSessionDigest: string,
): Promise<void> {
  const root = recordsRoot(pluginData);
  for (const directory of [root, join(root, "consumed")]) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error: unknown) {
      continue;
    }
    await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const path = join(directory, entry);
          try {
            const record = JSON.parse(
              await readFile(path, "utf8"),
            ) as AuthorizationRecord;
            if (record.codexSessionDigest === codexSessionDigest) {
              await rm(path, { force: true });
            }
          } catch (error: unknown) {
            await rm(path, { force: true });
          }
        }),
    );
  }
}
