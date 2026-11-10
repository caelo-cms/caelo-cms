// SPDX-License-Identifier: MPL-2.0

/**
 * P6.7.5 — the redirect store; #1550 — redirects are draft state
 * (`redirects/model.ts` has the model, docs/dev/redirects-and-settings-sync.md
 * the behaviour).
 *
 * Every write here saves a PENDING change of an address: Staged by default
 * (staging serves it within seconds, the live site with the Publish live
 * that ships it), or Draft with `goLive: "later"` (served nowhere). None of
 * them changes the live site; Go live now (`redirects_go_live.ts`) is the
 * one path past Publish live, a human step.
 *
 * A write by a plugin (the `international-site` locale-root redirect) is an
 * automatic change: always Staged, live with the next Publish live. Page
 * writes do not call these ops; they write their automatic changes through
 * the same writer (`writeRedirectChanges`).
 *
 * #1358 — a target on another domain never comes through these ops: it is
 * approval-gated (redirects_pending.ts) and the target checks here refuse it.
 * Deleting one, or replacing it with a same-site target, stays routine.
 */

import {
  defineOperation,
  type ErrorDetail,
  handlerErrorFromDetails,
  type TransactionRunner,
  textArray,
  uuidArray,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  ok,
  redirectAddress,
  redirectTargetIssue,
  redirectTargetPathSchema,
} from "@caelo-cms/shared";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import {
  addressesOf,
  ownerOfContext,
  PENDING_COLUMNS,
  type PendingDbRow,
  pendingRowOf,
  stateOfGoLive,
} from "../redirects/model.js";
import {
  describeReplaced,
  type RedirectChangeInput,
  type RedirectChangeOutcome,
  writeRedirectChanges,
} from "../redirects/write.js";

/**
 * #1461 — a static file owns its URL. The refusal for redirects that would
 * start at one, or null. The build would leave such a row out silently.
 */
export async function staticFileRedirectRefusal(
  tx: TransactionRunner,
  fromPaths: readonly string[],
): Promise<string | null> {
  const bare = fromPaths.map((p) => (p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p));
  const rows = (await tx.execute(sql`
    SELECT path FROM static_files WHERE path = ANY(${textArray(bare)}) AND deleted_at IS NULL
  `)) as unknown as { path: string }[];
  if (rows.length === 0) return null;
  return `A static file is served at ${rows.map((r) => r.path).join(", ")}, so a redirect cannot start there. Choose another path, or remove the file first (propose_delete_static_files).`;
}

/**
 * Why a same-site rule `fromPath` → `toPath` cannot be saved, or null: an
 * unsafe target (#657), one address on both sides, a static file's path.
 * Every writer of a same-site rule asks here, also the page ops that call
 * no redirect op (a delete's dead-URL 301, a URL migration).
 */
export async function redirectWriteIssue(
  tx: TransactionRunner,
  fromPath: string,
  toPath: string,
): Promise<string | null> {
  const targetIssue = redirectTargetIssue(toPath);
  if (targetIssue) return targetIssue;
  if (redirectAddress(fromPath) === redirectAddress(toPath)) {
    return "from_path and to_path must differ";
  }
  return staticFileRedirectRefusal(tx, [fromPath]);
}

const statusCodeSchema = z.union([
  z.literal(301),
  z.literal(302),
  z.literal(307),
  z.literal(308),
  z.literal(410),
]);

/** #1550 — when a manual save goes live; the default stages it. */
export const redirectGoLiveSchema = z.enum(["next_publish", "later"]);

/** What a write did to one address, as the ops return it. */
const changeOutcomeSchema = z.object({
  fromPath: z.string(),
  /** `pending`: saved as a pending change. `unchanged`: equals the live rule, nothing pending. */
  outcome: z.enum(["pending", "unchanged"]),
  state: z.enum(["draft", "staged"]).nullable(),
  /** The pending change as saved (id and revision): what Go live now right after binds to. */
  changeId: z.string().nullable(),
  revision: z.number().int().nullable(),
  /** The pending change this one replaced (and the chat that made it), as one line. */
  replaced: z.string().nullable(),
});

function outcomeOf(o: RedirectChangeOutcome): z.infer<typeof changeOutcomeSchema> {
  return {
    fromPath: o.fromPath,
    outcome: o.outcome,
    state: o.state,
    changeId: o.changeId,
    revision: o.revision,
    replaced: describeReplaced(o),
  };
}

