// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-newsletter — Tier-1 plugin: subscriber list + campaign sends.
 *
 * P12 PR2.4 — first real ctx.email user. Worker drains the sends queue every
 * minute. Owner drafts a campaign via AI; visitor double-opt-in confirms;
 * worker dispatches per-recipient emails.
 *
 * Schema (cms_public.plugin_newsletter.*):
 *   subscribers   — email_hash, confirm_token, confirmed_at, unsub_token, unsubscribed_at
 *   campaigns     — slug, subject, body_html, status (draft/queued/sending/sent), sent_at
 *   sends         — campaign_id, subscriber_id, sent_at, status (pending/sent/failed)
 *
 * AI tools (the agent's path to everything the owner panel does):
 *   list_newsletter_campaigns — campaigns + confirmed-subscriber count. Read.
 *   draft_newsletter_campaign — AI-drafted campaign saved as `draft`. Direct:
 *                               nothing leaves the site until a send.
 *   get_newsletter_campaign   — one campaign's subject, body and the number
 *                               of subscribers a send reaches. Read.
 *   send_newsletter_campaign  — sends a draft to its confirmed subscribers.
 *                               APPROVAL-GATED (§11.A): an email that went
 *                               out cannot be recalled. The approval card
 *                               shows the exact subject, body and recipient
 *                               bound, and only that is sent (send-runs.ts).
 */

import {
  attachCaptchaProof,
  honeypotFieldHtml,
  isHoneypotTripped,
  KIT_CSS,
  postPluginJson,
  setStatus,
} from "@caelo-cms/plugin-component-kit";
import {
  type AiWorkItem,
  defineComponent,
  definePlugin,
  isAiDelegated,
  type PluginContextTier1,
  z,
} from "@caelo-cms/plugin-sdk";
import {
  adminQueryOf,
  drainSends,
  eligibleRecipients,
  SEND_PROGRESS_TABLE,
  SEND_RUNS_TABLE,
} from "./send-runs.js";

/**
 * Longest campaign body an agent may hand in. `body_html` is an unbounded
 * `text` column, so the cap is an email limit, not a storage one: Gmail
 * clips a message body past ~102 KB, and every send appends the
 * unsubscribe footer — 100 000 characters keeps the whole campaign visible.
 */
const MAX_BODY_HTML_LENGTH = 100_000;

const draftCampaignArgs = z
  .object({
    slug: z.string().min(1).max(120),
    subject: z.string().min(1).max(300),
    brief: z.string().min(1).max(8000),
    /** Issue #741 — the campaign HTML a Power-MCP agent wrote itself
     *  from this tool's work item; absent on the install-side path. */
    bodyHtml: z.string().trim().min(1).max(MAX_BODY_HTML_LENGTH).optional(),
  })
  .strict();

const DRAFT_SYSTEM_PROMPT =
  "Write a single newsletter campaign in clean HTML — header, 1-3 sections, CTA. Plain HTML only, no markdown, no extra commentary.";

/**
 * The approval of a send. The operator approves exactly these values on
 * the card, so they are what is sent — never the public draft, which only
 * has to still match them when the approval is applied.
 */
const sendCampaignArgs = z
  .object({
    campaignId: z.string().uuid(),
    subject: z.string().min(1).max(300),
    bodyHtml: z.string().min(1).max(MAX_BODY_HTML_LENGTH),
    /** The most subscribers this approval may reach. */
    recipientCount: z.number().int().nonnegative().max(1000),
  })
  .strict();

const getCampaignArgs = z.object({ campaignId: z.string().uuid() }).strict();

/** Most rows one `ctx.query.list` returns (the SDK's cap). */
const SUBSCRIBER_LIST_CAP = 1000;

interface SubscriberRow {
  id: string;
  email: string;
  unsub_token: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
}

/** Every subscriber row, or a loud refusal when the list exceeds one read. */
async function allSubscribers(ctx: PluginContextTier1, op: string): Promise<SubscriberRow[]> {
  const subs = await ctx.query.list<"subscribers", SubscriberRow>("subscribers", {
    limit: SUBSCRIBER_LIST_CAP,
  });
  if (subs.length >= SUBSCRIBER_LIST_CAP) {
    throw new Error(
      `${op}: ${SUBSCRIBER_LIST_CAP}+ subscriber rows — this sender cannot reach all of them yet, so nothing was queued`,
    );
  }
  return subs;
}

function hashEmail(email: string): string {
  // Deterministic non-cryptographic hash for de-dupe + analytics. Email lookups
  // use this; the raw email is stored alongside for sending. P13 may swap
  // for argon2 or a keyed HMAC.
  const normalised = email.trim().toLowerCase();
  let h = 0n;
  for (let i = 0; i < normalised.length; i++) {
    h = (h * 31n + BigInt(normalised.charCodeAt(i))) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export default definePlugin<PluginContextTier1>({
  slug: "newsletter",
  version: "1.0.0",
  tier: 1,
  schema: {
    subscribers: {
      id: "uuid",
      email: "string",
      email_hash: "string",
      confirm_token: "string",
      confirmed_at: "timestamp_nullable",
      unsub_token: "string",
      unsubscribed_at: "timestamp_nullable",
      created_at: "timestamp",
    },
    campaigns: {
      id: "uuid",
      slug: "string",
      subject: "string",
      body_html: "text",
      status: "enum:draft,queued,sending,sent",
      created_at: "timestamp",
      sent_at: "timestamp_nullable",
    },
    /** Outcome log the worker writes per recipient of a run — not a queue. */
    sends: {
      id: "uuid",
      run_id: "string",
      campaign_id: "string",
      subscriber_id: "string",
      status: "enum:pending,sent,failed",
      error: "text",
      created_at: "timestamp",
      sent_at: "timestamp_nullable",
    },
  },
  /**
   * #635 — approved sends, out of the public side's reach: the worker
   * sends only what a `send_runs` row holds (send-runs.ts).
   */
  adminSchema: {
    send_runs: SEND_RUNS_TABLE,
    send_progress: SEND_PROGRESS_TABLE,
  },
  requestedCapabilities: [
    "ai_provider",
    "email",
    "background_workers",
    "chat_runner_tools",
    "cms_admin_schema",
  ],
  /** Visitor-facing surface (default deny — everything else is
   *  refused a visitor-context dispatch). */
  publicOperations: ["subscribe", "confirm", "unsubscribe"],
  operations: {
    subscribe: async (ctx, args) => {
      const input = args as { email: string; honeypot?: string; hp_address?: string };
      if (
        (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) ||
        (typeof input.hp_address === "string" && input.hp_address.trim().length > 0)
      ) {
        return { id: "00000000-0000-0000-0000-000000000000", awaitingConfirm: true };
      }
      if (!input.email?.includes("@")) throw new Error("subscribe: invalid email");
      if (ctx.captcha) {
        const ok = await ctx.captcha.requireProof(null);
        if (!ok) throw new Error("subscribe: captcha verification failed");
      }
      const hash = hashEmail(input.email);
      const existing = await ctx.query.list<
        "subscribers",
        { id: string; confirmed_at: string | null }
      >("subscribers", { email_hash: hash, limit: 1 });
      if (existing[0]?.confirmed_at) return { alreadyConfirmed: true, id: existing[0].id };
      if (existing[0]) {
        return { id: existing[0].id, awaitingConfirm: true };
      }
      const confirmToken = crypto.randomUUID();
      const unsubToken = crypto.randomUUID();
      const r = await ctx.query.insert("subscribers", {
        email: input.email,
        email_hash: hash,
        confirm_token: confirmToken,
        unsub_token: unsubToken,
      });
      // Send confirmation email if email transport is configured.
      if (ctx.email) {
        await ctx.email.send({
          to: input.email,
          subject: "Confirm your newsletter subscription",
          html: `<p>Click <a href="/api/plugin/newsletter/confirm?token=${confirmToken}">here</a> to confirm.</p>`,
        });
      }
      return { id: r.id, awaitingConfirm: true };
    },

    confirm: async (ctx, args) => {
      const input = args as { token: string };
      const matches = await ctx.query.list<"subscribers", { id: string }>("subscribers", {
        confirm_token: input.token,
        limit: 1,
      });
      if (!matches[0]) throw new Error("confirm: invalid token");
      await ctx.query.update("subscribers", matches[0].id, {
        confirmed_at: new Date().toISOString(),
      });
      return { confirmed: matches[0].id };
    },

    unsubscribe: async (ctx, args) => {
      const input = args as { token: string };
      const matches = await ctx.query.list<"subscribers", { id: string }>("subscribers", {
        unsub_token: input.token,
        limit: 1,
      });
      if (!matches[0]) throw new Error("unsubscribe: invalid token");
      await ctx.query.update("subscribers", matches[0].id, {
        unsubscribed_at: new Date().toISOString(),
      });
      return { unsubscribed: matches[0].id };
    },

    /**
     * Campaigns (newest first) + how many subscribers a send reaches. A
     * campaign's send state comes from the approved runs in private
     * storage, not from the public row, which anyone on the public side
     * could rewrite.
     */
    list_campaigns: async (ctx, _args) => {
      const campaigns = await ctx.query.list<
        "campaigns",
        {
          id: string;
          slug: string;
          subject: string;
          status: string;
          created_at: string;
          sent_at: string | null;
        }
      >("campaigns", { orderBy: "created_at", orderDir: "desc", limit: 100 });
      const subs = await ctx.query.list<"subscribers", SubscriberRow>("subscribers", {
        limit: SUBSCRIBER_LIST_CAP,
      });
      const admin = adminQueryOf(ctx);
      const runs = await admin.list<
        "send_runs",
        { id: string; campaign_id: string; status: string; recipient_count: number }
      >("send_runs", { orderBy: "created_at", orderDir: "desc", limit: 1000 });
      const progress = await admin.list<"send_progress", { id: string; cursor: number }>(
        "send_progress",
        { orderBy: "created_at", orderDir: "desc", limit: 1000 },
      );
      const claimedByRun = new Map(progress.map((p) => [p.id, p.cursor]));
      // The oldest run of a campaign is the one that sends (send-runs.ts):
      // newest first, so an older run overwrites a newer one.
      const runByCampaign = new Map<string, (typeof runs)[number]>();
      for (const run of runs) runByCampaign.set(run.campaign_id, run);
      return {
        // The query handle reads at most SUBSCRIBER_LIST_CAP rows; at the
        // cap the count is a lower bound and send_campaign refuses.
        subscriberListTruncated: subs.length >= SUBSCRIBER_LIST_CAP,
        campaigns: campaigns.map(({ id, slug, subject, status, created_at, sent_at }) => {
          const run = runByCampaign.get(id);
          return {
            id,
            slug,
            subject,
            status,
            created_at,
            sent_at,
            approvedSend: run
              ? {
                  status: run.status,
                  recipientCount: run.recipient_count,
                  processed: claimedByRun.get(run.id) ?? 0,
                }
              : null,
          };
        }),
        subscriberCount: eligibleRecipients(subs).recipients.length,
      };
    },

    /** One campaign as the send approval needs it: subject, body, reach. */
    get_campaign: async (ctx, args) => {
      const input = getCampaignArgs.parse(args);
      const rows = await ctx.query.list<
        "campaigns",
        { id: string; slug: string; subject: string; body_html: string; status: string }
      >("campaigns", { id: input.campaignId, limit: 1 });
      const campaign = rows[0];
      if (!campaign) throw new Error("get_campaign: campaign not found");
      const subs = await allSubscribers(ctx, "get_campaign");
      return {
        id: campaign.id,
        slug: campaign.slug,
        status: campaign.status,
        subject: campaign.subject,
        bodyHtml: campaign.body_html,
        recipientCount: eligibleRecipients(subs).recipients.length,
      };
    },

    /**
     * Save a campaign as `draft`. Three paths (issue #741):
     *   - `bodyHtml` given: a Power-MCP agent wrote the HTML with its own
     *     model; save it, no `ctx.ai` call. `costInputTokens` is 0 — the
     *     install's AI spent nothing, and the field keeps one result shape.
     *   - delegated call without `bodyHtml`: hand back the exact prompt as
     *     a work item whose `apply` re-calls this tool with the answer.
     *     Nothing written.
     *   - otherwise: the install's AI writes the HTML.
     */
    draft_campaign: async (ctx, args) => {
      const input = draftCampaignArgs.parse(args);
      if (input.bodyHtml !== undefined) {
        const r = await ctx.query.insert("campaigns", {
          slug: input.slug,
          subject: input.subject,
          body_html: input.bodyHtml,
          status: "draft",
        });
        return { id: r.id, costInputTokens: 0 };
      }
      if (isAiDelegated(ctx)) {
        const workItem: AiWorkItem = {
          kind: "ai_work_item",
          task: `Write the HTML body of newsletter campaign "${input.subject}"`,
          instructions: { system: DRAFT_SYSTEM_PROMPT, user: input.brief },
          responseFormat: "text",
          apply: {
            tool: "draft_newsletter_campaign",
            args: { slug: input.slug, subject: input.subject, brief: input.brief },
            resultArg: "bodyHtml",
          },
        };
        return { workItem };
      }
      // Only reached on the install-side path: an answered or delegated
      // call never touches ctx.ai, so it must not need the handle either.
      if (!ctx.ai) throw new Error("draft_campaign: ai_provider capability required");
      const completion = await ctx.ai.complete({
        system: DRAFT_SYSTEM_PROMPT,
        messages: [{ role: "user", content: input.brief }],
        maxTokens: 800,
      });
      const r = await ctx.query.insert("campaigns", {
        slug: input.slug,
        subject: input.subject,
        body_html: completion.text,
        status: "draft",
      });
      return { id: r.id, costInputTokens: completion.inputTokens };
    },

    /**
     * Apply an approved send. The arguments are what the operator approved
     * (send-runs.ts): this records them, with the recipients as of now, as
     * one `send_runs` row in private storage — the only write, so the
     * approval exists completely or not at all. The worker sends it.
     */
    send_campaign: async (ctx, args) => {
      const input = sendCampaignArgs.parse(args);
      // Before anything is read or written: without private storage there
      // is nowhere to record the approval.
      const admin = adminQueryOf(ctx);
      const rows = await ctx.query.list<
        "campaigns",
        { id: string; status: string; subject: string; body_html: string }
      >("campaigns", { id: input.campaignId, limit: 1 });
      const campaign = rows[0];
      if (!campaign) throw new Error("send_campaign: campaign not found");
      // Only a draft is sendable: re-sending would email every subscriber
      // a second time, and that cannot be recalled.
      if (campaign.status !== "draft") {
        throw new Error(
          `send_campaign: campaign is '${campaign.status}', not 'draft' — it was already sent or queued`,
        );
      }
      if (campaign.subject !== input.subject || campaign.body_html !== input.bodyHtml) {
        throw new Error(
          "send_campaign: the draft changed after it was shown for approval — nothing was queued. Read it again with get_newsletter_campaign and ask the operator to approve the current version.",
        );
      }
      const earlier = await admin.list<"send_runs", { status: string }>("send_runs", {
        campaign_id: input.campaignId,
        limit: 1,
      });
      if (earlier[0]) {
        throw new Error(
          `send_campaign: this campaign already has an approved send ('${earlier[0].status}') — an approval is used once; draft a new campaign to send again`,
        );
      }
      const { recipients, invalid } = eligibleRecipients(
        await allSubscribers(ctx, "send_campaign"),
      );
      if (recipients.length > input.recipientCount) {
        throw new Error(
          `send_campaign: ${recipients.length} subscribers would receive it, but the approval covers at most ${input.recipientCount} — nothing was queued. Ask the operator to approve the current count.`,
        );
      }
      const run = await admin.insert("send_runs", {
        campaign_id: input.campaignId,
        subject: input.subject,
        body_html: input.bodyHtml,
        recipients,
        recipient_count: recipients.length,
        status: "approved",
        approved_by: ctx.invocation.actorId,
      });
      return { queued: recipients.length, skippedInvalidAddresses: invalid, runId: run.id };
    },

    /** Worker: sends approved runs, a batch per tick (send-runs.ts). */
    _drain_sends: async (ctx, _args) => drainSends(ctx),
  },
  workers: [{ name: "drain_sends", cron: "0 * * * * *", operationName: "_drain_sends" }],
  tools: [
    {
      name: "list_newsletter_campaigns",
      description:
        "List newsletter campaigns (id, slug, subject, status draft/queued/sending/sent, dates) and how many confirmed subscribers a send would reach. " +
        "Use before sending, to find a draft's id, or when the operator asks what went out.",
      operationName: "list_campaigns",
      requiredPermission: "settings.write",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      name: "draft_newsletter_campaign",
      description:
        "Draft a newsletter campaign from a brief: the newsletter's own writer produces the HTML and it is saved as a DRAFT — nothing is sent. " +
        "Pass a unique slug, the subject line, and a brief with the content, tone and call to action. Send it later with send_newsletter_campaign. " +
        "Over the Power-MCP you write the HTML yourself: the call returns a `workItem` (the writer's prompt) and saves nothing — answer it and call this tool again with the same slug, subject and brief plus your HTML as `bodyHtml`. " +
        "Pass `bodyHtml` only when answering such a work item.",
      operationName: "draft_campaign",
      // Spends the install's AI unless answered or delegated (#741).
      usesInstallAi: true,
      requiredPermission: "settings.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "subject", "brief"],
        properties: {
          slug: { type: "string", minLength: 1, maxLength: 120 },
          subject: { type: "string", minLength: 1, maxLength: 300 },
          brief: { type: "string", minLength: 1, maxLength: 8000 },
          bodyHtml: {
            type: "string",
            minLength: 1,
            maxLength: MAX_BODY_HTML_LENGTH,
            description:
              "Your answer to this tool's work item: the campaign as plain HTML. Omit to let the site's writer produce it.",
          },
        },
      },
    },
    {
      name: "get_newsletter_campaign",
      description:
        "Read one newsletter campaign: subject, the full body HTML, its status, and `recipientCount` — how many subscribers a send would reach now. " +
        "Call it right before send_newsletter_campaign and pass its subject, bodyHtml and recipientCount to that tool unchanged.",
      operationName: "get_campaign",
      requiredPermission: "settings.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["campaignId"],
        properties: { campaignId: { type: "string", format: "uuid" } },
      },
    },
    {
      name: "send_newsletter_campaign",
      description:
        "Send a DRAFT newsletter campaign to its confirmed subscribers. " +
        "First call get_newsletter_campaign and pass its subject, bodyHtml and recipientCount here UNCHANGED: the operator's approval card shows exactly these, and exactly this content goes to at most that many subscribers. " +
        "APPROVAL-GATED: this PAUSES for the operator's Approve in the chat before anything is queued — emails that went out cannot be recalled. " +
        "Do not claim it was sent until approved. Only drafts can be sent, and each campaign only once.",
      operationName: "send_campaign",
      requiredPermission: "settings.write",
      approvalMode: "user-approval",
      approvalPreviewFullArgs: ["subject", "bodyHtml"],
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["campaignId", "subject", "bodyHtml", "recipientCount"],
        properties: {
          campaignId: { type: "string", format: "uuid" },
          subject: { type: "string", minLength: 1, maxLength: 300 },
          bodyHtml: { type: "string", minLength: 1, maxLength: MAX_BODY_HTML_LENGTH },
          recipientCount: { type: "integer", minimum: 0, maximum: 1000 },
        },
      },
    },
  ],
  /**
   * Web Component `<caelo-newsletter-form>` — visitor signup form.
   *
   * Attributes: none.
   * Posts email to /api/plugin/newsletter/subscribe; user receives a
   * confirmation email (when ctx.email transport is configured).
   */
  component: defineComponent({
    tag: "caelo-newsletter-form",
    shadowMode: "open",
    mounted: async (host) => {
      const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const extraCss = `
        form { grid-template-columns: 1fr auto; gap: 0.5rem; max-width: 24rem; }
      `;
      root.innerHTML = `
        <style>${KIT_CSS}${extraCss}</style>
        <form novalidate>
          <input name="email" type="email" placeholder="you@example.com" required />
          <button type="submit">Subscribe</button>
          ${honeypotFieldHtml()}
        </form>
        <p data-status aria-live="polite"></p>
      `;
      const form = root.querySelector("form") as HTMLFormElement;
      const status = root.querySelector("[data-status]") as HTMLParagraphElement;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        setStatus(status, "clear");
        const fd = new FormData(form);
        if (isHoneypotTripped(fd)) {
          setStatus(status, "ok", "Check your inbox to confirm.");
          form.reset();
          return;
        }
        try {
          const captcha = await attachCaptchaProof().catch(() => null);
          const json = await postPluginJson("newsletter", "subscribe", {
            email: fd.get("email"),
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (json.ok) {
            setStatus(status, "ok", "Check your inbox to confirm.");
            form.reset();
          } else {
            setStatus(status, "err", json.error?.message ?? "Subscription failed.");
          }
        } catch (e) {
          setStatus(status, "err", `Network error: ${(e as Error).message}`);
        }
      });
    },
  }),
});
