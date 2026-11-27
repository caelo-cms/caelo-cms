// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  describeRenderFailures,
  type RenderFailure,
  renderRepairOf,
  stagedRenderReport,
} from "./render-failures.js";

const TARGET = "12004070-0000-4000-8000-000000000001";

function failure(over: Partial<RenderFailure>): RenderFailure {
  return {
    pageId: "00000000-0000-4000-8000-000000000002",
    pageTitle: "Home",
    pagePath: "/en",
    blockName: "header",
    moduleSlug: "site-header-mit-mega-men-mv59jv17",
    field: null,
    reason: "module-missing:x",
    target: null,
    line: 'page "home-en" module "site-header-mit-mega-men-mv59jv17" (block header): module-missing:x',
    ...over,
  };
}

const linkFailure = (over: Partial<RenderFailure> = {}) =>
  failure({
    reason: `link-variant-missing:page/${TARGET}:en`,
    target: { pageId: TARGET, title: "Pricing", path: "/preise" },
    line: `page "home-en" module "site-header-mit-mega-men-mv59jv17" (block header): link-variant-missing:page/${TARGET}:en`,
    ...over,
  });

describe("describeRenderFailures (#1240)", () => {
  it("groups a link by its target and says it is a Caelo bug", () => {
    const text = describeRenderFailures([linkFailure(), linkFailure({ blockName: "footer" })]);
    expect(text.caeloFault?.title).toBe("The link check and the build disagreed about a link");
    expect(text.operator).toContain(
      "Pricing (/preise) has no English version — linked from the header, the footer of /en",
    );
    expect(text.operator).toContain("This is a Caelo bug");
  });

  it("keeps slugs, ids, markers and tool names out of the operator's text", () => {
    const text = describeRenderFailures([linkFailure(), failure({})]);
    expect(text.operator).not.toContain(TARGET);
    expect(text.operator).not.toContain("site-header");
    expect(text.operator).not.toContain("link-variant-missing");
    expect(text.operator).not.toMatch(/get_content_instance|check_links|bug_report/);
  });

  it("gives the AI the technical lines and the tools", () => {
    const text = describeRenderFailures([linkFailure()]);
    expect(text.ai).toContain(`link-variant-missing:page/${TARGET}:en`);
    expect(text.ai).toContain("check_links");
    expect(text.ai).toContain("bug_report");
  });

  it("does not call a broken section a Caelo bug", () => {
    const text = describeRenderFailures([failure({})]);
    expect(text.caeloFault).toBeNull();
    expect(text.operator).toContain("the header of Home (/en) could not be rendered");
    expect(text.operator).not.toContain("Caelo bug");
  });

  it("names a link to something deleted, which has no page to name", () => {
    const text = describeRenderFailures([
      failure({ reason: `link-target-missing:page/${TARGET}`, target: null }),
    ]);
    expect(text.operator).toContain("A link points at something deleted");
    expect(text.operator).not.toContain(TARGET);
  });
});

describe("describeRenderFailures — a render without its context (#1604)", () => {
  it("is a Caelo bug of its own, not a link disagreement", () => {
    const text = describeRenderFailures([
      failure({ reason: "nested-renderer-unavailable:cards[0]" }),
      failure({}),
    ]);
    expect(text.caeloFault?.title).toBe("A build rendered content without what the renderer needs");
    expect(text.operator).toContain("This is a Caelo bug, not something in the site");
  });

  it("names each place of a page once", () => {
    const text = describeRenderFailures([failure({}), failure({}), failure({})]);
    expect(text.operator.match(/the header of Home \(\/en\)/g)).toHaveLength(1);
  });
});