/**
 * How a caller's write is stored: a plugin's is automatic (always Staged,
 * live with the next Publish live), everyone else's is manual.
 */
function originOfCaller(ctx: ExecutionContext): "manual" | "plugin" {
  return ctx.actorKind === "plugin" ? "plugin" : "manual";
}

/**
 * The rules of the pending view at `addresses`: each address that answers
 * now or will, with the from-path spellings it is stored under (a pending
 * change's, or the live rows' when nothing is pending there).
 */
async function pendingViewAddresses(
  tx: TransactionRunner,
  addresses: readonly string[],
): Promise<Map<string, string[]>> {
  if (addresses.length === 0) return new Map();
  const list = textArray([...addresses]);
  const rows = (await tx.execute(sql`
    SELECT r.address, r.from_path FROM redirects r
    WHERE r.address = ANY(${list})
      AND NOT EXISTS (
        SELECT 1 FROM pending_redirects p WHERE p.address = r.address
      )
    UNION ALL
    SELECT p.address, p.from_path FROM pending_redirects p
    WHERE p.address = ANY(${list}) AND p.to_path IS NOT NULL
    ORDER BY 2
  `)) as unknown as { address: string; from_path: string }[];
  const view = new Map<string, string[]>();
  for (const r of rows) view.set(r.address, [...(view.get(r.address) ?? []), r.from_path]);
  return view;
}

export const createRedirectOp = defineOperation({
  name: "redirects.create",
  readScope: "request",
  // `plugin`: a URL-contributing plugin owns URL shapes core cannot derive —
  // `international-site` writes the `/<default locale>` → `/` 301 when it
  // prefixes the default locale. #1550 — its write is an automatic change
  // (Staged, live with the next Publish live).
  actorScope: ["human", "ai", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      fromPath: z.string().min(1).max(500).regex(/^\//, "must start with /"),
      // #657 — a same-site path only: no `//host`, no `/https://…`.
      toPath: redirectTargetPathSchema,
      statusCode: statusCodeSchema.default(301),
      /** #1550 — `next_publish` (default) saves it Staged, `later` as a Draft. */
      goLive: redirectGoLiveSchema.default("next_publish"),
    })
    .strict(),
  output: z.object({
    /** The pending change, or the live rule it already equals. */
    redirectId: z.string(),
    change: changeOutcomeSchema,
  }),
  handler: async (ctx, input, tx) => {
    const issue = await redirectWriteIssue(tx, input.fromPath, input.toPath);
    if (issue) return err({ kind: "HandlerError", operation: "redirects.create", message: issue });
    const origin = originOfCaller(ctx);
    if (origin !== "manual" && input.goLive === "later") {
      return err({
        kind: "HandlerError",
        operation: "redirects.create",
        message:
          "a plugin's redirect goes live with the next Publish live; omit goLive (a Draft is a person's choice)",
      });
    }
    const [outcome] = await writeRedirectChanges(
      tx,
      [{ fromPath: input.fromPath, toPath: input.toPath, statusCode: input.statusCode }],
      {
        origin,
        state: stateOfGoLive(input.goLive),
        owner: await ownerOfContext(tx, ctx),
      },
    );
    if (!outcome) throw new Error("redirects.create: the writer returned no outcome");
    const live = (await tx.execute(sql`
      SELECT id::text AS id FROM redirects
      WHERE address = ${outcome.address} ORDER BY from_path LIMIT 1
    `)) as unknown as { id: string }[];
    const redirectId = outcome.changeId ?? live[0]?.id;
    if (!redirectId) {
      throw new Error(
        `redirects.create: ${outcome.address} has neither a pending change nor a rule`,
      );
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.create",
      input,
      succeeded: true,
      entityId: redirectId,
      resultSummary: `${input.fromPath} → ${input.toPath} (${input.statusCode}) ${outcome.outcome}${outcome.state ? ` ${outcome.state}` : ""}`,
    });
    return ok({ redirectId, change: outcomeOf(outcome) });
  },
});

// ---------------------------------------------------------------------
// The list: every rule (an address with its live rule, its pending change,
// or both), keyset-paged by address (#1538, #1540).
// ---------------------------------------------------------------------

/** #1550 — which rules a list shows. */
export const redirectListStateSchema = z.enum(["all", "live", "staged", "draft"]);

interface RedirectCursor {
  readonly after: string;
  readonly query: string;
  readonly statusCode: number | null;
  readonly state: z.infer<typeof redirectListStateSchema>;
}

