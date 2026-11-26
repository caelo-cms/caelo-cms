// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 (decision Q7 A) — the host half of declared URL slots
 * (`urlTables`, plugin-sdk url-tables.ts; docs/dev/external-plugin-brokers.md
 * §6.8).
 *
 * Core composes `pages.current_path` inside the write that changes it, and
 * a sandboxed plugin cannot answer there (dispatch.ts, #1254). A plugin that
 * declares its `host` / `path-prefix` slots as tables therefore never runs
 * on the URL path: this module
 *
 * - reads the two tables itself while core composes ({@link readDeclaredUrlAnnotations}),
 *   through the plugin's own storage handle on the render's branch, joined
 *   to the composing transaction — so a chat's pending rows shape the
 *   chat's view, as an in-process URL plugin's do;
 * - checks what it read before anything composes with it (a segment is a
 *   page slug and not reserved, a host is one this install serves, every
 *   value maps one way only, every shaped page names a value that exists)
 *   and refuses loudly otherwise — a URL composed from a substituted value
 *   would be materialised and served;
 * - builds the pure encode/decode pair the composition grammar calls
 *   ({@link declaredUrlContributions});
 * - guards every write to the tables ({@link checkUrlTableWrite}): only an
 *   Owner-approved call changes them, and the change is refused when it
 *   would collide with a page, reach a host this install does not serve or
 *   leave a page naming a value that no longer exists.
 */

import type {
  PluginAdminQuery,
  PluginContext,
  PluginInvocation,
  PluginUrlTables,
  UrlComposePage,
  UrlContributionDef,
} from "@caelo-cms/plugin-sdk";
import { RESERVED_URL_SEGMENTS, URL_TABLE_MAX_VALUES } from "@caelo-cms/plugin-sdk";
import { execute, joinHeldTransaction } from "@caelo-cms/query-api";
import {
  hostInfra,
  hostSystemActorId,
  makeInvocationContext,
  type RenderScope,
  renderInvocation,
} from "./dispatch.js";

/** What one value of a plugin's `values` table puts into an address. */
export interface DeclaredUrlValue {
  readonly id: string;
  readonly value: string;
  readonly segment: string | null;
  readonly host: string | null;
}

/** The page annotation key under which the host hands a declared plugin's value to its encoders. */
export function declaredUrlAnnotationKey(pluginSlug: string): string {
  return `caelo:urlTables:${pluginSlug}`;
}

/** Same shape as a page slug (`slugSchema`): no dot, slash, `%`, `_`, capital or control character. */
const SEGMENT_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
/** A bare lowercase host name: no scheme, port, user or trailing dot. */
const HOST_NAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const VALUE_RE = /^[^\s\p{Cc}]{1,64}$/u;

/** Why `segment` cannot lead a page's path, or null when it can. */
export function urlSegmentIssue(segment: string): string | null {
  if (!SEGMENT_RE.test(segment)) {
    return `"${escapeForMessage(segment)}" is not a path segment: use 1-64 lowercase letters, digits and inner hyphens, like a page slug (no ".", "/", "%", "_" or spaces)`;
  }
  if (RESERVED_URL_SEGMENTS.has(segment)) {
    return `"/${segment}" is reserved for the site's own services; choose another segment`;
  }
  return null;
}

/** Why `host` cannot carry pages of this install, or null when it can. */
export function urlHostIssue(host: string, served: ReadonlySet<string>): string | null {
  if (!HOST_NAME_RE.test(host)) {
    return `"${escapeForMessage(host)}" is not a host name: write it bare and lowercase, like de.example.com (no scheme, port, path or user)`;
  }
  if (!served.has(host)) {
    return `"${host}" is not a domain this install serves, so pages there would point their canonical and alternates at someone else's site. Add the domain first (propose_add_domain), then set it here`;
  }
  return null;
}

function escapeForMessage(raw: string): string {
  return JSON.stringify(raw).slice(1, -1).slice(0, 80);
}

/**
 * What is wrong with a `values` table as a whole: each value once, and each
 * segment and host claimed by one value only — that is what lets an
 * address be read back as the value that made it.
 */
export function declaredValuesProblems(values: ReadonlyArray<DeclaredUrlValue>): string[] {
  const problems: string[] = [];
  const seen = {
    value: new Map<string, string>(),
    segment: new Map<string, string>(),
    host: new Map<string, string>(),
  };
  for (const v of values) {
    if (!VALUE_RE.test(v.value)) {
      problems.push(`value "${escapeForMessage(v.value)}" must be 1-64 characters without spaces`);
    }
    for (const [kind, key] of [
      ["value", v.value],
      ["segment", v.segment],
      ["host", v.host],
    ] as const) {
      if (key === null) continue;
      const other = seen[kind].get(key);
      if (other !== undefined) {
        problems.push(
          kind === "value"
            ? `value "${key}" has two rows; keep one`
            : `values "${other}" and "${v.value}" both claim the ${kind} "${key}"; an address must name one value`,
        );
      } else seen[kind].set(key, v.value);
    }
  }
  return problems;
}

/**
 * Encode/decode for the slots `tables` fills. Encode reads the value the
 * host attached to the page ({@link readDeclaredUrlAnnotations}); a page
 * without one keeps the site's own shape. Decode needs the values table,
 * which is data: core finds pages by `pages.current_path`, and a caller
 * that must decode passes the values to `decodePagePath`.
 */
export function declaredUrlContributions(
  pluginSlug: string,
  tables: PluginUrlTables,
): UrlContributionDef[] {
  const key = declaredUrlAnnotationKey(pluginSlug);
  const pageValue = (page: UrlComposePage): DeclaredUrlValue | undefined =>
    page.annotations[key] as DeclaredUrlValue | undefined;
  const needsValues = (): never => {
    throw new Error(
      `url-composition: "${pluginSlug}" declares its URL slots as data (urlTables); pass its values to decodePagePath (readDeclaredUrlValues), or find the page by pages.current_path`,
    );
  };
  const out: UrlContributionDef[] = [];
  if (tables.values.hostColumn !== undefined) {
    out.push({
      slot: "host",
      encode: (page) => pageValue(page)?.host ?? null,
      decode: needsValues,
    });
  }
  if (tables.values.segmentColumn !== undefined) {
    out.push({
      slot: "path-prefix",
      encode: (page) => {
        const segment = pageValue(page)?.segment;
        return segment ? [segment] : [];
      },
      decode: needsValues,
    });
  }
  return out;
}

/**
 * Invert a declared `path-prefix`: does the path's first segment belong to
 * one of `values`? Pure; the inverse of the encode above.
 */
export function decodeDeclaredPrefix(
  segments: ReadonlyArray<string>,
  values: ReadonlyArray<DeclaredUrlValue>,
): { consumed: number; annotations: { value: string } } | null {
  const head = segments[0];
  if (head === undefined) return null;
  const match = values.find((v) => v.segment === head);
  return match ? { consumed: 1, annotations: { value: match.value } } : null;
}

function storageOf(ctx: PluginContext, pluginSlug: string): PluginAdminQuery {
  const q = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!q) {
    throw new Error(
      `url-composition: plugin "${pluginSlug}" declares urlTables but cannot read its private storage on a render — it needs the cms_admin_schema grant`,
    );
  }
  return q;
}

