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
  HONEYPOT_FIELD_NAME,
  honeypotBodyField,
  honeypotFieldHtml,
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

/** A visitor's signup (#1332): validated by the host before `subscribe` runs. */
const subscribeInput = z
  .object({
    // 254 is the longest address SMTP delivers.
    email: z
      .string()
      .trim()
      .max(254)
      .regex(/^[^\s@]+@[^\s@]+$/, "an email address"),
    [HONEYPOT_FIELD_NAME]: z.string().max(500).optional(),
  })
  .strict();

/**
 * A confirm or unsubscribe link's token (#1332). An unsubscribe token is
 * longer than a confirm token but fits: 80 characters (#1432).
 */
const tokenInput = z
  .object({
    token: z
      .string()
      .refine((t) => t.trim().length >= 16, "too short")
      .max(128),
  })
  .strict();

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

export default definePlugin<PluginContextTier1>({
  slug: "newsletter",
  version: "1.1.0",
  tier: 1,
  schema: {
    subscribers: {
      id: "uuid",
      email: "string",
      email_hash: "string",
      confirm_token: "string",
      /** #1337 — the double opt-in link expires; a new subscribe sends a new one. */
      confirm_expires_at: "timestamp_nullable",
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
  /** #1292 — the visitor links look subscribers up by hash or token; the worker reads runs oldest first. */
  indexes: {
    schema: {
      subscribers: [["email_hash"], ["confirm_token"], ["unsub_token"]],
      campaigns: [["created_at"]],
      sends: [["status", "created_at"]],
    },
    adminSchema: {
      send_runs: [["campaign_id", "created_at"], ["status", "created_at"], ["created_at"]],
      send_progress: [["created_at"]],
    },
  },
  requestedCapabilities: [
    "ai_provider",
    "email",
    "background_workers",
    "chat_runner_tools",
    "cms_admin_schema",
  ],
  /**
   * #1332 (E12) — a newsletter without mail cannot confirm a single
   * subscriber, so activation needs a configured mail transport first.
   */
  requires: ["email"],
  /**
   * #1337 — the double opt-in mail. Queued by `subscribe` into the public
   * outbox; the admin sends it with the link on this environment's host.
   */
  mailTemplates: {
    confirm_subscription: {
      subject: "Confirm your newsletter subscription",
      body: [
        "Please confirm that you want to receive this site's newsletter.",
        "If you did not sign up, ignore this mail: without your confirmation you will not get any newsletter.",
      ],
      link: {
        operation: "confirm",
        label: "Confirm subscription",
        done: "Thank you, your subscription is confirmed.",
      },
    },
  },
  /**
   * #1432 — the unsubscribe link of a campaign mail. The host signs the
   * token per subscriber and refuses any other, so opening the page changes
   * nothing, its button works, and a mail client's one-click POST (RFC 8058)
   * works without a proof-of-work.
   */
  mailUnsubscribe: {
    operation: "unsubscribe",
    label: "Unsubscribe",
    done: "You are unsubscribed and will get no more of this newsletter.",
  },
  /**
   * #1332 — subscribers are visitor state: a visitor's own confirm and
   * unsubscribe links find their row by token. Campaigns and the per-
   * recipient send log are the admin's; no visitor reaches them.
   */
  tableKinds: { subscribers: "visitor-state", campaigns: "private", sends: "private" },
  /** Visitor-facing surface (default deny — everything else is
   *  refused a visitor-context dispatch). */
  publicOperations: [
    {
      name: "subscribe",
      kind: "write",
      input: subscribeInput,
      rateLimit: { max: 5, windowSeconds: 60 },
      reads: ["subscribers"],
      writes: ["subscribers"],
      // #1340 — core's double opt-in: one answer for every address, a
      // confirmation link valid for 48 hours (#1337), a repeated sign-up
      // mails the link still valid; a filled honeypot stores nothing.
      run: {
        action: "block",
        block: "double-opt-in.subscribe",
        options: { table: "subscribers", template: "confirm_subscription", hours: 48 },
      },
    },
    {
      name: "confirm",
      kind: "write",
      input: tokenInput,
      rateLimit: { max: 10, windowSeconds: 60 },
      reads: ["subscribers"],
      writes: ["subscribers"],
      run: { action: "block", block: "double-opt-in.confirm", options: { table: "subscribers" } },
    },
    {
      name: "unsubscribe",
      kind: "write",
      input: tokenInput,
      rateLimit: { max: 10, windowSeconds: 60 },
      reads: ["subscribers"],
      writes: ["subscribers"],
      // #1432 — the host signed the token per recipient and checks it first.
      run: {
        action: "block",
        block: "mail.unsubscribe",
        options: { table: "subscribers", column: "unsubscribed_at" },
      },
    },
  ],
  operations: {
    /**
     * P6 (#1336, M5) — one answer for every address: new, waiting for
     * confirmation, already confirmed, or a honeypot hit. No id and no
     * status crosses back, so nobody can learn whether an address is on
     * the list by subscribing it.
     */
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
  /** Campaigns in the admin (rendered from this declaration). */
  adminPanels: [
    {
      slug: "campaigns",
      title: "Newsletter",
      description: "Draft campaigns and send them to your subscribers.",
      icon: "mail",
      permission: "settings.write",
      sections: [
        {
          kind: "stats",
          id: "audience",
          title: "Audience",
          operation: "list_campaigns",
          items: [{ key: "subscriberCount", label: "Confirmed subscribers", format: "number" }],
        },
        {
          kind: "form",
          id: "draft",
          title: "Draft a new campaign",
          description:
            "The AI writes the body from your brief. You review it before anything is sent.",
          operation: "draft_campaign",
          fields: [
            {
              arg: "slug",
              label: "Slug",
              input: "text",
              required: true,
              placeholder: "spring-launch",
              maxLength: 120,
            },
            {
              arg: "subject",
              label: "Subject",
              input: "text",
              required: true,
              placeholder: "Our spring lineup is here",
              maxLength: 300,
            },
            {
              arg: "brief",
              label: "Brief: what should the AI write about?",
              input: "textarea",
              required: true,
              maxLength: 8000,
            },
          ],
          submitLabel: "Draft with AI",
          successMessage: "Draft created. Review it in the campaign list to send it.",
        },
        {
          kind: "table",
          id: "campaigns",
          title: "Campaigns",
          description:
            "Sends go out within minutes of your approval. The AI can list, draft and (with your approval) send campaigns too.",
          operation: "list_campaigns",
          rowsKey: "campaigns",
          rowKey: "id",
          emptyMessage: "No campaigns yet.",
          columns: [
            { key: "subject", label: "Subject", format: "text" },
            { key: "slug", label: "Slug", format: "code" },
            {
              key: "status",
              label: "Status",
              format: "badge",
              badgeVariants: { draft: "secondary" },
            },
            { key: "approvedSend.status", label: "Send", format: "text" },
            { key: "approvedSend.processed", label: "Processed", format: "number" },
            { key: "approvedSend.recipientCount", label: "Recipients", format: "number" },
            { key: "created_at", label: "Created", format: "datetime" },
          ],
          rowActions: [
            {
              id: "send",
              label: "Review and send",
              operation: "send_campaign",
              variant: "default",
              rowArgs: { campaignId: "id" },
              when: [
                { key: "status", in: ["draft"] },
                { key: "approvedSend", in: [null] },
              ],
              // #635 — the Owner approves the content and the recipient
              // bound they saw; send_campaign refuses a draft that changed.
              review: {
                operation: "get_campaign",
                title: "Review before sending",
                description:
                  "Exactly this subject and body go to at most {recipientCount} subscriber(s). Emails that went out cannot be recalled.",
                fields: [
                  { key: "subject", label: "Subject", format: "text" },
                  { key: "bodyHtml", label: "Body (HTML source)", format: "multiline" },
                  { key: "recipientCount", label: "Recipients at most", format: "number" },
                ],
                submitArgs: {
                  campaignId: "id",
                  subject: "subject",
                  bodyHtml: "bodyHtml",
                  recipientCount: "recipientCount",
                },
                submitWhen: [{ key: "status", in: ["draft"] }],
                unavailableMessage: "This campaign is {status}; only drafts can be sent.",
                submitLabel: "Send exactly this",
              },
              confirm: {
                title: "Send this campaign?",
                description: "Emails that went out cannot be recalled.",
                confirmLabel: "Send",
              },
              successMessage: "Approved: {queued} emails go out within a few minutes.",
            },
          ],
        },
      ],
    },
  ],
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
        try {
          const captcha = await attachCaptchaProof("newsletter", "subscribe").catch(() => null);
          // The honeypot rides along; `subscribe` judges it server-side.
          const json = await postPluginJson("newsletter", "subscribe", {
            email: fd.get("email"),
            ...honeypotBodyField(fd),
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
