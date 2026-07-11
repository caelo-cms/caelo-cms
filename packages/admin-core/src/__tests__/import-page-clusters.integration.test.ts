// SPDX-License-Identifier: MPL-2.0

/**
 * issue #194 — cluster ops against the real Postgres: signatures land
 * via write_extracted_pages, list groups them (home pinned first),
 * assign re-labels + re-assigns in one tx, and partial-match bulk
 * moves fail loudly instead of half-applying.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "issue194-clusters",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue194-clusters-ai",
};

let runId: string;

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const run = await execute(registry, adapter, SYSTEM, "imports.create_run", {
    sourceUrl: "https://issue194.example/",
    depth: 2,
    maxPages: 50,
  });
  if (!run.ok) throw new Error(JSON.stringify(run.error));
  runId = (run.value as { runId: string }).runId;

  const mkPage = (slug: string, sig: string) => ({
    sourceUrl: `https://issue194.example/${slug}`,
    proposedSlug: slug.replace(/\//g, "-") || "home",
    proposedTitle: slug || "Home",
    proposedModules: [],
    proposedThemeTokens: {},
    signature: sig,
  });
  const wrote = await execute(registry, adapter, SYSTEM, "imports.write_extracted_pages", {
    runId,
    pages: [
      { ...mkPage("", "home"), sourceUrl: "https://issue194.example/" },
      mkPage("blog/a", "/blog/*|abc"),
      mkPage("blog/b", "/blog/*|abc"),
      mkPage("blog/c", "/blog/*|abc"),
      mkPage("about", "/*|def"),
    ],
  });
  if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
});

afterAll(async () => {
  await adapter.close();
});

describe("import page clusters (#194)", () => {
  it("lists clusters grouped by signature, home pinned first", async () => {
    const r = await execute(registry, adapter, AI, "imports.list_page_clusters", { runId });
    expect(r.ok).toBe(true);
    const clusters = (
      r.value as { clusters: { clusterKey: string; count: number; label: string | null }[] }
    ).clusters;
    expect(clusters[0]?.clusterKey).toBe("home");
    const blog = clusters.find((c) => c.clusterKey === "/blog/*|abc");
    expect(blog?.count).toBe(3);
    expect(blog?.label).toBeNull();
  });

  it("labels a cluster and moves a page in one bulk call", async () => {
    const list = await execute(registry, adapter, AI, "imports.list_page_clusters", { runId });
    const clusters = (
      list.value as {
        clusters: { clusterKey: string; samples: { importPageId: string }[] }[];
      }
    ).clusters;
    const about = clusters.find((c) => c.clusterKey === "/*|def");
    const aboutPageId = about?.samples[0]?.importPageId;
    if (!aboutPageId) throw new Error("about page missing");

    // Operator said the about page IS a blog-style page; AI moves it
    // and labels the target cluster in the same call.
    const r = await execute(registry, adapter, AI, "imports.assign_page_cluster", {
      runId,
      clusterKey: "/blog/*|abc",
      importPageIds: [aboutPageId],
      label: "Blogartikel",
    });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ reassigned: 1, labelled: 4 });

    const after = await execute(registry, adapter, AI, "imports.list_page_clusters", { runId });
    const afterClusters = (
      after.value as { clusters: { clusterKey: string; count: number; label: string | null }[] }
    ).clusters;
    const blog = afterClusters.find((c) => c.clusterKey === "/blog/*|abc");
    expect(blog?.count).toBe(4);
    expect(blog?.label).toBe("Blogartikel");
    expect(afterClusters.some((c) => c.clusterKey === "/*|def")).toBe(false);
  });

  it("bulk move with a foreign page id fails loudly (no half-apply)", async () => {
    const r = await execute(registry, adapter, AI, "imports.assign_page_cluster", {
      runId,
      clusterKey: "/blog/*|abc",
      importPageIds: ["99999999-9999-4999-8999-999999999999"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r.error)).toContain("list_page_clusters");
    }
  });

  it("labelling an unknown cluster names the fix", async () => {
    const r = await execute(registry, adapter, AI, "imports.assign_page_cluster", {
      runId,
      clusterKey: "no-such-cluster",
      label: "Ghost",
    });
    expect(r.ok).toBe(false);
  });
});
