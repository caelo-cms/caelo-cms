// SPDX-License-Identifier: MPL-2.0

/**
 * #1338 — every image that connects to a database carries the CA bundles
 * at the fixed path the verify-full URLs name as `sslrootcert`
 * (packages/shared database-tls.ts `DATABASE_CA_DIR`). URLs are built on
 * the operator's machine or by another service, so the path must be the
 * same in every image; an image without the file cannot open a single
 * connection (Bun fails the TLS setup with the missing CA file).
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATABASE_CA_DIR } from "../packages/shared/src/database-tls.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** The images whose processes open database connections. */
const IMAGES = [
  "apps/admin/Dockerfile",
  "apps/api-gateway/Dockerfile",
  "packages/provisioning/Dockerfile.ops",
] as const;

describe("database CA bundles in every image (#1338)", () => {
  for (const path of IMAGES) {
    it(`${path} copies packages/shared/certs/ to ${DATABASE_CA_DIR}/`, () => {
      const src = readFileSync(resolve(REPO_ROOT, path), "utf8");
      expect(src).toMatch(
        new RegExp(`\\nCOPY (--from=\\S+ )?\\S*packages/shared/certs/? ${DATABASE_CA_DIR}/?\\n`),
      );
    });
  }
});
