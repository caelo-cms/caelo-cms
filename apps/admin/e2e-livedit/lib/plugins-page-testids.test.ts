// SPDX-License-Identifier: MPL-2.0

/**
 * The plugin activation guard (fixtures.ts) switches plugins off by clicking
 * `[data-testid="disable-<slug>"]` on /security/plugins, and
 * activatePluginAsOwner switches them back on via `reenable-<slug>`. A Disable
 * button without that id — first shipped on the Tier 2 table — left a Tier 2
 * plugin a scenario activated running for every later scenario. This pins
 * the ids on EVERY Disable / Re-enable button of the page, whichever table.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PAGE = resolve(import.meta.dir, "../../src/routes/(authed)/security/plugins/+page.svelte");

/** Each `<Button …>label</Button>` whose visible label is `label`. */
function buttonsLabelled(source: string, label: string): string[] {
  const re = /<Button\b([^>]*)>\s*([^<]*?)\s*<\/Button>/g;
  return [...source.matchAll(re)]
    .filter((m) => (m[2] ?? "").trim() === label)
    .map((m) => m[1] ?? "");
}

describe("/security/plugins test ids the e2e plugin guard relies on", () => {
  const source = readFileSync(PAGE, "utf8");

  it("every Disable button (Tier 1 and Tier 2) carries disable-{slug}", () => {
    const disables = buttonsLabelled(source, "Disable");
    expect(disables.length).toBeGreaterThanOrEqual(2);
    for (const attrs of disables) expect(attrs).toContain('data-testid="disable-{p.slug}"');
  });

  it("every Re-enable button (Tier 1 and Tier 2) carries reenable-{slug}", () => {
    const reenables = buttonsLabelled(source, "Re-enable");
    expect(reenables.length).toBeGreaterThanOrEqual(2);
    for (const attrs of reenables) expect(attrs).toContain('data-testid="reenable-{p.slug}"');
  });
});
