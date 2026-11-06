// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  composeSiteHeaders,
  DEFAULT_SITE_SECURITY_POLICY,
  EMPTY_CSP_FACTS,
  SECURITY_HEADERS_BUILD_FILE,
  type SiteCspFacts,
} from "@caelo-cms/shared";
import type { StagedBuild, StagedPage } from "../check.js";
import { findingSchema } from "../findings.js";
import { createSecurityHeadersCheck } from "../security-headers.js";

const PAGE_ID = "00000000-0000-4000-8000-000000000001";
const pages: StagedPage[] = [{ pageId: PAGE_ID, path: "/about", url: "http://x/about/", html: "" }];
const FACTS: SiteCspFacts = {
  ...EMPTY_CSP_FACTS,
  blockers: [
    { kind: "inline-handler", detail: "onclick", pages: ["/about/index.html"], pageCount: 3 },
  ],
};

const buildOf = (text: string | null): StagedBuild => ({
  baseUrl: "http://x",
  probe: async () => ({ found: true, status: 200 }),
  text: async (path) => {
    expect(path).toBe(`/${SECURITY_HEADERS_BUILD_FILE}`);
    return text;
  },
});

const run = async (cspMode: "report_only" | "enforce", facts = FACTS) => {
  const text = JSON.stringify(
    composeSiteHeaders({ ...DEFAULT_SITE_SECURITY_POLICY, cspMode }, facts),
  );
  return createSecurityHeadersCheck().run({ pages, build: buildOf(text) });
};

describe("the security-headers check", () => {
  it("warns under report_only: nothing is blocked for a visitor yet", async () => {
    const [finding] = await run("report_only");
    expect(findingSchema.safeParse(finding).success).toBe(true);
    expect(finding?.severity).toBe("warning");
    expect(finding?.ruleId).toBe("security-headers/inline-handler");
    expect(finding?.pageId).toBe(PAGE_ID);
    expect(finding?.message).toContain("would stop working if");
    expect(finding?.fix?.tool).toBe("update_modules_many");
  });

  it("blocks under enforce: the markup stops working for every visitor", async () => {
    const [finding] = await run("enforce");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("blocks it for every visitor");
  });

  it("a clean build has no finding", async () => {
    expect(await run("enforce", EMPTY_CSP_FACTS)).toEqual([]);
  });

  it("says when the policy did not fit", async () => {
    const hashes = Array.from(
      { length: 200 },
      (_, i) => `'sha256-${String(i).padStart(43, "0")}='`,
    );
    const findings = await run("report_only", { ...EMPTY_CSP_FACTS, inlineScriptHashes: hashes });
    expect(findings.map((f) => f.ruleId)).toEqual(["security-headers/csp-too-large"]);
    expect(findings.every((f) => findingSchema.safeParse(f).success)).toBe(true);
  });

  it("a staged build without the file reports nothing", async () => {
    expect(await createSecurityHeadersCheck().run({ pages, build: buildOf(null) })).toEqual([]);
  });
});
