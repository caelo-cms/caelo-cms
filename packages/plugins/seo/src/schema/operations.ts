// SPDX-License-Identifier: MPL-2.0

/**
 * The schema mapping's operations (#1756): the structured-data point's
 * answer, and the AI's two tools to read and set the mapping of every page
 * type in one call each.
 */

import {
  type PluginContextTier1,
  type PluginToolSpec,
  type StructuredDataArgs,
  z,
} from "@caelo-cms/plugin-sdk";
import {
  MAPPINGS_TABLE,
  type MappingRow,
  mappingOfRow,
  mappingProblems,
  type PropertyInfo,
  type SchemaMapping,
  schemaMappingSchema,
  sourcesOf,
} from "./mapping.js";
import { structuredDataAnswer } from "./nodes.js";
import { sitemapEntriesAnswer } from "./sitemaps.js";
import { SCHEMA_TYPE_NAMES, SCHEMA_TYPES } from "./types.js";

type Ctx = PluginContextTier1;

/** The structured-data point's operation (`structuredDataOperation`). */
export const STRUCTURED_DATA_OPERATION = "structured_data";

/** Most page types a site has: the mappings are read in one call. */
const MAX_MAPPINGS = 500;

function adminQueryOf(ctx: Ctx) {
  if (!ctx.adminQuery)
    throw new Error("seo: its private storage grant (cms_admin_schema) is missing");
  return ctx.adminQuery;
}

function cmsOf(ctx: Ctx) {
  if (!ctx.cms) throw new Error("seo: reading the site's page types needs the cms_admin grant");
  return ctx.cms;
}

/** Every stored mapping, by page type slug, as the call's branch sees it. */
export async function readMappings(ctx: Ctx): Promise<Map<string, SchemaMapping>> {
  const rows = await adminQueryOf(ctx).list<typeof MAPPINGS_TABLE, MappingRow>(MAPPINGS_TABLE, {
    limit: MAX_MAPPINGS,
  });
  return new Map(rows.map((r) => [r.page_type, mappingOfRow(r)]));
}

/** What core sends the point; checked at the boundary like any argument. */
const structuredDataArgs = z
  .object({
    pages: z.array(z.object({ pageId: z.string(), pageType: z.string() }).passthrough()),
    related: z.array(z.object({ pageId: z.string(), pageType: z.string() }).passthrough()),
    pageTypes: z.record(
      z.string(),
      z.object({
        properties: z.array(z.object({ name: z.string(), type: z.string() }).passthrough()),
      }),
    ),
    site: z.object({ organization: z.boolean(), name: z.string().nullable() }).strict(),
  })
  .strict();

/** The structured-data answer for one call. */
export async function structuredData(ctx: Ctx, raw: unknown) {
  const args = structuredDataArgs.parse(raw) as unknown as StructuredDataArgs;
  const mappings = await readMappings(ctx);
  return structuredDataAnswer({ args, mappings });
}

/** The sitemap-entries point's operation (`sitemapEntriesOperation`). */
export const SITEMAP_ENTRIES_OPERATION = "sitemap_entries";

/** The news and video sitemap entries for one call (#1761). */
export async function sitemapEntries(ctx: Ctx, raw: unknown) {
  const args = structuredDataArgs.parse(raw) as unknown as StructuredDataArgs;
  const mappings = await readMappings(ctx);
  return sitemapEntriesAnswer({ args, mappings }, new Date());
}

interface PageTypeRow {
  readonly slug: string;
  readonly name: string;
  readonly purpose: string;
  readonly collection: boolean;
  readonly properties: readonly PropertyInfo[];
}

async function pageTypes(ctx: Ctx): Promise<PageTypeRow[]> {
  const r = await cmsOf(ctx).call<{ counts: boolean }, { pageTypes: PageTypeRow[] }>(
    "page_types.list",
    { counts: false },
  );
  return r.pageTypes;
}

/** The roles a mapping leaves unset that the type's rich result recommends, as hints. */
function hintsOf(mapping: SchemaMapping, type: PageTypeRow): string[] {
  const spec = SCHEMA_TYPES[mapping.schemaType];
  if (!spec) return [];
  const hints: string[] = [];
  if (spec.builder === "article" && sourcesOf(mapping.roles.authors).length === 0) {
    hints.push(
      `${type.slug}: no authors mapped. Google reads author per article; add a \`page\` property (multiple, pageType of the author pages) and map it as "authors".`,
    );
  }
  if (spec.builder === "profile" && sourcesOf(mapping.roles.same_as).length === 0) {
    hints.push(
      `${type.slug}: no profile links mapped. sameAs (LinkedIn, a personal site) ties the person to their other profiles; add link properties and map them as "same_as".`,
    );
  }
  return hints;
}

/** The type table as the AI reads it. */
function schemaTypesView() {
  return SCHEMA_TYPE_NAMES.map((name) => {
    const spec = SCHEMA_TYPES[name];
    return {
      name,
      use: spec?.use ?? "",
      roles: Object.fromEntries(
        Object.entries(spec?.roles ?? {}).map(([role, r]) => [
          role,
          {
            accepts: r.accepts,
            ...(r.multiple ? { multiple: true } : {}),
            ...(r.default ? { default: r.default } : {}),
            description: r.description,
          },
        ]),
      ),
    };
  });
}

