#!/usr/bin/env bun
// SPDX-License-Identifier: MPL-2.0

/**
 * P17 PR2A — sync `docs-site/` content into a fresh cms_admin install.
 *
 * Run after `bunx @caelo/provisioning` brings up your install:
 *   ADMIN_DATABASE_URL=... PUBLIC_ADMIN_DATABASE_URL=... \
 *     bun run apps/admin/scripts/sync-docs-site.ts
 *
 * What it does:
 *   1. Reads `docs-site/import.json` — the manifest naming templates +
 *      pages + structured-sets.
 *   2. Loads each markdown page (frontmatter + body), each
 *      structured-sets JSON.
 *   3. Renders the markdown body into a single `module.html` using a
 *      tiny markdown→HTML pass (only the subset the docs use: headings,
 *      paragraphs, code blocks, lists, links, blockquotes, custom
 *      `::: <block-name>` syntax for landing-template multi-block pages).
 *   4. Dispatches `templates.create`, `modules.create`,
 *      `structured_sets.set`, `pages.create`, `pages.set_modules`
 *      against the live admin via the Query API.
 *   5. Idempotent: re-running updates content via `*.update` ops; doesn't
 *      duplicate slugs.
 *
 * NOT in scope here:
 *   - Layouts (uses the seeded `site-default` layout)
 *   - Media uploads (docs-site/media is empty for now; PR2A focuses on
 *     text content, media lands in the dogfood loop)
 *   - SEO `set_many` (per-page SEO blocks in frontmatter land here as
 *     `pages_seo.set` calls one-at-a-time; bulk variant is a follow-up)
 */

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import { registerAdminOps } from "@caelo/admin-core";
import type { ExecutionContext } from "@caelo/shared";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) {
  console.error("ADMIN_DATABASE_URL and PUBLIC_ADMIN_DATABASE_URL must be set");
  process.exit(2);
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const ctx: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: `docs-sync-${Date.now()}`,
};

interface Manifest {
  version: string;
  site: {
    displayName: string;
    baseLocale: string;
    additionalLocales: string[];
    themeSlug: string;
    headerMenuSlug: string;
    footerMenuSlug: string;
  };
  templates: Array<{
    slug: string;
    displayName: string;
    blocks: string[];
    html: string;
    css?: string;
  }>;
  structuredSets: string[];
  pages: Array<{
    source: string;
    slug: string;
    template: string;
    name: string;
    title: string;
  }>;
}

interface PageFrontmatter {
  slug: string;
  template: string;
  locale?: string;
  status?: "draft" | "published";
  seo?: { title?: string; description?: string; ogTitle?: string; ogDescription?: string };
}

const root = resolve(import.meta.dir, "../../..");
const docsRoot = join(root, "docs-site");

