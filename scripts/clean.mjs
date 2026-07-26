import { rm } from "node:fs/promises";

await Promise.all(
  ["../dist", "../.test-dist"].map((path) =>
    rm(new URL(path, import.meta.url), {
      force: true,
      recursive: true,
    }),
  ),
);
