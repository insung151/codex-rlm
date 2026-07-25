import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { RlmError } from "../errors.js";

const writeQueues = new Map<string, Promise<void>>();

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeAndValidateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, stableJson(value), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    JSON.parse(await readFile(temporary, "utf8"));
    await rename(temporary, path);
    JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw new RlmError("PERSISTENCE_FAILED");
  }
}

export async function atomicWriteText(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
    if ((await readFile(path, "utf8")) !== content) {
      throw new Error("post-write validation failed");
    }
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw new RlmError("PERSISTENCE_FAILED");
  }
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.then(() => writeAndValidateJson(path, value));
  writeQueues.set(path, current);
  try {
    await current;
  } finally {
    if (writeQueues.get(path) === current) {
      writeQueues.delete(path);
    }
  }
}

export async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error: unknown) {
    throw new RlmError("PERSISTENCE_FAILED");
  }
}

export async function appendBoundedJsonLine(
  path: string,
  value: unknown,
  maxBytes = 4096,
): Promise<void> {
  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line) > maxBytes) {
    throw new RlmError("PERSISTENCE_FAILED", "event exceeds bound");
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = await open(path, "a", 0o600);
  try {
    await descriptor.write(line, undefined, "utf8");
  } finally {
    await descriptor.close();
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error: unknown) {
    return false;
  }
}