describe("stagedRenderReport (#1604)", () => {
  const pathUnknown = (over: Partial<RenderFailure> = {}) =>
    failure({
      reason: "field-path-unknown:signin_link.label",
      line: 'page "home-en" module "site-header-x" (block header): field-path-unknown:signin_link.label',
      moduleSlug: "site-header-x",
      ...over,
    });

  it("is null for a build that rendered everything", () => {
    expect(stagedRenderReport([], 0)).toBeNull();
  });

  it("says the Stage succeeded, what to repair, and that Publish live is blocked", () => {
    const r = stagedRenderReport([pathUnknown(), pathUnknown({ blockName: "footer" })], 2);
    expect(r?.total).toBe(2);
    expect(r?.operatorText).toStartWith("Staged, but 2 spots could not be rendered");
    expect(r?.operatorText).toContain("the header of Home (/en)");
    expect(r?.operatorText).toContain("Publish live is blocked until they are repaired");
    expect(r?.operatorText).not.toMatch(/site-header|field-path-unknown|update_modules_many/);
    expect(r?.aiText).toContain("field-path-unknown:signin_link.label");
    expect(r?.aiText).toContain("update_modules_many");
    expect(r?.aiText).toContain("get_quality_audit");
  });

  it("counts the failures the list leaves out", () => {
    const r = stagedRenderReport([pathUnknown()], 240);
    expect(r?.total).toBe(240);
    expect(r?.aiText).toContain("could not render 240 spots");
  });

  it("names a refused plugin head entry and share image in the operator's words (#1729)", () => {
    const r = stagedRenderReport(
      [
        failure({
          blockName: null,
          moduleSlug: null,
          reason: "plugin-value-refused:probe.head-composition.link:rel-stylesheet",
        }),
        failure({
          blockName: null,
          moduleSlug: null,
          reason: "plugin-value-refused:probe.share-images.image:media-not-image",
        }),
      ],
      2,
    );
    expect(r?.operatorText).toContain(
      "A plugin added something to the page's head or sitemap that Caelo does not allow, so it was left out — on Home (/en)",
    );
    expect(r?.operatorText).toContain(
      "A plugin's default image for when the page is shared is not a published library image, so the page has none — on Home (/en)",
    );
    expect(r?.operatorText).not.toMatch(/head-composition|rel-stylesheet|get_plugin/);
    expect(r?.aiText).toContain("refuses (rel-stylesheet)");
  });

  it("reports a link like any other content: no Caelo bug on a Stage", () => {
    const r = stagedRenderReport([linkFailure()], 1);
    expect(r?.operatorText).toContain("Pricing (/preise) has no English version");
    expect(r?.operatorText).not.toContain("Caelo bug");
    expect(r?.aiText).toContain("check_links");
  });
});

describe("renderRepairOf (#1604)", () => {
  it("sends a path its link field cannot answer to the module's HTML", () => {
    const r = renderRepairOf({ reason: "field-path-unknown:cta.label", moduleSlug: "hero" });
    expect(r.tool).toBe("update_modules_many");
    expect(r.hint).toContain("{{cta.label}}");
    expect(r.hint).toContain("a link's text is a text field of its own");
  });

  it("sends a broken nested reference to the content", () => {
    const r = renderRepairOf({
      reason: "<!-- caelo:missing reason=module-missing:abc -->",
      moduleSlug: null,
    });
    expect(r.tool).toBe("set_content_instance_values_many");
  });

  it("sends a page property no page type declares to the page types and the module (#1561)", () => {
    const r = renderRepairOf({ reason: "page-prop-unknown:stnad", moduleSlug: "hilfe-kopf" });
    expect(r.tool).toBe("list_page_types");
    expect(r.hint).toContain(
      '{{page.props.stnad}} (or {{props.stnad}} in a list of pages) in module "hilfe-kopf"',
    );
    expect(r.hint).toContain("update_modules_many");
    expect(r.hint).toContain("upsert_page_types_many");
    // The render check truncates a hint at 500 characters.
    expect(r.hint.length).toBeLessThan(500);
  });
});