/** `get_schema_mapping`: every page type with its mapping, and the types it can have. */
export async function getSchemaMapping(ctx: Ctx, raw: unknown) {
  z.object({})
    .strict()
    .parse(raw ?? {});
  const [types, mappings] = await Promise.all([pageTypes(ctx), readMappings(ctx)]);
  return {
    pageTypes: types.map((t) => ({
      slug: t.slug,
      name: t.name,
      purpose: t.purpose,
      collection: t.collection,
      properties: t.properties.map((p) => ({ name: p.name, type: p.type })),
      mapping: mappings.get(t.slug) ?? null,
    })),
    schemaTypes: schemaTypesView(),
  };
}

const setInput = z.object({ mappings: z.array(schemaMappingSchema).min(1).max(100) }).strict();

/**
 * `set_schema_mappings_many`: check every mapping against its page type's
 * properties and the type table, then store them all (or none): a draft
 * change of the chat, live with Publish live.
 */
export async function setSchemaMappings(ctx: Ctx, raw: unknown) {
  const { mappings } = setInput.parse(raw);
  const types = new Map((await pageTypes(ctx)).map((t) => [t.slug, t]));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const m of mappings) {
    if (seen.has(m.pageType)) problems.push(`${m.pageType}: named twice in this call`);
    seen.add(m.pageType);
    const type = types.get(m.pageType);
    if (!type) {
      problems.push(
        `${m.pageType}: no page type of that slug (page types: ${[...types.keys()].join(", ") || "none"})`,
      );
      continue;
    }
    if (m.schemaType === "none") continue;
    for (const p of mappingProblems(m, type.properties)) problems.push(`${m.pageType}: ${p}`);
  }
  if (problems.length > 0) {
    throw new Error(`set_schema_mappings_many stored nothing: ${problems.join("; ")}`);
  }
  const q = adminQueryOf(ctx);
  const stored = await readMappings(ctx);
  const rows = await q.list<typeof MAPPINGS_TABLE, MappingRow>(MAPPINGS_TABLE, {
    limit: MAX_MAPPINGS,
  });
  const hints: string[] = [];
  for (const m of mappings) {
    if (m.schemaType === "none") {
      const row = rows.find((r) => r.page_type === m.pageType);
      if (row) await q.delete(MAPPINGS_TABLE, row.id);
      stored.delete(m.pageType);
      continue;
    }
    await q.upsert(
      MAPPINGS_TABLE,
      { page_type: m.pageType },
      { schema_type: m.schemaType, roles: m.roles },
    );
    stored.set(m.pageType, m);
    const type = types.get(m.pageType);
    if (type) hints.push(...hintsOf(m, type));
  }
  return {
    mappings: [...stored.values()].sort((a, b) => a.pageType.localeCompare(b.pageType)),
    ...(hints.length > 0 ? { hints } : {}),
    note: "Draft change of this chat: the structured data follows at the next Stage and goes live with Publish live.",
  };
}

/** The schema mapping's tools. */
export const SCHEMA_TOOLS: readonly PluginToolSpec[] = [
  {
    name: "get_schema_mapping",
    description:
      "Every page type with the schema type its pages get in structured data (JSON-LD) and where each value comes from, plus the schema types the seo plugin writes with their roles.\nUSE FOR: before set_schema_mappings_many; answering what structured data a kind of page has.\nDO NOT USE FOR: one page's rendered JSON-LD (inspect_page_render).",
    operationName: "get_schema_mapping",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "set_schema_mappings_many",
    description:
      "Set the structured-data mapping of page types, all in one call: which schema type their pages are (BlogPosting, ProfilePage, CollectionPage …) and which page property feeds each role. Checked against each page type's properties before anything is stored; a draft change, live with Publish live.\nUSE FOR: giving articles authors and dates, author pages Person markup, overview pages CollectionPage; after creating a page type.\nDO NOT USE FOR: the page head (set_page_seo_many) or page properties themselves (upsert_page_types_many).\nCORE RULES: Values come from what the page shows: map a role only to a property a module on the page displays. A role's source is `prop:<property name>` or a core field: title, short_title, description, share_image, organization (the site's own). Roles per schema type: get_schema_mapping.",
    operationName: "set_schema_mappings_many",
    requiredPermission: "content.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["mappings"],
      properties: {
        mappings: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["pageType", "schemaType"],
            properties: {
              pageType: { type: "string", description: "The page type's slug." },
              schemaType: {
                type: "string",
                enum: [...SCHEMA_TYPE_NAMES, "none"],
                description:
                  "`none` removes the mapping: the type's pages get core's WebPage only.",
              },
              roles: {
                type: "object",
                description:
                  'Role → source, e.g. {"authors":"prop:authors","reviewer":"prop:reviewed_by","reviewed_on":"prop:last_reviewed"}; a multiple role takes a list ({"same_as":["prop:linkedin","prop:website"]}). Unset roles use their default.',
                additionalProperties: {
                  anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                },
              },
            },
          },
        },
      },
    },
  },
];
