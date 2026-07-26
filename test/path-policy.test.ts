import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RlmError } from "../src/errors.js";
import {
  canonicalProjectRoot,
  resolveExistingPath,
  resolveWritableLeaf,
} from "../src/security/path-policy.js";

test("path policy permits rooted paths and rejects traversal and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-rlm-root-"));
  const outside = await mkdtemp(join(tmpdir(), "codex-rlm-outside-"));
  await writeFile(join(root, "inside.txt"), "inside", "utf8");
  await writeFile(join(outside, "outside.txt"), "outside", "utf8");
  await symlink(join(outside, "outside.txt"), join(root, "escape"));
  await mkdir(join(root, "artifacts"));

  const canonical = await canonicalProjectRoot(root);
  assert.equal(
    await resolveExistingPath(canonical, "inside.txt"),
    join(canonical, "inside.txt"),
  );
  await assert.rejects(
    resolveExistingPath(canonical, "escape"),
    (error: unknown) =>
      error instanceof RlmError && error.category === "PATH_SYMLINK_ESCAPE",
  );
  await assert.rejects(
    resolveExistingPath(canonical, "missing.txt"),
    (error: unknown) =>
      error instanceof RlmError && error.category === "EVIDENCE_NOT_FOUND",
  );
  await assert.rejects(
    resolveExistingPath(canonical, "../outside.txt"),
    (error: unknown) =>
      error instanceof RlmError && error.category === "PATH_OUTSIDE_ROOT",
  );
  await assert.rejects(
    resolveWritableLeaf(join(root, "artifacts"), "../../escape.txt"),
    (error: unknown) =>
      error instanceof RlmError && error.category === "PATH_OUTSIDE_ROOT",
  );
});