function encodeRedirectCursor(c: RedirectCursor): string {
  const payload = ["redirects.list", c.after, c.query, c.statusCode, c.state];
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** A `redirects.list` cursor, or null for anything else. */
function decodeRedirectCursor(cursor: string): RedirectCursor | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      Array.isArray(v) &&
      v.length === 5 &&
      v[0] === "redirects.list" &&
      typeof v[1] === "string" &&
      v[1].startsWith("/") &&
      typeof v[2] === "string" &&
      (v[3] === null || typeof v[3] === "number") &&
      redirectListStateSchema.safeParse(v[4]).success
    ) {
      return { after: v[1], query: v[2], statusCode: v[3], state: v[4] };
    }
  } catch {
    // Not base64url JSON: an unknown cursor.
  }
  return null;
}

/**
 * The address a cursor continues after, or the error detail when it cannot
 * continue this call (not one of ours, or another search's).
 */
function redirectCursorAfter(
  text: string,
  filter: Omit<RedirectCursor, "after">,
): { ok: true; after: string } | { ok: false; detail: ErrorDetail } {
  const cursor = decodeRedirectCursor(text);
  if (cursor === null) {
    return {
      ok: false,
      detail: {
        path: ["cursor"],
        message: "is not a cursor this redirect list returned",
        next: "pass the next cursor exactly as the previous call printed it, or omit it to start at the first page",
      },
    };
  }
  if (
    cursor.query !== filter.query ||
    cursor.statusCode !== filter.statusCode ||
    cursor.state !== filter.state
  ) {
    return {
      ok: false,
      detail: {
        path: ["cursor"],
        message: `continues the list for filter "${cursor.query}", statusCode ${cursor.statusCode ?? "(any)"} and state ${cursor.state}, not this one`,
        next: "send the same filter, statusCode and state as the call that returned it, or omit cursor to start this search at its first page",
      },
    };
  }
  return { ok: true, after: cursor.after };
}

const liveRuleSchema = z.object({
  id: z.string(),
  fromPath: z.string(),
  toPath: z.string(),
  statusCode: z.number().int(),
});

const pendingChangeSchema = z.object({
  id: z.string(),
  /** Binds a Publish live confirmation or a Go live now to this exact change. */
  revision: z.number().int(),
  kind: z.enum(["create", "change", "remove"]),
  fromPath: z.string(),
  /** Null for a removal. */
  toPath: z.string().nullable(),
  statusCode: z.number().int().nullable(),
  state: z.enum(["draft", "staged"]),
  /** `manual`: a person's (or the AI's) choice; else the page write or plugin that caused it. */
  origin: z.enum(["manual", "page_move", "page_delete", "url_migration", "revert", "plugin"]),
  chatSessionId: z.string().nullable(),
  /** True on an isolated branch (an experiment chat): it joins at that chat's Stage. */
  isolated: z.boolean(),
  updatedAt: z.string(),
});

/** One rule of the list: an address with its live rule, its pending change, or both. */
const redirectRuleSchema = z.object({
  /** The live rule's id; for an address with no live rule, the pending change's. */
  id: z.string(),
  address: z.string(),
  /** The rule as it stands once its pending change is live (a removal: the live rule). */
  fromPath: z.string(),
  toPath: z.string(),
  statusCode: z.number().int(),
  /** `live`: no pending change. `staged` / `draft`: the state of its pending change. */
  state: z.enum(["live", "staged", "draft"]),
  live: liveRuleSchema.nullable(),
  change: pendingChangeSchema.nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
});

/** One rule of {@link listRedirectsOp}'s output. */
export type RedirectRule = z.infer<typeof redirectRuleSchema>;

const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : String(v));

interface RuleDbRow {
  address: string;
  live_id: string | null;
  live_from: string | null;
  live_to: string | null;
  live_status: number | null;
  live_by: string | null;
  live_at: string | Date | null;
}

