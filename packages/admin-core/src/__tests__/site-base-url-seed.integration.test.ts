// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: provisioned installs kept site_defaults.site_base_url at the
 * migration's dev default, so the live site's canonical / og:url / JSON-LD
 * / sitemap / robots.txt pointed at http://localhost:8082. The admin now
 * adopts the provisioner-declared CAELO_SITE_BASE_URL at boot — but only
 * over a local address, never over a URL the operator chose.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  type SiteDefaultsSetSeoInput,
  siteDefaultsSetSeoInputSchema,
} from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";
import { seedSiteBaseUrl } from "../site-base-url-seed.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYS_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "site-base-url-seed",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let seoBeforeFile: SiteDefaultsSetSeoInput | null = null;

async function sysOp(name: string, input: unknown): Promise<unknown> {
  const r = await execute(registry, adapter, SYS_CTX, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value;
}

const getSeo = async () =>
  (await sysOp("site_defaults.get_seo", {})) as {
    siteBaseUrl: string;
    sitemapEnabled: boolean;
    organizationJson: Record<string, unknown>;
  };

const seed = (declared: string | undefined) =>
  seedSiteBaseUrl({ registry, adapter, ctx: SYS_CTX, declared });

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  seoBeforeFile = siteDefaultsSetSeoInputSchema.parse(await getSeo());
});

afterAll(async () => {
  if (seoBeforeFile) await sysOp("site_defaults.set_seo", seoBeforeFile);
  await adapter.close();
});

describe("seedSiteBaseUrl", () => {
  it("replaces the dev default with the declared URL and keeps the other SEO settings", async () => {
    await sysOp("site_defaults.set_seo", {
      siteBaseUrl: "http://localhost:8082",
      sitemapEnabled: false,
      organizationJson: { name: "Acme" },
    });
    const r = await seed("https://example.com");
    expect(r).toEqual({ kind: "seeded", from: "http://localhost:8082", to: "https://example.com" });
    expect(await getSeo()).toEqual({
      siteBaseUrl: "https://example.com",
      sitemapEnabled: false,
      organizationJson: { name: "Acme" },
    });
  });

  it("is idempotent across restarts", async () => {
    expect(await seed("https://example.com")).toEqual({ kind: "unchanged" });
    expect((await getSeo()).siteBaseUrl).toBe("https://example.com");
  });

  it("never overwrites a public URL the operator chose", async () => {
    await sysOp("site_defaults.set_seo", {
      siteBaseUrl: "https://www.operator-choice.com",
      sitemapEnabled: true,
      organizationJson: {},
    });
    expect(await seed("https://example.com")).toEqual({ kind: "unchanged" });
    expect((await getSeo()).siteBaseUrl).toBe("https://www.operator-choice.com");
  });

  it("leaves a dev box (no declared URL) on localhost", async () => {
    await sysOp("site_defaults.set_seo", {
      siteBaseUrl: "http://localhost:8082",
      sitemapEnabled: true,
      organizationJson: {},
    });
    expect(await seed(undefined)).toEqual({ kind: "unchanged" });
    expect((await getSeo()).siteBaseUrl).toBe("http://localhost:8082");
  });
});
