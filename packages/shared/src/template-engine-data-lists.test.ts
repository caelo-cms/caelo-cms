// SPDX-License-Identifier: MPL-2.0

/**
 * Plugin data lists in the template engine: `{{#name}}…{{/name}}` over
 * data a plugin supplies per page, with the module owning the markup.
 *
 * The load-bearing case is the third one. Plugin activation is a hard
 * state, so a module written while a plugin ran keeps its
 * `{{#language_links}}` after the plugin is switched off. Rendering
 * that as an empty string would be a silent fallback (CLAUDE.md §2) and
 * would read to the operator as "the switcher vanished for no reason".
 * It has to stay visible AND say which plugin to turn back on.
 */

import { describe, expect, it } from "bun:test";
import { renderTemplate } from "./template-engine.js";

const SWITCHER =
  '<nav>{{#language_links}}<a href="{{href}}">{{label}}</a>{{/language_links}}</nav>';

describe("template engine — plugin data lists", () => {
  it("iterates a plugin list with the module's own markup", () => {
    const r = renderTemplate({
      html: SWITCHER,
      fields: [],
      dataLists: {
        language_links: [
          { href: "/", label: "English", locale: "en" },
          { href: "/de", label: "Deutsch", locale: "de" },
        ],
      },
    });
    expect(r.html).toBe('<nav><a href="/">English</a><a href="/de">Deutsch</a></nav>');
    expect(r.missingSlots).toEqual([]);
  });

  it("renders nothing for an empty list — that is data, not breakage", () => {
    // A page with no published translations legitimately has no links.
    const r = renderTemplate({
      html: SWITCHER,
      fields: [],
      dataLists: { language_links: [] },
    });
    expect(r.html).toBe("<nav></nav>");
    expect(r.missingSlots).toEqual([]);
  });

  it("stays loud and names the plugin when its plugin is switched off", () => {
    const r = renderTemplate({
      html: SWITCHER,
      fields: [],
      dormantDataLists: { language_links: "international-site" },
    });
    // Loud-raw: the section survives in the output rather than
    // silently collapsing.
    expect(r.html).toContain("{{#language_links}}");
    expect(r.missingSlots).toContain(
      "plugin-list-unavailable:language_links plugin=international-site",
    );
  });

  it("keeps an unknown name a plain undeclared field", () => {
    // No plugin claims it — this really is a typo, and must not be
    // reported as a deactivated plugin.
    const r = renderTemplate({ html: "<p>{{#nope}}x{{/nope}}</p>", fields: [] });
    expect(r.missingSlots).toContain("field-not-declared:nope");
  });

  it("lets a module's own field win over a plugin list of the same name", () => {
    // Module fields are resolved first by construction, so a plugin can
    // never shadow content the author declared.
    const r = renderTemplate({
      html: "<ul>{{#items}}<li>{{label}}</li>{{/items}}</ul>",
      fields: [{ name: "items", kind: "link-list" }],
      contentValues: { items: [{ label: "authored", href: "/a" }] },
      dataLists: { items: [{ label: "from-plugin" }] },
    });
    expect(r.html).toContain("authored");
    expect(r.html).not.toContain("from-plugin");
  });

  it("leaves a key the items do not carry raw", () => {
    const r = renderTemplate({
      html: "{{#l}}<a href={{href}}>{{missing_key}}</a>{{/l}}",
      fields: [],
      dataLists: { l: [{ href: "/x" }] },
    });
    expect(r.html).toContain("{{missing_key}}");
  });
});
