// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — the pure conversion half of the link migration:
 * what it converts and how it counts. The count feeds the Owner's report
 * ("N links converted"), so it counts real references only.
 */

import { describe, expect, it } from "bun:test";
import type { LinkTargetLookup } from "@caelo-cms/shared";
import { convertModuleHtml, convertSetItems } from "../links/migrate-convert.js";

const ABOUT_ID = "11111111-1111-4111-8111-111111111111";

const lookup: LinkTargetLookup = {
  pageIdForPath: (p) => (p === "/about" ? ABOUT_ID : null),
  mediaIdForSlug: () => null,
  pageExists: (id) => id === ABOUT_ID,
  mediaExists: () => false,
  isOwnHost: () => false,
};

describe("link migration conversion", () => {
  it("counts converted references, not every 'caelo:' in the text", () => {
    const out = convertModuleHtml(
      '<p>Links are stored as caelo: references (caelo:page/…).</p><a href="/about">About</a><a href="/about#team">Team</a>',
      { lookup },
    );
    expect(out.changed).toBe(true);
    expect(out.converted).toBe(2);
    expect(out.next).toContain(`href="caelo:page/${ABOUT_ID}"`);
    expect(out.next).toContain(`href="caelo:page/${ABOUT_ID}#team"`);
  });

  it("an existing reference is left alone and not counted again", () => {
    const out = convertSetItems(
      [
        { label: "About", href: `caelo:page/${ABOUT_ID}` },
        { label: "Gone", href: "/gone" },
      ],
      { lookup },
    );
    expect(out.changed).toBe(false);
    expect(out.converted).toBe(0);
    expect(out.issues.map((i) => i.value)).toEqual(["/gone"]);
  });
});