describe("media the build could not publish (#1600)", () => {
  const mediaFailure = (reason: string) =>
    failure({
      pageTitle: "Getting started",
      pagePath: "/en/help/getting-started",
      blockName: null,
      moduleSlug: null,
      reason,
      line: 'page "getting-started": image /_caelo/media/url-history/webp-800 names size "webp-800", which this image does not have (it has: orig, webp-400)',
    });

  it("names the sizes the image has and the URL to write instead", () => {
    const r = renderRepairOf({
      reason: "media-variant-missing:url-history/webp-800:orig,webp-400",
      moduleSlug: null,
    });
    expect(r.tool).toBe("set_content_instance_values_many");
    expect(r.hint).toContain('/_caelo/media/url-history/webp-800 names size "webp-800"');
    expect(r.hint).toContain("it has: orig, webp-400");
    expect(r.hint).toContain(
      "write /_caelo/media/url-history/webp-400 or /_caelo/media/url-history instead",
    );
    expect(r.hint).toContain("update_modules_many");
    // A size the source is wide enough for (an incomplete ladder) is
    // repaired by regenerating it, not by pointing the page elsewhere.
    expect(r.hint).toContain(
      "regenerate_media_variants makes a size the source is wide enough for",
    );
  });

  it("sends an image the library does not have to find_media", () => {
    const r = renderRepairOf({ reason: "media-missing:old-logo/orig", moduleSlug: null });
    expect(r.tool).toBe("find_media");
    expect(r.hint).toContain("/_caelo/media/old-logo names no image in the media library");
  });

  it("tells the operator which page shows it, without markers or tool names", () => {
    const r = stagedRenderReport(
      [mediaFailure("media-variant-missing:url-history/webp-800:orig,webp-400")],
      1,
    );
    expect(r?.operatorText).toContain(
      "An image points at a size or file the media library does not have — on Getting started (/en/help/getting-started)",
    );
    expect(r?.operatorText).not.toMatch(
      /media-variant-missing|url-history|set_content_instance|site layout/,
    );
    expect(r?.aiText).toContain("image /_caelo/media/url-history/webp-800 names size");
    expect(r?.aiText).toContain("media-variant-missing: set_content_instance_values_many");
  });
});

describe("reference images and share images the build could not publish (#1719)", () => {
  const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const onPage = (reason: string, pageTitle = "Brand guide", pagePath = "/brand") =>
    failure({ pageTitle, pagePath, blockName: null, moduleSlug: null, reason, line: reason });

  it("sends a reference image on a page to find_media, or to marking it a library image", () => {
    const r = renderRepairOf({ reason: "media-reference:brand-guide/webp-800", moduleSlug: null });
    expect(r.tool).toBe("find_media");
    expect(r.hint).toContain("/_caelo/media/brand-guide/webp-800 is a reference image");
    expect(r.hint).toContain("update_modules_many");
    expect(r.hint).toContain("set_media_visibility_many");
    expect(r.hint.length).toBeLessThanOrEqual(500);
  });

  it("repairs a share image at the level that chose it", () => {
    const page = renderRepairOf({ reason: `og-image-missing:page/${ID}`, moduleSlug: null });
    expect(page.tool).toBe("set_page_seo_many");
    expect(page.hint).toContain(`media ${ID}`);
    expect(page.hint).toContain("regenerate_media_variants");
    const site = renderRepairOf({ reason: `og-image-reference:site/${ID}`, moduleSlug: null });
    expect(site.tool).toBe("set_theme_asset");
    expect(site.hint).toContain("socialShare");
    expect(site.hint).toContain("set_media_visibility_many");
    const language = renderRepairOf({
      reason: `og-image-missing:language/${ID}`,
      moduleSlug: null,
    });
    expect(language.tool).toBe("list_plugins");
    expect(language.hint).toContain("set_page_seo_many");
    for (const r of [page, site, language]) expect(r.hint.length).toBeLessThanOrEqual(500);
  });

  it("tells the operator which pages show them, without markers, ids or tool names", () => {
    const r = stagedRenderReport(
      [
        onPage("media-reference:brand-guide/orig"),
        onPage(`og-image-missing:site/${ID}`),
        onPage(`og-image-missing:site/${ID}`, "Pricing", "/pricing"),
        onPage(`og-image-reference:page/${ID}`, "Team", "/team"),
      ],
      4,
    );
    const text = r?.operatorText ?? "";
    expect(text).toContain(
      "An image is a reference image (a guide for making images), which is never published — on Brand guide (/brand)",
    );
    expect(text).toContain(
      "The image shown when the page is shared was deleted or has no image file — on Brand guide (/brand), Pricing (/pricing)",
    );
    expect(text).toContain(
      "The image shown when the page is shared is a reference image, which is never published — on Team (/team)",
    );
    expect(text).not.toMatch(/og-image|media-reference|brand-guide|set_|find_media|0f1e2d3c/);
    expect(r?.aiText).toContain("og-image-missing: set_theme_asset");
  });

  it("a stopped build's next step picks their tools, a share image's by its level", () => {
    const next = describeRenderFailures([
      onPage(`og-image-missing:page/${ID}`, "Team", "/team"),
      onPage(`og-image-missing:site/${ID}`),
      onPage(`og-image-missing:site/${ID}`, "Pricing", "/pricing"),
      onPage("media-reference:brand-guide/orig"),
    ]).nextAction;
    expect(next.tool).toBe("set_theme_asset");
    expect(next.reason).toContain(
      "Tools these repairs need, most needed first: set_theme_asset, set_page_seo_many, find_media.",
    );
  });
});