/**
 * The plugin's `values` table as the given storage handle sees it,
 * checked row by row. Refuses a table past {@link URL_TABLE_MAX_VALUES}
 * rather than composing with the first page of it.
 */
export async function readDeclaredUrlValues(
  q: Pick<PluginAdminQuery, "list">,
  pluginSlug: string,
  tables: PluginUrlTables,
): Promise<DeclaredUrlValue[]> {
  const t = tables.values;
  const rows = await q.list(t.table, {
    orderBy: "id",
    orderDir: "asc",
    limit: URL_TABLE_MAX_VALUES + 1,
  });
  if (rows.length > URL_TABLE_MAX_VALUES) {
    throw new Error(
      `url-composition: plugin "${pluginSlug}" keeps more than ${URL_TABLE_MAX_VALUES} values in ${t.table}; a URL table holds at most ${URL_TABLE_MAX_VALUES}`,
    );
  }
  return rows.map((r) => {
    const text = (col: string | undefined): string | null => {
      if (col === undefined) return null;
      const v = r[col];
      if (v === null || v === undefined || v === "") return null;
      if (typeof v !== "string") {
        throw new Error(`url-composition: ${pluginSlug}.${t.table}.${col} holds a non-text value`);
      }
      return v;
    };
    const value = text(t.valueColumn);
    if (value === null) {
      throw new Error(
        `url-composition: a row of ${pluginSlug}.${t.table} has no ${t.valueColumn}; every value row names its value`,
      );
    }
    return { id: String(r.id), value, segment: text(t.segmentColumn), host: text(t.hostColumn) };
  });
}