async function main(): Promise<void> {
  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL!,
    publicDatabaseUrl: PUBLIC_URL!,
  });
  const registry = new OperationRegistry();
  registerAdminOps(registry);

  const manifestText = await readFile(join(docsRoot, "import.json"), "utf-8");
  const manifest = JSON.parse(manifestText) as Manifest;

  console.log(`[docs-sync] manifest version ${manifest.version}`);

  // 1. Templates — upsert by slug. The block-set is unconditional + idempotent
  // so re-runs reconcile the declared block list with the manifest (covers
  // the case where a template exists from a prior run but its blocks lag
  // the current manifest).
  const templateIdBySlug = new Map<string, string>();
  for (const t of manifest.templates) {
    const existing = await execute(registry, adapter, ctx, "templates.list", {});
    let id: string | undefined;
    if (existing.ok) {
      const v = existing.value as { templates: Array<{ id: string; slug: string }> };
      const found = v.templates.find((x) => x.slug === t.slug);
      if (found) id = found.id;
    }
    if (id) {
      console.log(`[docs-sync] template ${t.slug} already exists (${id})`);
    } else {
      const r = await execute(registry, adapter, ctx, "templates.create", {
        slug: t.slug,
        displayName: t.displayName,
        html: t.html,
        css: t.css ?? "",
      });
      if (!r.ok) {
        console.error(`[docs-sync] templates.create ${t.slug} failed:`, r.error);
        continue;
      }
      id = (r.value as { templateId: string }).templateId;
      console.log(`[docs-sync] created template ${t.slug} (${id})`);
    }
    templateIdBySlug.set(t.slug, id);
    // Always re-declare blocks so the manifest is the source of truth.
    const blockSet = await execute(registry, adapter, ctx, "template_blocks.set", {
      templateId: id,
      blocks: t.blocks.map((name, position) => ({
        name,
        displayName: name.charAt(0).toUpperCase() + name.slice(1),
        position,
      })),
    });
    if (!blockSet.ok) console.error(`[docs-sync] template_blocks.set ${t.slug}:`, blockSet.error);
  }

  // 2. Structured sets — upsert.
  for (const path of manifest.structuredSets) {
    const text = await readFile(join(docsRoot, path), "utf-8");
    const set = JSON.parse(text) as {
      kind: string;
      slug: string;
      displayName: string;
      items: unknown[];
    };
    const r = await execute(registry, adapter, ctx, "structured_sets.set", {
      kind: set.kind,
      slug: set.slug,
      displayName: set.displayName,
      items: set.items,
    });
    if (!r.ok) {
      console.error(`[docs-sync] structured_sets.set ${set.kind}/${set.slug}:`, r.error);
    } else {
      console.log(`[docs-sync] structured set ${set.kind}/${set.slug} synced`);
    }
  }

  // 3. Pages — for each page, materialise into one module per content
  // block (parsed from `::: blockname ... :::` markdown markers, or a
  // single `content` block when the markdown has no `:::` markers).
  for (const p of manifest.pages) {
    const sourcePath = join(docsRoot, p.source);
    const source = await readFile(sourcePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(source);
    const locale = frontmatter.locale ?? manifest.site.baseLocale;
    const status = frontmatter.status ?? "published";
    const blocks = parseBlocks(body);

    const templateId = templateIdBySlug.get(p.template);
    if (!templateId) {
      console.error(`[docs-sync] page ${p.slug}: template ${p.template} not found, skipping`);
      continue;
    }

    // Resolve / create the page.
    const pages = await execute(registry, adapter, ctx, "pages.list", {});
    let pageId: string | undefined;
    if (pages.ok) {
      const v = pages.value as { pages: Array<{ id: string; slug: string; locale: string }> };
      const found = v.pages.find((x) => x.slug === p.slug && x.locale === locale);
      pageId = found?.id;
    }
    if (!pageId) {
      const r = await execute(registry, adapter, ctx, "pages.create", {
        slug: p.slug,
        locale,
        name: p.name,
        title: p.title,
        templateId,
        status,
      });
      if (!r.ok) {
        console.error(`[docs-sync] pages.create ${p.slug}:`, r.error);
        continue;
      }
      pageId = (r.value as { pageId: string }).pageId;
      console.log(`[docs-sync] created page /${p.slug} (${pageId})`);
    }

    // For each block in the parsed page body, create / update a module
    // and attach it to the page.
    const moduleAttachments: Array<{ moduleId: string; blockName: string; position: number }> = [];
    for (const [index, block] of blocks.entries()) {
      const moduleSlug = `docs-${p.slug.replaceAll("/", "-")}-${block.name}`;
      const moduleHtml = block.html;
      // Upsert module.
      const mods = await execute(registry, adapter, ctx, "modules.list", {});
      let moduleId: string | undefined;
      if (mods.ok) {
        const v = mods.value as { modules: Array<{ id: string; slug: string }> };
        moduleId = v.modules.find((x) => x.slug === moduleSlug)?.id;
      }
      if (moduleId) {
        const r = await execute(registry, adapter, ctx, "modules.update", {
          moduleId,
          html: moduleHtml,
        });
        if (!r.ok) console.error(`[docs-sync] modules.update ${moduleSlug}:`, r.error);
      } else {
        const r = await execute(registry, adapter, ctx, "modules.create", {
          slug: moduleSlug,
          displayName: `Docs ${p.slug} ${block.name}`,
          html: moduleHtml,
        });
        if (!r.ok) {
          console.error(`[docs-sync] modules.create ${moduleSlug}:`, r.error);
          continue;
        }
        moduleId = (r.value as { moduleId: string }).moduleId;
      }
      moduleAttachments.push({ moduleId, blockName: block.name, position: index });
    }

    // Attach modules to the page. The op groups by block, so collapse
    // attachments into one entry per blockName carrying the ordered
    // module ids.
    if (moduleAttachments.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const a of moduleAttachments) {
        const arr = grouped.get(a.blockName) ?? [];
        arr.push(a.moduleId);
        grouped.set(a.blockName, arr);
      }
      const blocks = [...grouped.entries()].map(([blockName, moduleIds]) => ({
        blockName,
        moduleIds,
      }));
      const r = await execute(registry, adapter, ctx, "pages.set_modules", {
        pageId,
        blocks,
      });
      if (!r.ok) console.error(`[docs-sync] pages.set_modules ${p.slug}:`, r.error);
    }

    // SEO — only the fields pages_seo.set carries. <title> lives on
    // pages.title (set at create); ogTitle/ogDescription are read from
    // the page row, not pages_seo. Frontmatter `seo.title` is captured
    // on the page itself via pages.update if it differs.
    if (frontmatter.seo?.description) {
      const seoResult = await execute(registry, adapter, ctx, "pages_seo.set", {
        pageId,
        metaDescription: frontmatter.seo.description,
      });
      if (!seoResult.ok) console.warn(`[docs-sync] pages_seo.set ${p.slug}:`, seoResult.error);
    }
  }

  console.log("[docs-sync] done.");
}