/** The rules of `rows` (addresses) with their pending changes. */
function rulesOf(
  rows: readonly (RuleDbRow & Partial<PendingDbRow> & { p_id: string | null })[],
): RedirectRule[] {
  return rows.map((r) => {
    const live =
      r.live_id !== null && r.live_from !== null && r.live_to !== null && r.live_status !== null
        ? { id: r.live_id, fromPath: r.live_from, toPath: r.live_to, statusCode: r.live_status }
        : null;
    const p =
      r.p_id === null
        ? null
        : pendingRowOf({ ...(r as unknown as PendingDbRow), id: r.p_id, address: r.address });
    const change = p
      ? {
          id: p.id,
          revision: p.revision,
          kind: (p.toPath === null ? "remove" : live === null ? "create" : "change") as
            | "create"
            | "change"
            | "remove",
          fromPath: p.fromPath,
          toPath: p.toPath,
          statusCode: p.statusCode,
          state: p.state,
          origin: p.origin,
          chatSessionId: p.chatSessionId,
          isolated: p.isolated,
          updatedAt: p.updatedAt,
        }
      : null;
    const shown =
      change !== null && change.toPath !== null && change.statusCode !== null
        ? { fromPath: change.fromPath, toPath: change.toPath, statusCode: change.statusCode }
        : live;
    if (shown === null) throw new Error(`redirects.list: ${r.address} has no rule and no change`);
    return {
      id: live?.id ?? change?.id ?? "",
      address: r.address,
      fromPath: shown.fromPath,
      toPath: shown.toPath,
      statusCode: shown.statusCode,
      state: change?.state ?? "live",
      live,
      change,
      createdBy: p?.actorId ?? r.live_by ?? "",
      createdAt: p?.updatedAt ?? (r.live_at === null ? "" : iso(r.live_at)),
    };
  });
}

/** The filter of a list call over `a` (addresses), `r` (live rule) and `p` (pending change). */
function listFilter(input: {
  query: string;
  statusCode: number | null;
  state: z.infer<typeof redirectListStateSchema>;
}): SQL {
  const parts: SQL[] = [];
  if (input.query.length > 0) {
    const like = `%${input.query}%`;
    parts.push(sql`(r.from_path ILIKE ${like} OR r.to_path ILIKE ${like}
                    OR p.from_path ILIKE ${like} OR p.to_path ILIKE ${like})`);
  }
  if (input.statusCode !== null) {
    parts.push(sql`COALESCE(p.status_code, r.status_code) = ${input.statusCode}`);
  }
  if (input.state === "live") parts.push(sql`p.id IS NULL`);
  if (input.state === "staged") parts.push(sql`p.state = 'staged'`);
  if (input.state === "draft") parts.push(sql`p.state = 'draft'`);
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` AND `);
}

/** Rules of the given addresses joined to their live rule and pending change. */
function rulesFromSql(addresses: SQL): SQL {
  return sql`
    FROM (${addresses}) a
    LEFT JOIN LATERAL (
      SELECT id::text AS id, from_path, to_path, status_code, created_by, created_at
      FROM redirects WHERE address = a.address
      ORDER BY from_path LIMIT 1
    ) r ON true
    LEFT JOIN pending_redirects p ON p.address = a.address
  `;
}

const allAddressesSql = sql`
  SELECT address FROM redirects
  UNION
  SELECT address FROM pending_redirects
`;

