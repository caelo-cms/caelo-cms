// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1358 — redirects.{propose_external, preview_external,
 * execute_proposal, reject_proposal, list_pending}.
 *
 * The §11.A gate of redirects to another domain (CLAUDE.md). A routine
 * redirect stays on the site, and one call undoes it. This one sends visitors
 * away under the site's name, and its address ends up on printed QR codes
 * and letters, where nobody can take it back; a wrong or hostile target is
 * an open redirect on a trusted domain. So the AI proposes, and an Owner
 * approves each batch after seeing every address. A human with the
 * approver's permission goes through the same two ops from
 * Settings → Redirects, so there is one write path.
 *
 * Every target is checked three times, because hosts and rows change while
 * a proposal waits: at propose, on the card, and at execute. The serving
 * layers check the URL's form again (`servableRedirectTargetIssue`).
 *
 * #1550 — an approved rule is a pending change like any other (`to_path`
 * holds the URL): Staged by default, live with the next Publish live. The
 * card names the mode; `goLive: "now"` puts it live at approval through Go
 * live now (`redirects.go_live_now`, run after this op's commit), and then
 * the approver also needs the Publish live permission. The list of the
 * shared redirect proposals (`list_pending`, `reject_proposal`) also holds
 * the AI's Go live now proposals (`redirects_release.ts`).
 */

import {
  defineOperation,
  handlerErrorFromDetails,
  type TransactionRunner,
  textArray,
} from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  err,
  externalRedirectHostIssue,
  externalRedirectProviderIssue,
  externalRedirectTargetIssue,
  ok,
  type ProposalStatus,
  proposalStatus,
  redirectAddress,
  redirectFromPathSpellings,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit.js";
import { ownerOfContext } from "../redirects/model.js";
import { writeRedirectChanges } from "../redirects/write.js";
import { jsonbParam } from "../sql-helpers.js";
import { requiresApproverPermission } from "./_approver-permission.js";
import {
  DUPLICATE_PROPOSAL_MESSAGE,
  hashProposalPayload,
  isDuplicatePendingError,
  resolveChatSessionId,
} from "./_propose-helpers.js";
import { pagesByRedirectSpelling } from "./content/redirect-page-conflicts.js";
import { actorHasPermission } from "./quality/_permissions.js";
import { staticFileRedirectRefusal } from "./redirects.js";

/** Most rules one proposal holds: the Owner reads every address on the card. */
const MAX_EXTERNAL_REDIRECTS = 50;

/**
 * Everything every serving layer can match: no query or fragment (redirects
 * match the path), no `*` (a URL-map wildcard), no Caddyfile delimiters. A
 * row the plan cannot serve would stop the sync of the whole table.
 */
const FROM_PATH = /^\/[^\s\p{Cc}?#*{}"`\\]*$/u;

const externalRedirectItem = z
  .object({
    fromPath: z
      .string()
      .min(1)
      .max(500)
      .regex(
        FROM_PATH,
        "must be a path on this site starting with '/', without spaces or any of ? # * { } \" ` \\",
      ),
    /** Checked by {@link externalRedirectProblems}, with the hosts in hand. */
    url: z.string().min(1).max(2048),
    statusCode: z
      .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
      .default(302),
  })
  .strict();

/** Input of `redirects.propose_external` (and the `propose_external_redirect` tool). */
export const externalRedirectsInput = z
  .object({
    redirects: z.array(externalRedirectItem).min(1).max(MAX_EXTERNAL_REDIRECTS),
    /**
     * #1550 — `next_publish` (default): saved Staged at approval, live with
     * the next Publish live. `now`: live at approval, without Publish live
     * (the approver needs the Publish live permission too).
     */
    goLive: z.enum(["next_publish", "now"]).default("next_publish"),
  })
  .strict();

type ExternalRedirectsInput = z.infer<typeof externalRedirectsInput>;

/** One refusal, as `handlerErrorFromDetails` lists it. */
interface Problem {
  readonly path: (string | number)[];
  readonly message: string;
}

const hostOfUrl = (url: string | null | undefined): string | null => {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * The hosts this install answers on, each with what it is. A target there is
 * no external redirect: it is either a page of this site spelled as a URL,
 * which skips every same-site rule, or the admin.
 */
async function installHosts(tx: TransactionRunner): Promise<ReadonlyMap<string, string>> {
  const rows = (await tx.execute(sql`
    SELECT 'site' AS kind, site_base_url AS value FROM site_defaults WHERE id = 1
    UNION ALL SELECT 'site', 'https://' || hostname FROM domains
    UNION ALL SELECT 'staging', 'https://' || staging_host FROM staging_access
      WHERE id = 1 AND staging_host IS NOT NULL
  `)) as unknown as { kind: string; value: string | null }[];
  const hosts = new Map<string, string>();
  const add = (url: string | null | undefined, what: string) => {
    const host = hostOfUrl(url);
    if (host) hosts.set(host, what);
  };
  for (const r of rows) {
    add(r.value, r.kind === "site" ? "this site" : "the staging site");
  }
  add(process.env.CAELO_SITE_URL, "this site");
  // Set after the site's rows: where a host is both, the admin's refusal is
  // the one that matters.
  add(process.env.CAELO_ADMIN_URL, "the Caelo admin");
  add(process.env.ORIGIN, "the Caelo admin");
  return hosts;
}

/** Why these rules cannot be applied here; empty when they can. */
async function externalRedirectProblems(
  tx: TransactionRunner,
  input: ExternalRedirectsInput,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const hosts = await installHosts(tx);
  const provider = process.env.CAELO_PROVIDER;
  const seen = new Set<string>();
  for (const [i, r] of input.redirects.entries()) {
    const path = ["redirects", i];
    const issue =
      externalRedirectTargetIssue(r.url) ??
      externalRedirectHostIssue(r.url, hosts) ??
      externalRedirectProviderIssue(r.url, provider);
    if (issue) problems.push({ path, message: `${r.fromPath}: ${issue}` });
    const [bare] = redirectFromPathSpellings(r.fromPath);
    if (bare !== undefined && seen.has(bare)) {
      problems.push({
        path,
        message: `${r.fromPath} is in this proposal twice (with and without the trailing slash count as one address). Keep one.`,
      });
    }
    if (bare !== undefined) seen.add(bare);
  }
  const taken = await staticFileRedirectRefusal(
    tx,
    input.redirects.map((r) => r.fromPath),
  );
  if (taken) problems.push({ path: ["redirects"], message: taken });
  return problems;
}

/**
 * #1550 — what each from path answers once everything saved goes live (its
 * pending change, else its live rule), with its status: the change a click
 * makes, and what must still hold when it is made. With `lock`, the rows
 * stay locked until the commit.
 */
async function currentTargets(
  tx: TransactionRunner,
  input: ExternalRedirectsInput,
  lock = false,
): Promise<Record<string, string | null>> {
  const addresses = textArray(input.redirects.map((r) => redirectAddress(r.fromPath)));
  const live = (await tx.execute(sql`
    SELECT address, to_path, status_code FROM redirects
    WHERE address = ANY(${addresses})
    ORDER BY from_path
    ${lock ? sql`FOR UPDATE` : sql``}
  `)) as unknown as { address: string; to_path: string; status_code: number }[];
  const pending = (await tx.execute(sql`
    SELECT address, to_path, status_code FROM pending_redirects WHERE address = ANY(${addresses})
    ${lock ? sql`FOR UPDATE` : sql``}
  `)) as unknown as { address: string; to_path: string | null; status_code: number | null }[];
  const byAddress = new Map<string, string | null>();
  for (const r of live) {
    if (!byAddress.has(r.address)) byAddress.set(r.address, `${r.to_path} (${r.status_code})`);
  }
  for (const p of pending) {
    byAddress.set(p.address, p.to_path === null ? null : `${p.to_path} (${p.status_code})`);
  }
  return Object.fromEntries(
    input.redirects.map((r) => [r.fromPath, byAddress.get(redirectAddress(r.fromPath)) ?? null]),
  );
}

/** The pages on these rules' addresses: the page wins once it is published. */
async function pageConflicts(
  ctx: ExecutionContext,
  tx: TransactionRunner,
  input: ExternalRedirectsInput,
): Promise<{ fromPath: string; pageTitle: string }[]> {
  const pages = await pagesByRedirectSpelling(
    ctx,
    { paths: input.redirects.flatMap((r) => redirectFromPathSpellings(r.fromPath)) },
    tx,
  );
  if (!pages.ok) throw new Error(`pages.list failed: ${JSON.stringify(pages.error)}`);
  return input.redirects.flatMap((r) => {
    const page = pages.value.get(r.fromPath);
    return page ? [{ fromPath: r.fromPath, pageTitle: page.title }] : [];
  });
}

const statusWords = (code: number): string =>
  code === 301 || code === 308
    ? "permanent: browsers remember it even after it is removed"
    : "temporary";

/** #1550 — what the click does, in the card's words. */
function modeLine(goLive: ExternalRedirectsInput["goLive"]): string {
  return goLive === "now"
    ? "It goes live on your hosting right after you approve, without a Publish live. Approving it needs the Publish live permission too."
    : "It is saved Staged when you approve: staging serves it at once, the live site with the next Publish live.";
}

function card(
  input: ExternalRedirectsInput,
  current: Record<string, string | null>,
  conflicts: Awaited<ReturnType<typeof pageConflicts>>,
): string {
  const lines = input.redirects.map((r) => {
    const was = current[r.fromPath];
    return [
      `${r.fromPath} → ${r.url}`,
      `  ${r.statusCode}, ${statusWords(r.statusCode)}`,
      ...(was ? [`  Replaces the redirect to ${was}`] : []),
    ].join("\n");
  });
  return [
    `Send ${input.redirects.length === 1 ? "this address" : `these ${input.redirects.length} addresses`} on your site to another website?`,
    "Visitors land there under your domain's name, and an address on a QR code or a letter cannot be taken back. Approve only destinations you recognise.",
    lines.join("\n"),
    ...conflicts.map(
      (c) =>
        `A page uses ${c.fromPath} ("${c.pageTitle}"): once it is published, visitors see the page instead of this redirect.`,
    ),
    modeLine(input.goLive),
  ].join("\n\n");
}

const proposeOutput = z.object({
  proposalId: z.string(),
  preview: z.record(z.string(), z.unknown()),
});

export const proposeExternalRedirectsOp = defineOperation({
  name: "redirects.propose_external",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: externalRedirectsInput,
  output: proposeOutput,
  handler: async (ctx, input, tx) => {
    const op = "redirects.propose_external";
    const problems = await externalRedirectProblems(tx, input);
    if (problems.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, problems, { lead: "Nothing was proposed." }),
      };
    }
    const current = await currentTargets(tx, input);
    const conflicts = await pageConflicts(ctx, tx, input);
    const preview = {
      summary: input.redirects.map((r) => `${r.fromPath} → ${r.url}`).join(", "),
      redirects: input.redirects,
      goLive: input.goLive,
      current,
      pageConflicts: conflicts,
      effect: modeLine(input.goLive),
    };
    const payload = { redirects: input.redirects, goLive: input.goLive };
    const chatSessionId = await resolveChatSessionId(tx, ctx.chatBranchId, ctx.chatTaskId);
    const payloadHash = await hashProposalPayload(payload);
    try {
      const rows = (await tx.execute(sql`
        INSERT INTO redirect_pending_actions
          (kind, proposed_by, payload, preview, chat_session_id, payload_hash)
        VALUES ('set_external', ${ctx.actorId}::uuid, ${jsonbParam(payload)}, ${jsonbParam(preview)},
                ${chatSessionId === null ? null : sql`${chatSessionId}::uuid`}, ${payloadHash})
        RETURNING id::text AS id
      `)) as unknown as { id: string }[];
      const id = rows[0]?.id;
      if (!id) return err({ kind: "HandlerError", operation: op, message: "no id" });
      await recordAudit(tx, {
        actorId: ctx.actorId,
        requestId: ctx.requestId,
        operation: op,
        input: payload,
        succeeded: true,
        entityId: id,
        resultSummary: preview.summary,
      });
      return ok({ proposalId: id, preview });
    } catch (e) {
      if (isDuplicatePendingError(e)) {
        return err({ kind: "HandlerError", operation: op, message: DUPLICATE_PROPOSAL_MESSAGE });
      }
      throw e;
    }
  },
});

export const previewExternalRedirectsOp = defineOperation({
  name: "redirects.preview_external",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: externalRedirectsInput,
  output: z.object({ preview: z.string() }),
  handler: async (ctx, input, tx) => {
    const text = card(input, await currentTargets(tx, input), await pageConflicts(ctx, tx, input));
    // The propose op refuses these after the click; the card says so first.
    const problems = await externalRedirectProblems(tx, input);
    return ok({
      preview:
        problems.length === 0
          ? text
          : `This cannot be applied as it is, so reject it: ${problems.map((p) => p.message).join("; ")}\n\n${text}`,
    });
  },
});

const executeDefinition = defineOperation({
  name: "redirects.execute_proposal",
  readScope: "request",
  // Why human-only: the Owner's Approve click of the §11.A gate — the AI
  // proposes, it can never approve or reject its own proposal.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z.object({ proposalId: z.string().uuid() }).strict(),
  output: z.object({
    fromPaths: z.array(z.string()),
    /**
     * #1550 — `now`: the caller puts the saved rules live after this
     * commit (`redirects.go_live_now` with `fromPaths`, as the approver).
     */
    goLive: z.enum(["next_publish", "now"]),
    /**
     * The pending changes this approval saved (id and revision): Go live now
     * after it binds to exactly these, so a save in between is not put live.
     */
    changes: z.array(z.object({ id: z.string(), revision: z.number().int() })),
    /** Rules a page shares a path with; the page wins once it is published. */
    pageConflicts: z.array(z.object({ fromPath: z.string(), pageTitle: z.string() })),
    nextStep: z.string(),
  }),
  handler: async (ctx, input, tx) => {
    const op = "redirects.execute_proposal";
    const rows = (await tx.execute(sql`
      SELECT payload, preview, status FROM redirect_pending_actions
      WHERE id = ${input.proposalId}::uuid AND kind = 'set_external'
      FOR UPDATE
    `)) as unknown as {
      payload: unknown;
      preview: { current: Record<string, string | null> };
      status: string;
    }[];
    const row = rows[0];
    if (!row) return err({ kind: "HandlerError", operation: op, message: "proposal not found" });
    if (row.status !== "pending") {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `proposal is already ${row.status}`,
      });
    }
    const payload = externalRedirectsInput.parse(row.payload);
    // "Now" is Go live now: the approver needs the Publish live permission
    // too. Refused before anything is saved; the proposal stays pending for
    // someone who holds it.
    if (payload.goLive === "now" && !(await actorHasPermission(tx, ctx, "deploy.trigger"))) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "permission_denied: this proposal goes live now, without Publish live, which needs the Publish live permission (deploy.trigger) as well. Nothing was applied and the proposal stays pending — ask someone who holds it, or reject it and propose it for the next Publish live.",
      });
    }
    // Hosts and the hosting may have changed while the proposal waited.
    const problems = await externalRedirectProblems(tx, payload);
    if (problems.length > 0) {
      return {
        ok: false,
        error: handlerErrorFromDetails(op, problems, {
          lead: "Nothing was applied: reject this proposal and propose again.",
        }),
      };
    }
    // What the Owner saw is what gets replaced, or nothing is. The rows stay
    // locked until the commit.
    const now = await currentTargets(tx, payload, true);
    const changed = payload.redirects
      .map((r) => r.fromPath)
      .filter((p) => (now[p] ?? null) !== (row.preview.current[p] ?? null));
    if (changed.length > 0) {
      return err({
        kind: "HandlerError",
        operation: op,
        message: `${changed.join(", ")} changed after this proposal was made, so applying it would overwrite that change. Nothing was applied: reject it and propose again (find_redirects shows the current rules).`,
      });
    }
    const written = await writeRedirectChanges(
      tx,
      payload.redirects.map((r) => ({
        fromPath: r.fromPath,
        toPath: r.url,
        statusCode: r.statusCode,
      })),
      { origin: "manual", state: "staged", owner: await ownerOfContext(tx, ctx) },
    );
    await tx.execute(sql`
      UPDATE redirect_pending_actions
      SET status = 'applied', decided_at = now(), decided_by = ${ctx.actorId}::uuid
      WHERE id = ${input.proposalId}::uuid
    `);
    const fromPaths = payload.redirects.map((r) => r.fromPath);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: op,
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary:
        `${payload.goLive}: ${payload.redirects.map((r) => `${r.fromPath} → ${r.url}`).join(", ")}`.slice(
          0,
          500,
        ),
    });
    const conflicts = await pageConflicts(ctx, tx, payload);
    const saved =
      payload.goLive === "now"
        ? "Saved; it goes live on the hosting now (Go live now)."
        : "Saved Staged: staging serves it at once, the live site with the next Publish live.";
    return ok({
      fromPaths,
      goLive: payload.goLive,
      changes: written.flatMap((o) =>
        o.changeId !== null && o.revision !== null
          ? [{ id: o.changeId, revision: o.revision }]
          : [],
      ),
      pageConflicts: conflicts,
      nextStep:
        conflicts.length === 0
          ? saved
          : `${saved} A page shares a path with a rule: once it is published, visitors see the page. Remove the rule or move the page.`,
    });
  },
});

