// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ALLOWED } from "./allowlist.js";
import {
  distinctFindings,
  evaluate,
  isRiStatement,
  normaliseFilter,
  parseCatalogTsv,
  parsePlanLog,
  policyTermsOf,
  renderReport,
} from "./analyze.js";

/** Plan entries as seqscan-filter.ts prints them (tabs as Postgres logs them). */
const LOG = [
  "@@caelo/redirects.collapse@@ LOG:  plan:",
  "\tQuery Text: SELECT id FROM redirects WHERE to_path = $1",
  "\tSeq Scan on public.redirects",
  "\t  Filter: ((redirects.to_path = $1) AND (current_setting('caelo.actor_kind'::text, true) = 'system'::text))",
  "@@END",
  "@@caelo/pages.list@@ LOG:  plan:",
  "\tQuery Text: SELECT * FROM pages ORDER BY id",
  "\tSeq Scan on public.pages p",
  "\t  Filter: (NULLIF(current_setting('caelo.actor_kind'::text, true), ''::text) IS NOT NULL)",
  "@@END",
  "@@caelo/media.delete_many@@ LOG:  plan:",
  '\tQuery Text: UPDATE ONLY "public"."pages_seo" SET "og_image_asset_id" = NULL WHERE $1 OPERATOR(pg_catalog.=) "og_image_asset_id"',
  "\tUpdate on public.pages_seo x",
  "\t  ->  Seq Scan on public.pages_seo x",
  "\t        Filter: ($1 = x.og_image_asset_id)",
  "@@END",
  "@@caelo/plugin_storage.delete@@ LOG:  plan:",
  '\tQuery Text: DELETE FROM ONLY "plugin_forms"."submissions" WHERE $1 OPERATOR(pg_catalog.=) "page_id"',
  "\tDelete on plugin_forms.submissions",
  "\t  ->  Seq Scan on plugin_forms.submissions",
  "\t        Filter: ($1 = submissions.page_id)",
  "@@END",
  "@@caelo/chat.list@@ LOG:  plan:",
  "\tQuery Text:",
  "\t  SELECT id FROM chat_sessions WHERE kind = 'x' ORDER BY created_at LIMIT 5",
  "\tLimit",
  "\t  ->  Index Scan using chat_sessions_created_at_idx on public.chat_sessions s",
  "\t        Filter: (s.kind = 'x'::text)",
  "\t  ->  Index Scan using chat_sessions_pkey on public.chat_sessions c",
  "\t        Index Cond: (c.id = $1)",
  "\t        Filter: (c.kind = 'y'::text)",
  "@@END",
  "",
].join("\n");