export const listRedirectsOp = defineOperation({
  name: "redirects.list",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  // P8 AI-first review pass: list takes optional filters so the AI can find
  // redirects without paging through everything. `query` matches against
  // fromPath OR toPath substring (live and pending); `statusCode` narrows to
  // a single status; #1550 `state` to rules with a pending change.
  input: z
    .object({
      query: z.string().max(500).optional(),
      statusCode: statusCodeSchema.optional(),
      /** #1550 — `live`: rules without a pending change; `staged` / `draft`: with one in that state. */
      state: redirectListStateSchema.default("all"),
      limit: z.number().int().positive().max(1000).default(200),
      /**
       * #1538 — `nextCursor` of the previous page: the rules after it,
       * ordered by address. Refused with another `query` / `statusCode` / `state`.
       */
      cursor: z.string().min(1).max(8000).optional(),
    })
    .strict(),
  output: z.object({
    /** Ordered by address (the from path without its trailing slash). */
    redirects: z.array(redirectRuleSchema),
    /** Every rule matching the filters, on all pages. */
    totalCount: z.number().int(),
    nextCursor: z.string().nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const filter = {
      query: input.query ?? "",
      statusCode: input.statusCode ?? null,
      state: input.state,
    };
    let after: string | null = null;
    if (input.cursor !== undefined) {
      const c = redirectCursorAfter(input.cursor, filter);
      if (!c.ok) return err(handlerErrorFromDetails("redirects.list", [c.detail]));
      after = c.after;
    }
    const where = listFilter(filter);
    const afterFilter = after === null ? sql`true` : sql`a.address > ${after}`;
    const fetched = (await tx.execute(sql`
      SELECT a.address, r.id AS live_id, r.from_path AS live_from, r.to_path AS live_to,
             r.status_code AS live_status, r.created_by::text AS live_by, r.created_at AS live_at,
             p.id::text AS p_id, p.from_path, p.to_path, p.status_code, p.state, p.origin,
             p.revision::text AS revision, p.actor_id::text AS actor_id,
             p.chat_session_id::text AS chat_session_id, p.chat_branch_id::text AS chat_branch_id,
             (p.id IS NOT NULL AND NOT (p.chat_branch_id IS NULL
               OR p.chat_branch_id = (SELECT branch_id FROM site_draft WHERE id = 1))) AS isolated,
             p.updated_at
      ${rulesFromSql(allAddressesSql)}
      WHERE ${afterFilter} AND ${where}
      ORDER BY a.address
      LIMIT ${input.limit + 1}
    `)) as unknown as (RuleDbRow & Partial<PendingDbRow> & { p_id: string | null })[];
    const total = (await tx.execute(sql`
      SELECT count(*)::int AS count ${rulesFromSql(allAddressesSql)} WHERE ${where}
    `)) as unknown as { count: number }[];
    const page = fetched.slice(0, input.limit);
    const last = page.at(-1);
    return ok({
      redirects: rulesOf(page),
      totalCount: total[0]?.count ?? 0,
      nextCursor:
        fetched.length > input.limit && last
          ? encodeRedirectCursor({ after: last.address, ...filter })
          : null,
    });
  },
});

/**
 * Resolve a path to its LIVE redirect: what production answers. Used by the
 * SvelteKit hooks fallback on 404 so the smoke / dev server respects the
 * live redirects without Caddy in front.
 */
export const lookupRedirectOp = defineOperation({
  name: "redirects.lookup",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ fromPath: z.string().min(1).max(500) }).strict(),
  output: z.object({
    match: liveRuleSchema.extend({ createdBy: z.string(), createdAt: z.string() }).nullable(),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, from_path, to_path, status_code,
             created_by::text AS created_by, created_at
      FROM redirects WHERE from_path = ${input.fromPath} LIMIT 1
    `)) as unknown as {
      id: string;
      from_path: string;
      to_path: string;
      status_code: number;
      created_by: string;
      created_at: string | Date;
    }[];
    const r = rows[0];
    if (!r) return ok({ match: null });
    return ok({
      match: {
        id: r.id,
        fromPath: r.from_path,
        toPath: r.to_path,
        statusCode: r.status_code,
        createdBy: r.created_by,
        createdAt: iso(r.created_at),
      },
    });
  },
});

/**
 * The addresses behind ids from {@link listRedirectsOp}: a live rule's id or
 * a pending change's. Unknown ids are reported.
 */
async function addressesOfIds(
  tx: TransactionRunner,
  ids: readonly string[],
): Promise<{ addresses: Map<string, string>; unknown: string[] }> {
  if (ids.length === 0) return { addresses: new Map(), unknown: [] };
  const list = uuidArray([...ids]);
  const rows = (await tx.execute(sql`
    SELECT id::text AS id, from_path FROM redirects WHERE id = ANY(${list})
    UNION ALL
    SELECT id::text AS id, from_path FROM pending_redirects WHERE id = ANY(${list})
  `)) as unknown as { id: string; from_path: string }[];
  const addresses = new Map(rows.map((r) => [r.id.toLowerCase(), r.from_path]));
  return {
    addresses,
    unknown: ids.filter((id) => !addresses.has(id.toLowerCase())),
  };
}

/** Removal changes of the addresses of `fromPaths`, one per address. */
/** #1550 — the addresses of `addresses` with a live rule or any pending change, a removal included. */
async function addressesWithRuleOrChange(
  tx: TransactionRunner,
  addresses: readonly string[],
): Promise<Set<string>> {
  if (addresses.length === 0) return new Set();
  const list = textArray([...addresses]);
  const rows = (await tx.execute(sql`
    SELECT address FROM redirects WHERE address = ANY(${list})
    UNION
    SELECT address FROM pending_redirects WHERE address = ANY(${list})
  `)) as unknown as { address: string }[];
  return new Set(rows.map((r) => r.address));
}

function removalsOf(fromPaths: readonly string[]): RedirectChangeInput[] {
  const seen = new Set<string>();
  const out: RedirectChangeInput[] = [];
  for (const p of fromPaths) {
    const a = redirectAddress(p);
    if (seen.has(a)) continue;
    seen.add(a);
    out.push({ fromPath: p, toPath: null, statusCode: null });
  }
  return out;
}

export const deleteRedirectOp = defineOperation({
  name: "redirects.delete",
  readScope: "request",
  // P8 AI-first review pass: AI can manage the redirect lifecycle.
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** A live rule's id or a pending change's (redirects.list `id`). */
      redirectId: z.string().uuid(),
      goLive: redirectGoLiveSchema.default("next_publish"),
    })
    .strict(),
  output: z.object({ change: changeOutcomeSchema }),
  handler: async (ctx, input, tx) => {
    const { addresses, unknown } = await addressesOfIds(tx, [input.redirectId]);
    const fromPath = addresses.get(input.redirectId.toLowerCase());
    if (unknown.length > 0 || fromPath === undefined) {
      return err({
        kind: "HandlerError",
        operation: "redirects.delete",
        message: `no redirect or pending change has id ${input.redirectId}; find_redirects lists them`,
      });
    }
    const [outcome] = await writeRedirectChanges(tx, removalsOf([fromPath]), {
      origin: "manual",
      state: stateOfGoLive(input.goLive),
      owner: await ownerOfContext(tx, ctx),
    });
    if (!outcome) throw new Error("redirects.delete: the writer returned no outcome");
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.delete",
      input,
      succeeded: true,
      entityId: input.redirectId,
      resultSummary: `${fromPath} removal ${outcome.outcome}${outcome.state ? ` ${outcome.state}` : ""}`,
    });
    return ok({ change: outcomeOf(outcome) });
  },
});

// ---------------------------------------------------------------------
// P8 AI-first review pass — bulk variants. Per CLAUDE.md §11, ops that
// would be called N times in one chat turn ship a bulk variant so the
// AI does it in one tool call. Both bulk handlers run inside a single
// transaction → all-or-nothing semantics.
// ---------------------------------------------------------------------

export const createRedirectsManyOp = defineOperation({
  name: "redirects.create_many",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      redirects: z
        .array(
          z
            .object({
              fromPath: z.string().min(1).max(500).regex(/^\//, "must start with /"),
              toPath: redirectTargetPathSchema,
              statusCode: statusCodeSchema.default(301),
            })
            .strict(),
        )
        .min(1)
        .max(500),
      /** When true, idempotent — an address that already has a rule gets this one instead. */
      upsert: z.boolean().default(false),
      /** #1550 — `next_publish` (default) saves them Staged, `later` as Drafts. */
      goLive: redirectGoLiveSchema.default("next_publish"),
    })
    .strict(),
  output: z.object({
    created: z.number().int(),
    updated: z.number().int(),
    skipped: z.number().int(),
    /** Per saved rule: pending or already live as it is, and what it replaced. */
    changes: z.array(changeOutcomeSchema),
  }),
  handler: async (ctx, input, tx) => {
    const taken = await staticFileRedirectRefusal(
      tx,
      input.redirects.map((r) => r.fromPath),
    );
    if (taken) {
      return err({ kind: "HandlerError", operation: "redirects.create_many", message: taken });
    }
    // #1517 — one address in either spelling; a rule answers both.
    const existing = await pendingViewAddresses(
      tx,
      addressesOf(input.redirects.map((r) => r.fromPath)),
    );
    let created = 0;
    let updated = 0;
    let skipped = 0;
    const writes: RedirectChangeInput[] = [];
    const seen = new Set<string>();
    for (const r of input.redirects) {
      const address = redirectAddress(r.fromPath);
      if (address === redirectAddress(r.toPath) || seen.has(address)) {
        skipped += 1;
        continue;
      }
      seen.add(address);
      const stored = existing.get(address);
      if (stored) {
        if (!input.upsert) {
          skipped += 1;
          continue;
        }
        updated += 1;
      } else {
        created += 1;
      }
      // An update keeps the address's stored spelling (#1517: updated into
      // one row with it), unless the caller named one of them.
      const fromPath =
        !stored || stored.includes(r.fromPath) ? r.fromPath : (stored[0] ?? r.fromPath);
      writes.push({ fromPath, toPath: r.toPath, statusCode: r.statusCode });
    }
    const outcomes = await writeRedirectChanges(tx, writes, {
      origin: "manual",
      state: stateOfGoLive(input.goLive),
      owner: await ownerOfContext(tx, ctx),
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.create_many",
      input: { count: input.redirects.length, upsert: input.upsert, goLive: input.goLive },
      succeeded: true,
      resultSummary: `created=${created},updated=${updated},skipped=${skipped}`,
    });
    return ok({ created, updated, skipped, changes: outcomes.map(outcomeOf) });
  },
});

/**
 * CLAUDE.md §11.A — "redirects | delete_many with `matches` substring matching
 * ≥10 rows | Hard to predict the blast radius of a regex-style match."
 *
 * `matches` is an unbounded ILIKE (`%<matches>%`): `matches: "/"` matches every
 * rooted path, i.e. every redirect on the site. Until this guard, the ONLY
 * thing standing between the AI and that was a sentence in the tool description
 * ("Always run find_redirects FIRST") — a prompt, not a boundary, which is
 * exactly what §2 rules out. Every deleted 301 is an inbound link stranded, and
 * the recovery ("manually re-create N redirects") is §11.A's own definition of
 * hard-to-revert. #1550 — a removal is a pending change now, but it goes live
 * with the next Publish live like any other: the cap stays.
 *
 * Enforced for AI actors only: a human running the same call is making the
 * decision themselves, which is what the gate exists to obtain.
 */
const AI_MATCHES_DELETE_LIMIT = 10;

export const deleteRedirectsManyOp = defineOperation({
  name: "redirects.delete_many",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      // Delete by id list, by fromPath list, or by substring match against
      // fromPath. Exactly one of the three must be provided.
      redirectIds: z.array(z.string().uuid()).max(500).optional(),
      fromPaths: z.array(z.string().min(1).max(500)).max(500).optional(),
      /** Substring match against from_path; ILIKE-style. */
      matches: z.string().min(1).max(500).optional(),
      /** #1550 — `next_publish` (default) stages the removals, `later` keeps them as Drafts. */
      goLive: redirectGoLiveSchema.default("next_publish"),
    })
    .strict()
    .refine(
      (v) => Number(!!v.redirectIds) + Number(!!v.fromPaths) + Number(!!v.matches) === 1,
      "exactly one of redirectIds / fromPaths / matches is required",
    ),
  output: z.object({
    /** Rules whose removal is pending now, or whose pending create was discarded. */
    deleted: z.number().int(),
    changes: z.array(changeOutcomeSchema),
  }),
  handler: async (ctx, input, tx) => {
    let fromPaths: string[] = [];
    if (input.redirectIds) {
      const { addresses, unknown } = await addressesOfIds(tx, input.redirectIds);
      if (unknown.length > 0) {
        return err(
          handlerErrorFromDetails(
            "redirects.delete_many",
            unknown.map((id) => ({
              path: ["redirectIds", input.redirectIds?.indexOf(id) ?? 0],
              message: `no redirect or pending change has id ${id}`,
              next: "find_redirects lists the rules and their ids",
            })),
            { lead: "Nothing was deleted." },
          ),
        );
      }
      fromPaths = input.redirectIds.map((id) => addresses.get(id.toLowerCase()) ?? "");
    } else if (input.fromPaths) {
      fromPaths = input.fromPaths;
    } else if (input.matches) {
      const like = `%${input.matches}%`;
      const rows = (await tx.execute(sql`
        SELECT from_path FROM redirects WHERE from_path ILIKE ${like}
        UNION
        SELECT from_path FROM pending_redirects WHERE to_path IS NOT NULL AND from_path ILIKE ${like}
      `)) as unknown as { from_path: string }[];
      fromPaths = rows.map((r) => r.from_path);
      // Count BEFORE deleting: the AI must not discover the blast radius by
      // having already caused it (§11.A).
      const wouldDelete = addressesOf(fromPaths).length;
      if (ctx.actorKind === "ai" && wouldDelete >= AI_MATCHES_DELETE_LIMIT) {
        await recordAudit(tx, {
          actorId: ctx.actorId,
          requestId: ctx.requestId,
          operation: "redirects.delete_many",
          input,
          succeeded: false,
          resultSummary: `blocked: matches='${input.matches}' would delete ${wouldDelete} redirects (limit ${AI_MATCHES_DELETE_LIMIT})`,
        });
        return err({
          kind: "HandlerError",
          operation: "redirects.delete_many",
          message:
            `matches='${input.matches}' would delete ${wouldDelete} redirects — over the ${AI_MATCHES_DELETE_LIMIT}-row limit for a substring match (CLAUDE.md §11.A: the blast radius of a regex-style match is hard to predict, and every deleted 301 strands an inbound link). ` +
            `Nothing was deleted. Next step: call find_redirects({matches:'${input.matches}'}) to list them, show the operator the list and the count, and — once they confirm which ones to drop — call this op again with an explicit \`redirectIds\` array. ` +
            `A narrower \`matches\` that hits fewer than ${AI_MATCHES_DELETE_LIMIT} rows also works.`,
        });
      }
    }
    // Only addresses with a live rule or a pending change: a path with
    // neither deletes nothing. A removal already pending counts, so asking
    // again sets the requested state on it (Draft → Staged), as the single
    // delete does.
    const ruled = await addressesWithRuleOrChange(tx, addressesOf(fromPaths));
    const removals = removalsOf(fromPaths.filter((p) => ruled.has(redirectAddress(p))));
    const outcomes = await writeRedirectChanges(tx, removals, {
      origin: "manual",
      state: stateOfGoLive(input.goLive),
      owner: await ownerOfContext(tx, ctx),
    });
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.delete_many",
      input,
      succeeded: true,
      resultSummary: `deleted=${outcomes.length}`,
    });
    return ok({ deleted: outcomes.length, changes: outcomes.map(outcomeOf) });
  },
});