/** #589 — the approver must hold settings.write, as for a custom domain. */
export const executeRedirectProposalOp = requiresApproverPermission(
  ["settings.write"],
  executeDefinition,
);

export const rejectRedirectProposalOp = defineOperation({
  name: "redirects.reject_proposal",
  readScope: "request",
  // Why human-only: the Owner's Reject click of the §11.A gate.
  actorScope: ["human", "system"],
  database: "cms_admin",
  input: z
    .object({
      proposalId: z.string().uuid(),
      reason: z.string().min(1).max(500).optional(),
    })
    .strict(),
  output: z.object({}),
  handler: async (ctx, input, tx) => {
    await tx.execute(sql`
      UPDATE redirect_pending_actions
      SET status = 'rejected', decided_at = now(), decided_by = ${ctx.actorId}::uuid,
          decision_reason = ${input.reason ?? null}
      WHERE id = ${input.proposalId}::uuid AND status = 'pending'
    `);
    await recordAudit(tx, {
      actorId: ctx.actorId,
      requestId: ctx.requestId,
      operation: "redirects.reject_proposal",
      input,
      succeeded: true,
      entityId: input.proposalId,
      resultSummary: input.reason ?? "(no reason)",
    });
    return ok({});
  },
});

export const listPendingRedirectProposalsOp = defineOperation({
  name: "redirects.list_pending",
  readScope: "request",
  actorScope: ["human", "ai", "system"],
  database: "cms_admin",
  input: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
  output: z.object({
    proposals: z.array(
      z.object({
        id: z.string(),
        /** #1550 — `set_external` (a target on another domain) or `go_live_now`. */
        kind: z.enum(["set_external", "go_live_now"]),
        proposedBy: z.string(),
        payload: z.record(z.string(), z.unknown()),
        preview: z.record(z.string(), z.unknown()),
        status: proposalStatus,
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (_ctx, input, tx) => {
    const rows = (await tx.execute(sql`
      SELECT id::text AS id, kind, proposed_by::text AS proposed_by, payload, preview, status,
             created_at
      FROM redirect_pending_actions
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT ${input.limit ?? 50}
    `)) as unknown as {
      id: string;
      kind: "set_external" | "go_live_now";
      proposed_by: string;
      payload: unknown;
      preview: unknown;
      status: ProposalStatus;
      created_at: string | Date;
    }[];
    return ok({
      proposals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        proposedBy: r.proposed_by,
        payload: r.payload as Record<string, unknown>,
        preview: r.preview as Record<string, unknown>,
        status: r.status,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    });
  },
});
