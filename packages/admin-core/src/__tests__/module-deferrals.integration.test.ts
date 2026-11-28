// SPDX-License-Identifier: MPL-2.0

/**
 * #450 — a plugin withholds a module, end to end through the real
 * preview op.
 *
 * The failure modes here are the interesting part. Every branch that
 * could quietly render the withheld module instead throws, because
 * "the gate did not apply" is indistinguishable from "there was no
 * gate" in the output — and the difference is a third-party request
 * that has already left the browser by the time anyone notices.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  MAIN_RENDER,
  resetPluginHost,
  resolveModuleDeferrals,
} from "@caelo-cms/plugin-host";
import { definePlugin } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { withheldNestedSuffix } from "../ai/tools/_withheld-nested-guard.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t450",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let videoModuleId = "";
let templateId = "";
/** The markup the gate was last asked about, per module (#1708). */
const askedHtml = new Map<string, string>();

/** What the fixture plugin currently withholds. Mutated per test. */
let verdicts: Record<string, Record<string, unknown>> = {};
/** #1729 — answer for every verdict, asked or not (the "not asked about" case). */
let answerAll = false;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe(`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't450-%')
    )`);
    await tx.unsafe(
      "DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug LIKE 't450-%')",
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM modules WHERE slug LIKE 't450-%'");
    await tx.unsafe("DELETE FROM modules WHERE display_name LIKE 't450 nested %'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();

  const tpl = await execute(registry, adapter, SYS_CTX, "templates.create", {
    pageType: "home",
    slug: "t450-tpl",
    displayName: "T450",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(JSON.stringify(tpl.error));
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYS_CTX, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const page = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug: "t450-page",
    title: "Gated",
    templateId,
  });
  if (!page.ok) throw new Error(JSON.stringify(page.error));
  pageId = (page.value as { pageId: string }).pageId;

  const video = await execute(registry, adapter, SYS_CTX, "modules.create", {
    slug: "t450-video",
    displayName: "Video",
    html: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
    css: "",
    js: "",
    fields: [],
  });
  if (!video.ok) throw new Error(JSON.stringify(video.error));
  videoModuleId = (video.value as { moduleId: string }).moduleId;

  const placeholder = await execute(registry, adapter, SYS_CTX, "modules.create", {
    slug: "t450-placeholder",
    displayName: "Consent placeholder",
    html: '<div class="ph"><p>{{notice}}</p><button data-consent-accept>OK</button></div>',
    css: ".ph{border:1px dashed}",
    js: "",
    fields: [{ name: "notice", kind: "text", label: "Notice", default: "Please allow cookies" }],
  });
  if (!placeholder.ok) throw new Error(JSON.stringify(placeholder.error));

  const set = await execute(registry, adapter, SYS_CTX, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds: [videoModuleId] }],
  });
  if (!set.ok) throw new Error(JSON.stringify(set.error));

  const gate = definePlugin({
    slug: "t450-gate",
    version: "0.1.0",
    tier: 1,
    schema: {},
    requestedCapabilities: ["client_assets"],
    deferralsOperation: "deferrals",
    deferralPlaceholders: {
      allow: {
        html: '<div data-t450-default><p>Loads with consent to {{label}}.</p><button data-consent-grant="{{key}}">Allow</button></div>',
        css: ".t450d{}",
      },
      notice: {
        html: "<div data-t450-notice>Hidden from visitors: {{hosts}}</div>",
        css: ".t450n{}",
      },
    },
    operations: {
      deferrals: async (_ctx, args) => {
        if (answerAll) return { deferrals: verdicts };
        const { moduleIds, modules } = args as {
          moduleIds: string[];
          modules: { moduleId: string; html: string }[];
        };
        for (const m of modules) askedHtml.set(m.moduleId, m.html);
        const out: Record<string, unknown> = {};
        for (const id of moduleIds) {
          const v = verdicts[id];
          if (v) out[id] = v;
        }
        return { deferrals: out };
      },
    },
  });
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: gate }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

interface NestedFixture {
  pageId: string;
  frameModuleId: string;
  videoModuleId: string;
  videoInstanceId: string;
}
let nestedFixture: NestedFixture | null = null;

