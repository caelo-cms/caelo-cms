// SPDX-License-Identifier: MPL-2.0
/**
 * #551 regression: production builds used to fall back to
 * http://localhost:8082 for every canonical, og:url, JSON-LD url and
 * sitemap entry when site_defaults.site_base_url was never set. The
 * generator now refuses to build without it, before writing any file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { generateSite } from "./generate.js";
import { readSeoSettings } from "./seo-pass.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "seo-settings-test",
};

let adapter: DatabaseAdapter;
let baseBefore: string | null = null;

async function setBase(url: string | null): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE site_defaults SET site_base_url = ${url} WHERE id = 1`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const sql = new SQL(ADMIN_URL!);
  try {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return tx`SELECT site_base_url FROM site_defaults WHERE id = 1`;
    });
    baseBefore = (rows[0] as { site_base_url: string | null }).site_base_url;
  } finally {
    await sql.end();
  }
});

afterAll(async () => {
  await setBase(baseBefore);
  await adapter.close();
});

describe("#551 site base URL in the static generator", () => {
  it("readSeoSettings throws an actionable error when the base URL is unset", async () => {
    await setBase(null);
    const read = adapter.withAdminTransaction(systemCtx, (tx) => readSeoSettings(tx));
    await expect(read).rejects.toThrow("Site base URL is not configured");
    await expect(
      adapter.withAdminTransaction(systemCtx, (tx) => readSeoSettings(tx)),
    ).rejects.toThrow("Security → SEO");
  });

  it("readSeoSettings returns the configured base URL, never a substitute", async () => {
    await setBase("https://site-551.example");
    const s = await adapter.withAdminTransaction(systemCtx, (tx) => readSeoSettings(tx));
    expect(s.siteBaseUrl).toBe("https://site-551.example");
  });

  it("generateSite fails before writing anything when the base URL is unset", async () => {
    await setBase(null);
    const root = mkdtempSync(join(tmpdir(), "caelo-551-"));
    const run = adapter.withAdminTransaction(systemCtx, (tx) =>
      generateSite({
        tx,
        target: {
          id: "00000000-0000-0000-0000-000000000551",
          name: "production",
          env: "production",
          outDir: "out",
          baseUrl: "https://site-551.example",
          robotsDefault: "index",
        } as Parameters<typeof generateSite>[0]["target"],
        runId: "run-551",
        repoRoot: root,
      }),
    );
    await expect(run).rejects.toThrow("Site base URL is not configured");
    expect(existsSync(join(root, "out", "builds", "run-551"))).toBe(false);
  });
});