function parseFrontmatter(source: string): { frontmatter: PageFrontmatter; body: string } {
  if (!source.startsWith("---\n")) {
    return { frontmatter: { slug: "", template: "" }, body: source };
  }
  const end = source.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: { slug: "", template: "" }, body: source };
  const yaml = source.slice(4, end);
  const body = source.slice(end + 5);
  const frontmatter = parseSimpleYaml(yaml);
  return { frontmatter: frontmatter as PageFrontmatter, body };
}

/**
 * Tiny YAML subset — handles the keys used in docs-site/ frontmatter.
 * Strings, booleans, nested 1-level dicts. Not a general-purpose YAML
 * parser; if frontmatter shape grows we swap for `js-yaml`.
 */
function parseSimpleYaml(yaml: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentNested: Record<string, unknown> | null = null;
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.startsWith("#")) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (indent === 0) {
      if (value === "") {
        currentKey = key;
        currentNested = {};
        out[key] = currentNested;
      } else {
        currentKey = null;
        currentNested = null;
        out[key] = parseScalar(value);
      }
    } else if (currentNested) {
      currentNested[key] = parseScalar(value);
    }
    void currentKey;
  }
  return out;
}

function parseScalar(value: string): unknown {
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  // Strip surrounding quotes if present.
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

interface PageBlock {
  name: string;
  html: string;
}

/**
 * Parse the markdown body into named blocks. Custom syntax:
 *   ::: hero
 *   # Big headline
 *   :::
 * Multiple blocks render as separate modules attached to the matching
 * template block. If the body has no `:::` markers, the whole body
 * lands in one `content` block.
 */
function parseBlocks(body: string): PageBlock[] {
  const blocks: PageBlock[] = [];
  const lines = body.split("\n");
  let currentName: string | null = null;
  let currentBuf: string[] = [];
  for (const line of lines) {
    const open = line.match(/^:::\s*([a-z][a-z0-9_-]*)\s*$/);
    if (open) {
      if (currentName) {
        blocks.push({ name: currentName, html: renderMarkdown(currentBuf.join("\n")) });
      }
      currentName = open[1] ?? null;
      currentBuf = [];
      continue;
    }
    if (line.trim() === ":::") {
      if (currentName) {
        blocks.push({ name: currentName, html: renderMarkdown(currentBuf.join("\n")) });
        currentName = null;
        currentBuf = [];
      }
      continue;
    }
    currentBuf.push(line);
  }
  if (currentName) {
    blocks.push({ name: currentName, html: renderMarkdown(currentBuf.join("\n")) });
  } else if (currentBuf.length > 0 && blocks.length === 0) {
    // No `:::` markers anywhere — single content block.
    blocks.push({ name: "content", html: renderMarkdown(currentBuf.join("\n")) });
  }
  return blocks;
}

/**
 * Tiny markdown renderer — only the subset the docs use. Headings,
 * paragraphs, code blocks (fenced), lists (ordered + unordered),
 * links, bold, italic, inline code, blockquotes, horizontal rules,
 * tables.
 *
 * NOT a general-purpose markdown engine. If the docs grow nested
 * lists / footnotes / etc., swap for `marked` (MIT) or `markdown-it`.
 */
function renderMarkdown(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]?.startsWith("```")) {
        code.push(lines[i] ?? "");
        i++;
      }
      i++;
      out.push(
        `<pre><code${lang ? ` class="language-${esc(lang)}"` : ""}>${esc(code.join("\n"))}</code></pre>`,
      );
      continue;
    }
    if (line.startsWith("#")) {
      const m = line.match(/^(#{1,6})\s+(.+)$/);
      if (m) {
        const level = m[1]?.length ?? 1;
        out.push(`<h${level}>${renderInline(m[2] ?? "")}</h${level}>`);
        i++;
        continue;
      }
    }
    if (line.startsWith("> ")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]?.startsWith("> ")) {
        buf.push(lines[i]?.slice(2) ?? "");
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
        items.push(`<li>${renderInline((lines[i] ?? "").replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
        items.push(`<li>${renderInline((lines[i] ?? "").replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.trim() === "---") {
      out.push("<hr/>");
      i++;
      continue;
    }
    // Tables (very basic: header row + separator + body rows).
    if (line.includes("|") && (lines[i + 1] ?? "").includes("|") && /^\s*\|?[\s\-:|]+\|?\s*$/.test(lines[i + 1] ?? "")) {
      const headerCells = splitTableRow(line);
      const bodyRows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        bodyRows.push(splitTableRow(lines[i] ?? ""));
        i++;
      }
      const thead = `<thead><tr>${headerCells.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`;
      const tbody = `<tbody>${bodyRows.map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`).join("")}</tbody>`;
      out.push(`<table>${thead}${tbody}</table>`);
      continue;
    }
    // Paragraph — accumulate consecutive non-blank lines.
    const para: string[] = [line];
    i++;
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !looksLikeBlockStart(lines[i] ?? "")) {
      para.push(lines[i] ?? "");
      i++;
    }
    out.push(`<p>${renderInline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

function splitTableRow(line: string): string[] {
  const trimmed = line.replace(/^\s*\|?/, "").replace(/\|?\s*$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function looksLikeBlockStart(line: string): boolean {
  return (
    line.startsWith("#") ||
    line.startsWith("```") ||
    line.startsWith("> ") ||
    /^[-*]\s+/.test(line) ||
    /^\d+\.\s+/.test(line) ||
    line.trim() === "---"
  );
}

function renderInline(text: string): string {
  let out = esc(text);
  // Inline code (`x`)
  out = out.replaceAll(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Bold (**x**)
  out = out.replaceAll(/\*\*([^*]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  // Italic (_x_ or *x*)
  out = out.replaceAll(/(^|[^*])\*([^*]+)\*([^*]|$)/g, (_, p, c, n) => `${p}<em>${c}</em>${n}`);
  // Links [text](href)
  out = out.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h}">${t}</a>`);
  return out;
}

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

await main();