/** #1550 — what {@link setRedirectChangesStateOp} does to each pending change. */
export const redirectChangeActionSchema = z.enum(["include", "keep_as_draft", "discard"]);

export const setRedirectChangesStateOp = defineOperation({
  name: "redirects.set_changes_state",
  readScope: "request",
  // #1550 — routine: a pending change is not live, and each action is
  // undone by another (include ↔ keep as draft; a discarded change is saved
  // again with one call).
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** The from paths of pending changes (either spelling of the address). */
      fromPaths: z.array(z.string().min(1).max(500)).min(1).max(500),
      /**
       * `include`: Draft → Staged (goes live with the next Publish live);
       * `keep_as_draft`: Staged → Draft (served nowhere); `discard`: drop the
       * pending change (the live rule stays as it is).
       */
      action: redirectChangeActionSchema,
    })
    .strict(),
  output: z.object({
    /** Changes whose state the action changed, or that it discarded. */
    changed: z.number().int(),
  }),
  handler: async (ctx, input, tx) => {
    const op = "redirects.set_changes_state";
    const addresses = input.fromPaths.map((p) => redirectAddress(p));
    const rows = (
      (await tx.execute(sql`
        SELECT ${PENDING_COLUMNS} FROM pending_redirects p
        WHERE p.address = ANY(${textArray(addresses)})
        FOR UPDATE OF p
      `)) as unknown as PendingDbRow[]
    ).map(pendingRowOf);
    const byAddress = new Map(rows.map((r) => [r.address, r]));
    const problems: ErrorDetail[] = [];
    for (const [i, a] of addresses.entries()) {
      const row = byAddress.get(a);
      if (!row) {
        problems.push({
          path: ["fromPaths", i],
          message: `${input.fromPaths[i]} has no pending change`,
          next: "find_redirects({state:'staged'}) and ({state:'draft'}) list the pending changes",
        });
      } else if (row.origin !== "manual" && input.action !== "discard") {
        problems.push({
          path: ["fromPaths", i],
          message: `${input.fromPaths[i]} is an automatic change (${row.origin}): it goes live with the Publish live that ships its page change, so it stays Staged`,
          next: "leave it, or discard it when the page change should go live without it",
        });
      }
    }
    if (problems.length > 0) {
      return err(handlerErrorFromDetails(op, problems, { lead: "Nothing was changed." }));
    }
    let changed = 0;
    if (input.action === "discard") {
      const gone = (await tx.execute(sql`
        DELETE FROM pending_redirects WHERE address = ANY(${textArray(addresses)}) RETURNING 1
      `)) as unknown as unknown[];
      changed = gone.length;
    } else {
      const state = input.action === "include" ? "staged" : "draft";
      const moved = (await tx.execute(sql`
        UPDATE pending_redirects
        SET state = ${state}, revision = revision + 1, updated_at = now()
        WHERE address = ANY(${textArray(addresses)}) AND state <> ${state}
        RETURNING 1
      `)) as unknown as unknown[];
      changed = moved.length;
    }
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      resultSummary: `${input.action} ${changed} of ${addresses.length}`,
    });
    return ok({ changed });
  },
});