/**
 * The public hosts this install serves: the site's base URL and every
 * public domain. Read through the core operations, joined to whatever
 * transaction the caller holds.
 */
export async function servedPublicHosts(): Promise<ReadonlySet<string>> {
  const infra = hostInfra();
  const ctx = {
    actorId: hostSystemActorId(),
    actorKind: "system" as const,
    requestId: "url-tables-served-hosts",
  };
  return joinHeldTransaction(async () => {
    const seo = await execute(infra.registry, infra.adapter, ctx, "site_defaults.get_seo", {});
    const domains = await execute(infra.registry, infra.adapter, ctx, "domains.list", {});
    if (!seo.ok || !domains.ok) {
      throw new Error(
        `url-composition: could not read the domains this install serves (${!seo.ok ? seo.error.kind : ""}${!domains.ok ? ` ${domains.error.kind}` : ""})`,
      );
    }
    const hosts = new Set<string>();
    const base = (seo.value as { siteBaseUrl: string | null }).siteBaseUrl;
    if (base) hosts.add(new URL(base).hostname.toLowerCase());
    for (const d of (domains.value as { domains: { hostname: string; kind: string }[] }).domains) {
      if (d.kind === "public") hosts.add(d.hostname.toLowerCase());
    }
    return hosts;
  });
}

/** Page ids per read: one row per page, and each read returns at most 1000 rows. */
const PAGES_PER_READ = 500;

/**
 * Every given page's declared URL value, from the plugin's two tables on
 * `scope`'s branch, as the annotation the encoders read. Loud
 * (no-fallbacks): a page with two rows, a page naming a value with no row,
 * a value whose segment or host is unusable, or two values claiming one
 * address throws, naming the row to fix — a composed path is
 * materialised and served, so it must never come from a guess.
 */
export async function readDeclaredUrlAnnotations(
  pluginSlug: string,
  tables: PluginUrlTables,
  pageIds: ReadonlyArray<string>,
  scope: RenderScope,
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (pageIds.length === 0) return out;
  const q = storageOf(await makeInvocationContext(pluginSlug, renderInvocation(scope)), pluginSlug);
  // Joined to the composing transaction (#1254): the reads see its
  // uncommitted writes and take no second connection.
  return joinHeldTransaction(async () => {
    const values = await readDeclaredUrlValues(q, pluginSlug, tables);
    const problems = declaredValuesProblems(values);
    const hosts = values.some((v) => v.host !== null)
      ? await servedPublicHosts()
      : new Set<string>();
    for (const v of values) {
      const issue =
        (v.segment !== null ? urlSegmentIssue(v.segment) : null) ??
        (v.host !== null ? urlHostIssue(v.host, hosts) : null);
      if (issue) problems.push(`value "${v.value}": ${issue}`);
    }
    if (problems.length > 0) {
      throw new Error(
        `url-composition: plugin "${pluginSlug}" has URL values core cannot compose (${tables.values.table}): ${problems.join("; ")}. Fix the rows with an Owner-approved call of the plugin.`,
      );
    }
    const byValue = new Map(values.map((v) => [v.value, v]));
    const t = tables.pages;
    const ids = [...new Set(pageIds)];
    for (let i = 0; i < ids.length; i += PAGES_PER_READ) {
      const chunk = ids.slice(i, i + PAGES_PER_READ);
      const rows = await q.list(t.table, {
        anyOf: { page_id: chunk },
        limit: 1000,
      });
      for (const r of rows) {
        const pageId = String(r.page_id);
        if (out.has(pageId)) {
          throw new Error(
            `url-composition: page ${pageId} has two rows in ${pluginSlug}.${t.table}; a page names one value — delete one with an Owner-approved call`,
          );
        }
        const raw = r[t.valueColumn];
        const value = typeof raw === "string" ? byValue.get(raw) : undefined;
        if (!value) {
          throw new Error(
            `url-composition: page ${pageId} names value ${JSON.stringify(raw)} in ${pluginSlug}.${t.table}, which ${tables.values.table} does not map. Add the value, or remove the page's row, with an Owner-approved call`,
          );
        }
        out.set(pageId, { [declaredUrlAnnotationKey(pluginSlug)]: value });
      }
    }
    return out;
  });
}