describe("query index gate analyzer (#1293)", () => {
  const entries = parsePlanLog(LOG);
  const findings = distinctFindings(entries);

  it("attributes each plan to its adapter tag and first statement line", () => {
    expect(entries.map((e) => e.holder)).toEqual([
      "redirects.collapse",
      "pages.list",
      "media.delete_many",
      "plugin_storage.delete",
      "chat.list",
    ]);
    expect(entries[4]?.query).toStartWith("SELECT id FROM chat_sessions");
  });

  it("keeps the op's own filter, drops RLS terms, and skips RLS-only reads", () => {
    const redirects = findings.find((f) => f.relation === "public.redirects");
    expect(redirects?.filter).toBe("(to_path = ?)");
    expect(findings.some((f) => f.relation === "public.pages")).toBe(false);
  });

  it("classifies Postgres's RI statements as FK checks", () => {
    expect(findings.find((f) => f.relation === "public.pages_seo")?.kind).toBe("fk");
    expect(isRiStatement("SELECT id FROM pages WHERE id = $1")).toBe(false);
  });

  it("reports a whole-index walk with a filter, not an index lookup", () => {
    const chat = findings.filter((f) => f.relation === "public.chat_sessions");
    expect(chat.map((f) => [f.filter, f.scan])).toEqual([["(kind = ?)", "index"]]);
    // An index leading with the filter's column: the walk was a cost tie on
    // a near-empty table, not a missing index.
    const withIndex = distinctFindings(entries, {
      policies: new Map(),
      leadingColumns: new Map([["public.chat_sessions", ["kind"]]]),
    });
    expect(withIndex.some((f) => f.relation === "public.chat_sessions")).toBe(false);
  });

  it("fails unexplained findings and leaves core FK checks to the FK lint", () => {
    const v = evaluate(findings, []);
    expect(v.coveredByFkLint).toBe(1);
    expect(v.violations.map((f) => f.relation).sort()).toEqual([
      "plugin_forms.submissions",
      "public.redirects",
    ]);
    // A whole-index walk is advisory: on a near-empty table it can tie with a lookup.
    expect(v.advisory.map((f) => f.relation)).toEqual(["public.chat_sessions"]);
    expect(renderReport(v, entries.length)).toContain("unindexed filter");
  });

  it("keeps a Seq Scan whatever order its index-walk twin comes in", () => {
    const walk = [
      "@@caelo/x.list@@ LOG:  plan:",
      "\tQuery Text: SELECT id FROM t WHERE k = $1 ORDER BY id",
      "\tIndex Scan using t_pkey on public.t",
      "\t  Filter: (t.k = $1)",
    ].join("\n");
    const seq = [
      "@@caelo/x.list@@ LOG:  plan:",
      "\tQuery Text: SELECT id FROM t WHERE k = $1",
      "\tSeq Scan on public.t",
      "\t  Filter: (t.k = $1)",
    ].join("\n");
    for (const log of [`${walk}\n@@END\n${seq}\n@@END\n`, `${seq}\n@@END\n${walk}\n@@END\n`]) {
      const v = evaluate(distinctFindings(parsePlanLog(log)), []);
      expect(v.violations.map((f) => [f.relation, f.scan])).toEqual([["public.t", "seq"]]);
      expect(v.advisory.map((f) => f.scan)).toEqual(["index"]);
    }
  });

  it("passes allowlisted findings, and fails a stale entry", () => {
    const allowed = [
      { table: "public.redirects", reason: "test" },
      { table: "plugin_forms.*", reason: "test" },
      { table: "public.gone", reason: "test" },
    ];
    const v = evaluate(findings, allowed);
    expect(v.violations).toEqual([]);
    expect(v.allowed).toBe(2);
    expect(v.stale).toEqual([{ table: "public.gone", reason: "test" }]);
  });

  it("drops the relation's RLS policy terms, also OR-ed permissive ones", () => {
    const quals = parseCatalogTsv(
      [
        "public.mcp_tokens\t(caelo_mcp_tokens_manage_all() OR (actor_id = caelo_mcp_token_principal()))",
        "public.mcp_tokens\t(NULLIF(current_setting('caelo.actor_kind'::text, true), ''::text) IS NOT NULL)",
      ].join("\n"),
    );
    const own = ["t", "mcp_tokens"];
    const terms = policyTermsOf(quals.get("public.mcp_tokens") ?? [], own);
    expect(
      normaliseFilter(
        "((caelo_mcp_tokens_manage_all() OR (t.actor_id = caelo_mcp_token_principal())) AND (t.revoked_at IS NULL) AND (t.name = $1))",
        own,
        terms,
      ),
    ).toBe("(revoked_at IS NULL) AND (name = ?)");
    // Without the policies the policy term reads as an op filter.
    expect(normaliseFilter("(t.actor_id = caelo_mcp_token_principal())", own)).toBe(
      "(actor_id = caelo_mcp_token_principal())",
    );
  });

  it("reads a live-rows-only filter as a whole-domain read, not a lookup", () => {
    expect(normaliseFilter("((l.chat_branch_id IS NULL) OR (l.chat_branch_id = $1))", ["l"])).toBe(
      "",
    );
    expect(
      normaliseFilter("((t.caelo_deleted_at IS NULL) AND (t.caelo_chat_branch_id IS NULL))", ["t"]),
    ).toBe("");
    expect(normaliseFilter("((l.chat_branch_id IS NULL) AND (l.slug = $1))", ["l"])).toBe(
      "(chat_branch_id IS NULL) AND (slug = ?)",
    );
    expect(normaliseFilter("(c.archived_at IS NULL)", ["c"])).toBe("(archived_at IS NULL)");
  });

  it("normalises literals, numbers, casts and the relation's own qualifier", () => {
    expect(
      normaliseFilter("((t.kind = ANY ('{a,b}'::text[])) AND (t.n > 10) AND (other.x = t.y))", [
        "t",
      ]),
    ).toBe("(kind = ANY (?)) AND (n > ?) AND (other.x = y)");
  });

  it("matches the shipped stream filter's output format", async () => {
    // Feed the plan through the real stream filter: what it keeps is what the
    // analyzer parses, and an Index Scan with an Index Cond alone is dropped.
    const raw = [
      "@@caelo/a.b@@ LOG:  duration: 0.010 ms  plan:",
      "\tQuery Text: SELECT 1 FROM t WHERE x = $1",
      "\tSeq Scan on public.t  (cost=0.00..1.00 rows=1 width=4)",
      "\t  Output: 1",
      "\t  Filter: (t.x = $1)",
      "@@caelo/a.b@@ LOG:  duration: 0.020 ms  plan:",
      "\tQuery Text: SELECT 1 FROM t WHERE x = $1",
      "\tSeq Scan on public.t  (cost=0.00..9.00 rows=1 width=4)",
      "\t  Output: 1",
      "\t  Filter: (t.x = $1)",
      "@@caelo/a.c@@ LOG:  duration: 0.010 ms  plan:",
      "\tQuery Text: SELECT 1 FROM t WHERE id = $1",
      "\tIndex Scan using t_pkey on public.t  (cost=0.00..1.00 rows=1 width=4)",
      "\t  Index Cond: (t.id = $1)",
      "@@@@ LOG:  duration: 0.010 ms  plan:",
      "\tQuery Text: DELETE FROM t WHERE x LIKE 'fixture%'",
      "\tSeq Scan on public.t  (cost=0.00..1.00 rows=1 width=4)",
      "\t  Filter: (t.x ~~ 'fixture%'::text)",
      "@@@@ LOG:  statement: SELECT 1",
      "",
    ].join("\n");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "seqscan-filter.ts")], {
      stdin: new Blob([raw]),
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const kept = parsePlanLog(out);
    expect(kept.map((e) => e.holder)).toEqual(["a.b"]);
    expect(out).not.toContain("cost=");
    expect(out).not.toContain("Output:");
  });

  it("reads a multi-megabyte statement in linear time and keeps its plan", async () => {
    // A bulk INSERT's text: appending each line to one string made the
    // filter quadratic, stalled it, and with it the server (CI, #1293).
    const huge = [
      "@@caelo/bulk.insert@@ LOG:  duration: 1.000 ms  plan:",
      "\tQuery Text: INSERT INTO t SELECT * FROM (VALUES",
      ...Array.from({ length: 200_000 }, (_, i) => `\t  ('${"x".repeat(60)}', ${i}),`),
      "\tSeq Scan on public.t  (cost=0.00..1.00 rows=1 width=4)",
      "\t  Filter: (t.x = $1)",
      "@@@@ LOG:  next",
      "",
    ].join("\n");
    const started = performance.now();
    const proc = Bun.spawn(["bun", join(import.meta.dir, "seqscan-filter.ts")], {
      stdin: new Blob([huge]),
      stdout: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(10_000);
    const [entry] = parsePlanLog(out);
    expect(entry?.query).toStartWith("INSERT INTO t");
    expect(distinctFindings(parsePlanLog(out)).map((f) => f.filter)).toEqual(["(x = ?)"]);
  });

  it("every allowlist entry has a reason", () => {
    for (const r of ALLOWED) expect(r.reason.length).toBeGreaterThan(30);
  });
});
