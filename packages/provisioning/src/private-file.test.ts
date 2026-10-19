// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "./private-file.js";

describe("writePrivateFile", () => {
  it("creates the file owner-only and tightens a world-readable file it rewrites", () => {
    const dir = mkdtempSync(join(tmpdir(), "caelo-private-file-"));
    try {
      const fresh = join(dir, "fresh.json");
      writePrivateFile(fresh, "{}");
      expect(statSync(fresh).mode & 0o777).toBe(0o600);

      const legacy = join(dir, "legacy.json");
      writeFileSync(legacy, "{}", { mode: 0o644 });
      writePrivateFile(legacy, '{"secret":"x"}');
      expect(statSync(legacy).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