/** Which of a plugin's declared URL tables `table` is, or null. */
export function urlTableRole(
  tables: PluginUrlTables | undefined,
  table: string,
): "pages" | "values" | null {
  if (!tables) return null;
  if (table === tables.pages.table) return "pages";
  if (table === tables.values.table) return "values";
  return null;
}

/** One write a storage handle is about to make to a table. */
export interface UrlTableWrite {
  readonly method: string;
  readonly table: string;
  /** The row's id, for a write that names one (update, delete, compareAndSwap). */
  readonly id?: string;
  /** An upsert's key: the row it replaces is the one these columns match. */
  readonly key?: Readonly<Record<string, unknown>>;
  /** The columns written (insert data, update patch, upsert key + values). */
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * The checks a write to a declared URL table passes before it reaches
 * storage, for every plugin (principle 1 of the design: the rule lives in
 * the handle). `list` reads the plugin's own tables in the writer's scope.
 *
 * - Only an Owner-approved call (`origin: "approved"`) may write: a URL
 *   table changes the address of every page it names (CLAUDE.md §11.A).
 * - A segment must be a page-slug-shaped, unreserved segment no page of
 *   the writer's view already answers at; a host one this install serves;
 *   neither may be claimed by another value.
 * - A page's row must name an existing value, and a value still named by a
 *   page cannot be removed or renamed.
 */
export async function checkUrlTableWrite(opts: {
  readonly pluginSlug: string;
  readonly tables: PluginUrlTables;
  readonly invocation: PluginInvocation;
  readonly write: UrlTableWrite;
  readonly list: PluginAdminQuery["list"];
}): Promise<void> {
  const { pluginSlug, tables, invocation, write, list } = opts;
  const role = urlTableRole(tables, write.table);
  if (role === null) return;
  const where = `ctx.adminQuery.${write.method}: table "${write.table}" of plugin "${pluginSlug}"`;
  if (invocation.origin !== "approved") {
    throw new Error(
      `${where} shapes page addresses (urlTables.${role}), so it changes only in a call the Owner approved. Write it from a tool with approvalMode: "user-approval" (the Owner sees the change on the card); existing pages then move to their new addresses, with 301 redirects, through propose_url_migration.`,
    );
  }
  if (write.method === "updateMany" || write.method === "compareAndSwap") {
    throw new Error(
      `${where} shapes page addresses; change its rows one at a time with insert, update, upsert or delete, so each change is checked against the pages it moves`,
    );
  }
  const values = await readDeclaredUrlValues({ list }, pluginSlug, tables);
  const data = write.data ?? {};
  if (role === "pages") {
    const named = data[tables.pages.valueColumn];
    if (named !== undefined && !values.some((v) => v.value === named)) {
      throw new Error(
        `${where}: value ${JSON.stringify(named)} is not in ${tables.values.table}; add the value first`,
      );
    }
    return;
  }
  const t = tables.values;
  const current = await replacedValue(write, values, () =>
    list(t.table, { orderBy: "id", orderDir: "asc", limit: URL_TABLE_MAX_VALUES + 1 }),
  );
  const removes =
    write.method === "delete" ||
    (current !== undefined && t.valueColumn in data && data[t.valueColumn] !== current.value);
  if (removes && current !== undefined) {
    const using = await list(tables.pages.table, {
      [tables.pages.valueColumn]: current.value,
      limit: 1,
    });
    if (using.length > 0) {
      throw new Error(
        `${where}: value "${current.value}" still shapes the address of page ${String(using[0]?.page_id)} (and maybe more); give those pages another value or remove their rows first, so no page is left naming a value that does not exist`,
      );
    }
  }
  if (write.method === "delete") return;
  const next: DeclaredUrlValue = {
    id: current?.id ?? write.id ?? "",
    value: String(data[t.valueColumn] ?? current?.value ?? ""),
    segment: nextText(data, t.segmentColumn, current?.segment ?? null),
    host: nextText(data, t.hostColumn, current?.host ?? null),
  };
  // Every other row stays: a second row with a value, segment or host
  // already taken is refused here, not found by the next composition.
  const rest = values.filter((v) => v.id !== next.id);
  const problems = declaredValuesProblems([...rest, next]);
  if (next.segment !== null) {
    const issue = urlSegmentIssue(next.segment);
    if (issue) problems.push(issue);
    else {
      const holder = await pageAt(`/${next.segment}`, invocation);
      if (holder !== null && !(await shapedBy(list, tables, holder, next.value))) {
        problems.push(
          `"/${next.segment}" is already the address of a page (${holder}); a value's home there would collide with it — choose another segment, or rename that page`,
        );
      }
    }
  }
  if (next.host !== null) {
    const issue = urlHostIssue(next.host, await servedPublicHosts());
    if (issue) problems.push(issue);
  }
  if (problems.length > 0) throw new Error(`${where}: ${problems.join("; ")}`);
}

/**
 * The values row `write` replaces: the one its id names, or the first by
 * id whose columns match its upsert key, which is the row the upsert
 * updates (private-upsert.ts); none for an insert, or an upsert that
 * inserts. The key is matched over the table's rows in memory: a values
 * table holds at most {@link URL_TABLE_MAX_VALUES} rows, and its key
 * columns need not be indexed.
 */
async function replacedValue(
  write: UrlTableWrite,
  values: ReadonlyArray<DeclaredUrlValue>,
  rowsById: () => Promise<ReadonlyArray<Record<string, unknown>>>,
): Promise<DeclaredUrlValue | undefined> {
  if (write.id !== undefined) return values.find((v) => v.id === write.id);
  const key = write.key;
  if (write.method !== "upsert" || key === undefined) return undefined;
  const row = (await rowsById()).find((r) =>
    Object.entries(key).every(([column, v]) => r[column] === v),
  );
  return row === undefined ? undefined : values.find((v) => v.id === String(row.id));
}

function nextText(
  data: Readonly<Record<string, unknown>>,
  column: string | undefined,
  current: string | null,
): string | null {
  if (column === undefined || !(column in data)) return current;
  const v = data[column];
  if (v === null || v === "") return null;
  if (typeof v !== "string") throw new Error(`urlTables: ${column} takes text or null`);
  return v;
}

/** The page answering at `path` in the writer's view, or null. */
async function pageAt(path: string, invocation: PluginInvocation): Promise<string | null> {
  const infra = hostInfra();
  const r = await execute(
    infra.registry,
    infra.adapter,
    {
      actorId: hostSystemActorId(),
      actorKind: "system",
      requestId: "url-tables-collision",
      ...(invocation.chatBranchId ? { chatBranchId: invocation.chatBranchId } : {}),
    },
    "pages.list",
    { paths: [path], limit: 1 },
  );
  if (!r.ok) throw new Error(`urlTables: could not look up ${path}: ${r.error.kind}`);
  return (r.value as { pages: { id: string }[] }).pages[0]?.id ?? null;
}

/** Whether page `pageId` is shaped by `value` — then its address at the segment is its own. */
async function shapedBy(
  list: PluginAdminQuery["list"],
  tables: PluginUrlTables,
  pageId: string,
  value: string,
): Promise<boolean> {
  const rows = await list(tables.pages.table, { page_id: pageId, limit: 1 });
  return rows[0]?.[tables.pages.valueColumn] === value;
}