/** #1708 — a page whose frame module holds a video module in its `embed` field. */
async function nestedPage(): Promise<NestedFixture> {
  if (nestedFixture) return nestedFixture;
  const r = await execute(registry, adapter, SYS_CTX, "pages.build_page", {
    page: { slug: "t450-nested", title: "Nested", templateId },
    modules: [
      {
        ref: "video",
        displayName: "t450 nested video",
        description: "A product video.",
        kind: "content",
        html: '<iframe src="https://www.youtube.com/embed/nested" title="{{video_title}}"></iframe>',
        fields: [{ name: "video_title", kind: "text", label: "Title" }],
        content: { source: "inline", values: { video_title: "Tour" } },
      },
      {
        blockName: "content",
        displayName: "t450 nested frame",
        description: "A section with a heading and an embedded video.",
        kind: "content",
        html: "<section><h2>{{heading}}</h2>{{>embed}}</section>",
        fields: [
          { name: "heading", kind: "text", label: "Heading" },
          { name: "embed", kind: "module", label: "Video" },
        ],
        content: {
          source: "inline",
          values: { heading: "Watch the tour", embed: { $ref: "video" } },
        },
      },
    ],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const v = r.value as {
    pageId: string;
    detached: { ref: string; moduleId: string; contentInstanceId: string }[];
  };
  const video = v.detached.find((d) => d.ref === "video");
  if (!video) throw new Error("nested video missing");
  const frame = await sqlSystem(
    (tx) => tx`SELECT id::text AS id FROM modules WHERE display_name = 't450 nested frame'`,
  );
  const frameId = (frame[0] as { id: string } | undefined)?.id;
  if (!frameId) throw new Error("frame module missing");
  nestedFixture = {
    pageId: v.pageId,
    frameModuleId: frameId,
    videoModuleId: video.moduleId,
    videoInstanceId: video.contentInstanceId,
  };
  return nestedFixture;
}

async function renderPage(): Promise<string> {
  const r = await execute(registry, adapter, SYS_CTX, "pages.render_preview", { pageId });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { html: string }).html;
}

/** The video module as the render pass hands it to the gate. */
function videoCandidate() {
  return { moduleId: videoModuleId, html: "", css: "", js: "", fields: [], contentValues: [] };
}

describe("#450 — module deferrals through the preview op", () => {
  it("renders the module normally when the plugin withholds nothing", async () => {
    verdicts = {};
    const html = await renderPage();
    expect(html).toContain("youtube.com");
    expect(html).not.toContain("data-caelo-deferred");
  });

  it("swaps in the placeholder and parks the embed in a template", async () => {
    verdicts = {
      [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    const html = await renderPage();

    expect(html).toContain('data-caelo-deferred="t450-gate"');
    expect(html).toContain('data-reason="marketing"');
    // The placeholder rendered from its own field default, like the
    // ordinary module it is.
    expect(html).toContain("Please allow cookies");
    expect(html).toContain(".ph{border:1px dashed}");
    // The embed survives only inside the inert template.
    expect(html.indexOf("youtube.com")).toBeGreaterThan(
      html.indexOf("<template data-caelo-deferred-content>"),
    );
  });

  it("fails LOUDLY when the placeholder module does not exist", async () => {
    // Falling back to the real module would issue exactly the request
    // the gate exists to prevent — the least acceptable silent recovery
    // in this codebase (CLAUDE.md §2).
    verdicts = { [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-nope" } };
    expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
      /does not exist/,
    );
  });

  it("renders the plugin's built-in placeholder when the site has not designed one", async () => {
    // A site whose placeholder module was never created must still
    // render the page — the withheld module stays withheld.
    verdicts = {
      [videoModuleId]: {
        reason: "marketing",
        placeholderModuleSlug: "t450-nope",
        placeholder: { name: "allow", values: { label: "Marketing", key: "marketing" } },
      },
    };
    const html = await renderPage();
    expect(html).toContain("data-t450-default");
    expect(html).toContain('data-consent-grant="marketing"');
    expect(html).toContain("Loads with consent to Marketing.");
    expect(html).toContain(".t450d{}");
    expect(html.indexOf("youtube.com")).toBeGreaterThan(
      html.indexOf("<template data-caelo-deferred-content>"),
    );
  });

  it("shows an omitted module's editor notice in the preview, never its content", async () => {
    verdicts = {
      [videoModuleId]: {
        reason: "unclassified",
        omit: true,
        editorNotice: { name: "notice", values: { hosts: "youtube.com" } },
      },
    };
    const html = await renderPage();
    expect(html).toContain("<div data-t450-notice>Hidden from visitors: youtube.com</div>");
    expect(html).toContain(".t450n{}");
    // The host's name is the notice's text; the embed itself is gone.
    expect(html).not.toContain("youtube.com/embed");
  });

  it("gives a build nothing for an omitted module", async () => {
    // The notice is for the operator; a visitor gets no placeholder they
    // could not act on, and no parked copy nothing would ever release.
    verdicts = {
      [videoModuleId]: {
        reason: "unclassified",
        omit: true,
        editorNotice: { name: "notice", values: { hosts: "youtube.com" } },
      },
    };
    const resolved = await resolveModuleDeferrals([videoCandidate()], MAIN_RENDER);
    expect(resolved.get(videoModuleId)).toEqual({
      pluginSlug: "t450-gate",
      reason: "unclassified",
      omit: true,
      editorNotice: null,
    });
  });

  it("rejects an omit verdict without an editor notice", async () => {
    verdicts = { [videoModuleId]: { reason: "unclassified", omit: true } };
    expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
      /invalid verdict/,
    );
  });

  it("rejects a verdict whose reason is not a plain key", async () => {
    verdicts = {
      [videoModuleId]: { reason: "Marketing Cookies!", placeholderModuleSlug: "t450-placeholder" },
    };
    expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
      /invalid verdict/,
    );
  });

  // #1729 — a verdict carries data, never markup (§6.7), for every plugin.
  it("escapes a verdict's text: a value cannot become markup on the page", async () => {
    verdicts = {
      [videoModuleId]: {
        reason: "marketing",
        placeholderModuleSlug: "t450-nope",
        placeholder: {
          name: "allow",
          values: { label: "<script>steal()</script>", key: '"><img src=x onerror=a()>' },
        },
      },
    };
    const resolved = await resolveModuleDeferrals([videoCandidate()], MAIN_RENDER);
    const html = (resolved.get(videoModuleId) as { placeholderHtml: string }).placeholderHtml;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    expect(html).toContain('data-consent-grant="&quot;&gt;&lt;img src=x onerror=a()&gt;"');
  });

  it("refuses markup in a verdict (the shape before #1729)", async () => {
    verdicts = {
      [videoModuleId]: {
        reason: "marketing",
        placeholderModuleSlug: "t450-nope",
        defaultPlaceholder: { html: "<script>steal()</script>", css: "" },
      },
    };
    expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
      /invalid verdict/,
    );
  });

  it("refuses a placeholder the manifest does not declare", async () => {
    verdicts = {
      [videoModuleId]: {
        reason: "marketing",
        placeholderModuleSlug: "t450-nope",
        placeholder: { name: "elsewhere", values: {} },
      },
    };
    expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
      /names placeholder "elsewhere".*does not declare/,
    );
  });

  it("refuses values that do not fill the placeholder's slots", async () => {
    verdicts = {
      [videoModuleId]: {
        reason: "marketing",
        placeholderModuleSlug: "t450-nope",
        placeholder: { name: "allow", values: { label: "Marketing", extra: "x" } },
      },
    };
    expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
      /missing: key; not a slot of it: extra/,
    );
  });

  it("refuses a verdict for a module the render did not ask about", async () => {
    const other = "00000000-0000-4000-8000-0000000000ff";
    verdicts = {
      [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
      [other]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    answerAll = true;
    try {
      expect(resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).rejects.toThrow(
        new RegExp(`answered for module ${other}, which was not asked about`),
      );
    } finally {
      answerAll = false;
    }
  });

  // #1708 — a withheld module inside another module's `module` field. The
  // build used to stop on it (a ComposeError that failed every Stage of the
  // site) while this preview judged the PARENT on its rendered HTML, embed
  // included, and withheld the whole section. Now both leave the nested
  // module out and report it; the parent is judged on what it shows.
  it("leaves a withheld nested module out of the preview and flags it, and judges the parent without it", async () => {
    const nested = await nestedPage();
    verdicts = {
      [nested.videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    const r = await execute(registry, adapter, SYS_CTX, "pages.render_preview", {
      pageId: nested.pageId,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { html, missingSlots } = r.value as { html: string; missingSlots: string[] };
    const marker = `nested-module-withheld:${nested.videoModuleId}/t450-gate/marketing`;
    expect(missingSlots).toContain(marker);
    expect(html).toContain(`<!-- caelo:missing reason=${marker} -->`);
    // Nothing of the embed reaches the editor's browser either.
    expect(html).not.toContain("youtube.com");
    // The frame is not withheld: the visitor sees its text, not a placeholder.
    expect(html).toContain("Watch the tour");
    expect(html).not.toContain("data-caelo-deferred");
    // The plugin was asked about the parent as it shows: without the embed.
    expect(askedHtml.get(nested.frameModuleId)).not.toContain("youtube.com");
  });

  it("renders the nested module as usual when the plugin withholds nothing", async () => {
    const nested = await nestedPage();
    verdicts = {};
    const r = await execute(registry, adapter, SYS_CTX, "pages.render_preview", {
      pageId: nested.pageId,
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const { html, missingSlots } = r.value as { html: string; missingSlots: string[] };
    expect(html).toContain("youtube.com/embed/nested");
    expect(missingSlots.some((m) => m.startsWith("nested-module-withheld:"))).toBe(false);
  });

  it("tells the AI at once when a write nests a withheld module (write tools' hint)", async () => {
    const nested = await nestedPage();
    const written = [
      {
        heading: "Watch the tour",
        embed: { moduleId: nested.videoModuleId, contentInstanceId: nested.videoInstanceId },
      },
    ];
    verdicts = {
      [nested.videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    const hint = await withheldNestedSuffix(SYS_CTX, { registry, adapter }, written);
    expect(hint).toContain(`(${nested.videoModuleId}) is in a field of the module you wrote`);
    expect(hint).toContain('plugin "t450-gate" withholds it until visitors consent (marketing)');
    expect(hint).toContain("add_module");
    // Nothing withheld, or no nested ref: nothing to say.
    verdicts = {};
    expect(await withheldNestedSuffix(SYS_CTX, { registry, adapter }, written)).toBe("");
    expect(
      await withheldNestedSuffix(SYS_CTX, { registry, adapter }, [{ heading: "Only text" }]),
    ).toBe("");
  });

  it("costs nothing when no plugin declares deferrals", async () => {
    verdicts = {
      [videoModuleId]: { reason: "marketing", placeholderModuleSlug: "t450-placeholder" },
    };
    resetPluginHost();
    expect(await resolveModuleDeferrals([videoCandidate()], MAIN_RENDER)).toEqual(new Map());
  });
});