describe("renderRepairOf — a page key or path the page cannot answer (#1717)", () => {
  it("lists the page's keys for a key it does not have", () => {
    const r = renderRepairOf({ reason: "page-key-unknown:titel", moduleSlug: "hilfe-kopf" });
    expect(r.tool).toBe("update_modules_many");
    expect(r.hint).toContain('{{page.titel}} in module "hilfe-kopf": the page has no key "titel"');
    expect(r.hint).toContain("title, short_title");
    expect(r.hint).toContain("{{page.props.<name>}} (list_page_types)");
    expect(r.hint.length).toBeLessThan(500);
  });

  it("names the property's type and what it answers", () => {
    const text = renderRepairOf({
      reason: "page-path-unknown:props.stand:text",
      moduleSlug: "hilfe-kopf",
    });
    expect(text.tool).toBe("update_modules_many");
    expect(text.hint).toContain("page.props.stand (text) has no paths: write {{page.props.stand}}");
    const link = renderRepairOf({
      reason: "page-path-unknown:props.cta:link|text",
      moduleSlug: null,
    });
    expect(link.hint).toContain(
      "page.props.cta (link or text) answers {{page.props.cta}} and {{page.props.cta.href}}, {{page.props.cta.target}}, {{page.props.cta.title}}",
    );
    const select = renderRepairOf({
      reason: "page-path-unknown:props.layout:select",
      moduleSlug: null,
    });
    expect(select.hint).toContain("or the option flag {{#page.props.layout_<option>}}");
    const terms = renderRepairOf({ reason: "page-path-unknown:terms:terms", moduleSlug: null });
    expect(terms.hint).toContain("{{#page.terms.<vocabulary slug>}}");
    for (const r of [text, link, select, terms]) expect(r.hint.length).toBeLessThan(500);
  });

  it("names the list-of-pages form for a property path, and only there (#1727)", () => {
    const r = renderRepairOf({
      reason: "page-path-unknown:props.stand:text",
      moduleSlug: "latest-news",
    });
    expect(r.hint).toStartWith(
      '{{page.props.stand.…}} (or {{props.stand.…}} in a list of pages, the same paths without "page.") in module "latest-news": page.props.stand (text) has no paths',
    );
    expect(r.hint.length).toBeLessThan(500);
    const key = renderRepairOf({ reason: "page-path-unknown:title:text", moduleSlug: null });
    expect(key.hint).not.toContain("in a list of pages");
  });
});

describe("describeRenderFailures — the next step of a stopped build (#1718)", () => {
  const pageProp = (over: Partial<RenderFailure> = {}) =>
    failure({ reason: "page-prop-unknown:stnad", ...over });
  const media = () =>
    failure({ reason: "media-missing:old-logo/orig", blockName: null, moduleSlug: null });

  it("a link failure still goes to check_links", () => {
    expect(describeRenderFailures([linkFailure()]).nextAction.tool).toBe("check_links");
  });

  it("each kind goes to its own repair tool", () => {
    expect(describeRenderFailures([pageProp()]).nextAction.tool).toBe("list_page_types");
    expect(describeRenderFailures([media()]).nextAction.tool).toBe("find_media");
    expect(
      describeRenderFailures([failure({ reason: "page-key-unknown:titel" })]).nextAction.tool,
    ).toBe("update_modules_many");
  });

  it("several kinds: the most frequent kind's tool, every tool in the reason", () => {
    const next = describeRenderFailures([
      media(),
      pageProp(),
      pageProp({ blockName: "footer" }),
      linkFailure(),
    ]).nextAction;
    expect(next.tool).toBe("list_page_types");
    expect(next.reason).toContain(
      "Tools these repairs need, most needed first: list_page_types, find_media, check_links.",
    );
  });

  it("a render without its context is a Caelo bug: bug_report", () => {
    const next = describeRenderFailures([
      failure({ reason: "list-context-unavailable:menu" }),
    ]).nextAction;
    expect(next.tool).toBe("bug_report");
  });
});

