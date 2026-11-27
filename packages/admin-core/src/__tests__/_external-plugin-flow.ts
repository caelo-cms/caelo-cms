// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the shared steps of an integration test that installs a
 * runtime-installed plugin the way an Owner does (staged, reviewed,
 * approved, activated) and renders pages with it: one copy for the
 * composition-point tests (link resolve, list resolve, content variants).
 */

import { activateApprovedExternalPlugin } from "@caelo-cms/plugin-host";
import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import { sql } from "drizzle-orm";
import { rawSystemSql } from "./_raw-system-sql.js";

/** The system actor every flow step runs as, unless it acts for an Owner. */
export const FLOW_SYSTEM = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "external-plugin-flow",
};

type Ctx = { actorId: string; actorKind: "system" | "human" | "ai"; requestId: string };

/** A rendered editor preview, as the tests read it. */
export interface FlowPreview {
  readonly html: string;
  readonly missingSlots: string[];
  readonly pluginFailures: { slug: string; point: string; reason: string }[];
}

/** One test file's install-and-render steps; `prefix` names every row it creates. */
export function externalPluginFlow(opts: {
  readonly adapter: () => DatabaseAdapter;
  readonly registry: OperationRegistry;
  readonly prefix: string;
  readonly schemas: readonly string[];
}) {
  const { registry, prefix } = opts;

  async function call(name: string, input: unknown, ctx: Ctx = FLOW_SYSTEM): Promise<unknown> {
    const result = await execute(registry, opts.adapter(), ctx, name, input);
    if (!result.ok) throw new Error(`${name}: ${JSON.stringify(result.error)}`);
    return result.value;
  }

  /** A human Owner who may author content and approve installations. */
  async function owner(): Promise<Ctx & { actorKind: "human" }> {
    const id = crypto.randomUUID();
    await opts.adapter().withAdminTransaction(FLOW_SYSTEM, async (tx) => {
      await tx.execute(
        sql`INSERT INTO actors (id,kind,display_name) VALUES (${id}::uuid,'human','owner')`,
      );
      await tx.execute(
        sql`INSERT INTO users (id,email,password_hash) VALUES (${id}::uuid,${`${id}@example.test`},'test-only')`,
      );
      await tx.execute(
        sql`INSERT INTO user_roles (user_id,role_id) SELECT ${id}::uuid,id FROM roles WHERE name='owner'`,
      );
    });
    return { ...FLOW_SYSTEM, actorId: id, actorKind: "human" as const };
  }

  /** Stage, approve as an Owner and activate an external plugin. */
  async function install(manifest: { requestedCapabilities: string[] }, source: string) {
    const staged = (await call("plugins.stage_installation", { manifest, source })) as {
      installationId: string;
      artifactDigest: string;
    };
    const review = (await call("plugins.list_installations", {})) as {
      installations: { id: string; currentStateDigest: string }[];
    };
    const item = review.installations.find((row) => row.id === staged.installationId);
    if (!item) throw new Error("review missing");
    await call(
      "plugins.approve_installation",
      {
        installationId: staged.installationId,
        artifactDigest: staged.artifactDigest,
        expectedStateDigest: item.currentStateDigest,
        capabilities: manifest.requestedCapabilities,
      },
      await owner(),
    );
    const loaded = await activateApprovedExternalPlugin(staged.installationId);
    if (!loaded.loaded) throw new Error(`activation failed: ${loaded.reason}`);
  }

  /** A layout (with one `content` block, plus `chrome` when given) and a template on it. */
  async function template(chromeHtml?: string): Promise<{ layoutId: string; templateId: string }> {
    const { layoutId } = (await call("layouts.create", {
      slug: `${prefix}-layout`,
      displayName: `${prefix} layout`,
      html: chromeHtml
        ? '<body><caelo-slot name="chrome"></caelo-slot><caelo-slot name="content"></caelo-slot></body>'
        : '<body><caelo-slot name="content"></caelo-slot></body>',
      css: "",
      blocks: [
        ...(chromeHtml ? [{ name: "chrome", displayName: "Chrome", position: 0 }] : []),
        { name: "content", displayName: "Content", position: chromeHtml ? 1 : 0 },
      ],
    })) as { layoutId: string };
    const { templateId } = (await call("templates.create", {
      pageType: "home",
      slug: `${prefix}-tpl`,
      displayName: `${prefix} template`,
      html: '<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>',
      css: "",
      layoutId,
    })) as { templateId: string };
    await call("template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    return { layoutId, templateId };
  }

  /** A draft page with one module of `html` and its `fields` / `values`. */
  async function page(
    templateId: string,
    slug: string,
    html: string,
    fields: unknown[] = [],
    values: Record<string, unknown> = {},
  ): Promise<string> {
    const { pageId } = (await call("pages.build_page", {
      page: {
        slug: `${prefix}-${slug}`,
        title: slug,
        templateId,
        status: "draft",
        pageType: "home",
      },
      modules: [
        {
          blockName: "content",
          displayName: `${prefix} ${slug}`,
          description: "A module of the composition-point test.",
          kind: "content",
          html,
          fields,
          content: { source: "inline", values },
        },
      ],
    })) as { pageId: string };
    return pageId;
  }

  async function preview(pageId: string): Promise<FlowPreview> {
    return (await call("pages.render_preview", { pageId })) as FlowPreview;
  }

  /** The plugins' schemas and the rows this file creates, which outlive the per-file reset. */
  async function dropRows(): Promise<void> {
    await rawSystemSql(async (tx) => {
      for (const schema of opts.schemas) {
        await tx.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      }
      await tx.unsafe(
        `DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE '${prefix}-%')`,
      );
      await tx.unsafe(`DELETE FROM pages WHERE slug LIKE '${prefix}-%'`);
      await tx.unsafe(
        `DELETE FROM layout_modules WHERE layout_id IN (SELECT id FROM layouts WHERE slug LIKE '${prefix}-%')`,
      );
      await tx.unsafe(`DELETE FROM modules WHERE slug LIKE '%${prefix}%'`);
      await tx.unsafe(
        `DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE '${prefix}-%')`,
      );
      await tx.unsafe(`DELETE FROM templates WHERE slug LIKE '${prefix}-%'`);
      await tx.unsafe(`DELETE FROM layouts WHERE slug LIKE '${prefix}-%'`);
    });
  }

  return { call, owner, install, template, page, preview, dropRows };
}
