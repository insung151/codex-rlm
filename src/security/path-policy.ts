import { realpath, lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { RlmError } from "../errors.js";

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

export async function canonicalProjectRoot(path: string): Promise<string> {
  const canonical = await realpath(path);
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) {
    throw new RlmError("PATH_OUTSIDE_ROOT");
  }
  return canonical;
}

export async function resolveExistingPath(
  root: string,
  requested: string,
): Promise<string> {
  const candidate = isAbsolute(requested) ? requested : join(root, requested);
  const canonical = await realpath(candidate);
  if (!isWithin(root, canonical)) {
    throw new RlmError("PATH_SYMLINK_ESCAPE");
  }
  return canonical;
}

export async function resolveWritableLeaf(
  root: string,
  requested: string,
): Promise<string> {
  const candidate = resolve(root, requested);
  if (!isWithin(root, candidate)) {
    throw new RlmError("PATH_OUTSIDE_ROOT");
  }
  const canonicalParent = await realpath(dirname(candidate));
  if (!isWithin(root, canonicalParent)) {
    throw new RlmError("PATH_SYMLINK_ESCAPE");
  }
  return candidate;
}