describe("renderRepairOf — a plugin value the host refused (#1729)", () => {
  it("sends the AI to the plugin, with the rule and the field, within the finding's cut", () => {
    const r = renderRepairOf({
      reason: "plugin-value-refused:comments.recent_comments.body:element-script",
      moduleSlug: "latest-comments",
    });
    expect(r.tool).toBe("get_plugin");
    expect(r.hint).toContain(
      'The plugin "comments" handed the page a body value in its list source recent_comments that Caelo refuses (element-script)',
    );
    expect(r.hint).toContain("submit_plugin");
    expect(r.hint.length).toBeLessThan(500);
  });

  it("sends a refusal for where the page puts the value to the markup, never the plugin (#1787)", () => {
    // The real-AI cookie banner: its values were refused by placement, and
    // the hint told the AI to fix the plugin's data, which it cannot.
    const conditional = renderRepairOf({
      reason:
        "plugin-value-refused:consent-manager.consent_categories.key:context-conditional-markup",
      moduleSlug: "cookie-banner",
    });
    expect(conditional.tool).toBe("update_modules_many");
    expect(conditional.hint).toContain(
      'module "cookie-banner" puts the plugin "consent-manager"\'s key value',
    );
    expect(conditional.hint).toContain("<input {{#a}}checked{{/a}}>");
    expect(conditional.hint).not.toContain("plugin's data");
    const open = renderRepairOf({
      reason: "plugin-value-refused:consent-manager.consent_categories.key:context-open-markup",
      moduleSlug: "cookie-banner",
    });
    expect(open.tool).toBe("inspect_page_render");
    expect(open.hint).toContain("endsOutsideContent");
    const slot = renderRepairOf({
      reason: "plugin-value-refused:consent-manager.consent_categories.key:context-slot-placement",
      moduleSlug: "cookie-banner",
    });
    expect(slot.tool).toBe("move_module");
    const handler = renderRepairOf({
      reason: "plugin-value-refused:consent-manager.consent_categories.label:context-event-handler",
      moduleSlug: "cookie-banner",
    });
    expect(handler.tool).toBe("update_modules_many");
    expect(handler.hint).toContain("(context-event-handler)");
    for (const r of [conditional, open, slot, handler]) {
      expect(r.hint.length).toBeLessThan(500);
    }
    // A rule about the value itself still sends the AI to the plugin.
    expect(
      renderRepairOf({
        reason: "plugin-value-refused:consent-manager.consent_categories.label:url-scheme",
        moduleSlug: "cookie-banner",
      }).tool,
    ).toBe("get_plugin");
  });

  it("names the head vocabulary for a refused head entry, and the image rule for a share image", () => {
    const head = renderRepairOf({
      reason: "plugin-value-refused:probe.head-composition.link:rel-stylesheet",
      moduleSlug: null,
    });
    expect(head.tool).toBe("get_plugin");
    expect(head.hint).toContain(
      `The plugin "probe" added a link to the page's head or sitemap that Caelo refuses (rel-stylesheet)`,
    );
    expect(head.hint).toContain("by pageId");
    expect(head.hint.length).toBeLessThan(500);
    const image = renderRepairOf({
      reason: "plugin-value-refused:probe.share-images.image:media-reference",
      moduleSlug: null,
    });
    expect(image.hint).toContain("(media-reference): it must be an existing library image");
    expect(image.hint).toContain("set_page_seo_many");
    expect(image.hint.length).toBeLessThan(500);
  });
});
