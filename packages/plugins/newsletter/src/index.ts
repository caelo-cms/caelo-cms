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
 *   send_newsletter_campaign  — queues a draft to every confirmed subscriber.
 *                               APPROVAL-GATED (§11.A): an email that went
 *                               out cannot be recalled.
 */

import {
  attachCaptchaProof,
  honeypotFieldHtml,
  isHoneypotTripped,
  KIT_CSS,
  postPluginJson,
  setStatus,
} from "@caelo-cms/plugin-component-kit";
import { defineComponent, definePlugin, type PluginContextTier1, z } from "@caelo-cms/plugin-sdk";

const draftCampaignArgs = z
  .object({
    slug: z.string().min(1).max(120),
    subject: z.string().min(1).max(300),
    brief: z.string().min(1).max(8000),
  })
  .strict();

const sendCampaignArgs = z.object({ campaignId: z.string().uuid() }).strict();

/** Most rows one `ctx.query.list` returns (the SDK's cap). */
const SUBSCRIBER_LIST_CAP = 1000;

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
    sends: {
      id: "uuid",
      campaign_id: "string",
      subscriber_id: "string",
      status: "enum:pending,sent,failed",
      error: "text",
      created_at: "timestamp",
      sent_at: "timestamp_nullable",
    },
  },
  requestedCapabilities: ["ai_provider", "email", "background_workers", "chat_runner_tools"],
  /** Visitor-facing surface (default deny — everything else is
   *  refused a visitor-context dispatch). */
  publicOperations: ["subscribe", "confirm", "unsubscribe"],
  operations: {
    subscribe: async (ctx, args) => {
      const input = args as { email: string };
      if (!input.email.includes("@")) throw new Error("subscribe: invalid email");
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

    /** Campaigns (newest first) + how many confirmed subscribers a send reaches. */
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
      const subs = await ctx.query.list<
        "subscribers",
        { confirmed_at: string | null; unsubscribed_at: string | null }
      >("subscribers", { limit: SUBSCRIBER_LIST_CAP });
      const subscriberCount = subs.filter((s) => s.confirmed_at && !s.unsubscribed_at).length;
      return {
        // The query handle reads at most SUBSCRIBER_LIST_CAP rows; at the
        // cap the count is a lower bound and send_campaign refuses.
        subscriberListTruncated: subs.length >= SUBSCRIBER_LIST_CAP,
        campaigns: campaigns.map(({ id, slug, subject, status, created_at, sent_at }) => ({
          id,
          slug,
          subject,
          status,
          created_at,
          sent_at,
        })),
        subscriberCount,
      };
    },

    draft_campaign: async (ctx, args) => {
      const input = draftCampaignArgs.parse(args);
      if (!ctx.ai) throw new Error("draft_campaign: ai_provider capability required");
      const completion = await ctx.ai.complete({
        system:
          "Write a single newsletter campaign in clean HTML — header, 1-3 sections, CTA. Plain HTML only, no markdown, no extra commentary.",
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

    send_campaign: async (ctx, args) => {
      const input = sendCampaignArgs.parse(args);
      const campaign = await ctx.query.list<"campaigns", { id: string; status: string }>(
        "campaigns",
        { id: input.campaignId, limit: 1 },
      );
      if (!campaign[0]) throw new Error("send_campaign: campaign not found");
      // Only a draft is sendable: re-queuing a queued/sent campaign would
      // email every subscriber a second time, and that cannot be recalled.
      if (campaign[0].status !== "draft") {
        throw new Error(
          `send_campaign: campaign is '${campaign[0].status}', not 'draft' — it was already sent or queued`,
        );
      }
      const subs = await ctx.query.list<
        "subscribers",
        { id: string; confirmed_at: string | null; unsubscribed_at: string | null }
      >("subscribers", { limit: SUBSCRIBER_LIST_CAP });
      // Fail loudly rather than silently mail only the first page.
      if (subs.length >= SUBSCRIBER_LIST_CAP) {
        throw new Error(
          `send_campaign: ${SUBSCRIBER_LIST_CAP}+ subscriber rows — this sender cannot reach all of them yet, so nothing was queued`,
        );
      }
      // Claim the draft atomically BEFORE enqueueing: two overlapping sends
      // (a double-click, a retried tool call) both read 'draft' above, but
      // only one wins this swap — the other would otherwise enqueue every
      // subscriber a second time.
      const claimed = await ctx.query.compareAndSwap(
        "campaigns",
        input.campaignId,
        { status: "draft" },
        { status: "sending" },
      );
      if (!claimed) {
        throw new Error("send_campaign: campaign is no longer a draft — another send claimed it");
      }
      let queued = 0;
      for (const s of subs) {
        if (!s.confirmed_at || s.unsubscribed_at) continue;
        await ctx.query.insert("sends", {
          campaign_id: input.campaignId,
          subscriber_id: s.id,
          status: "pending",
        });
        queued += 1;
      }
      await ctx.query.update("campaigns", input.campaignId, { status: "queued" });
      return { queued };
    },

    /**
     * Worker handler. Drains up to 10 pending sends per tick; calls
     * ctx.email.send for each. Failure marks the row failed; success
     * marks sent. P13 wires real rate-limiting + retry.
     */
    _drain_sends: async (ctx, _args) => {
      const pending = await ctx.query.list<
        "sends",
        { id: string; campaign_id: string; subscriber_id: string }
      >("sends", { status: "pending", limit: 10 });
      let sent = 0;
      for (const send of pending) {
        const sub = await ctx.query.list<"subscribers", { email: string; unsub_token: string }>(
          "subscribers",
          { id: send.subscriber_id, limit: 1 },
        );
        const camp = await ctx.query.list<"campaigns", { subject: string; body_html: string }>(
          "campaigns",
          { id: send.campaign_id, limit: 1 },
        );
        if (!sub[0] || !camp[0]) {
          await ctx.query.update("sends", send.id, { status: "failed", error: "missing record" });
          continue;
        }
        try {
          if (!ctx.email) throw new Error("no email transport configured");
          await ctx.email.send({
            to: sub[0].email,
            subject: camp[0].subject,
            html: `${camp[0].body_html}<hr/><p style="font-size:12px"><a href="/api/plugin/newsletter/unsubscribe?token=${sub[0].unsub_token}">Unsubscribe</a></p>`,
          });
          await ctx.query.update("sends", send.id, {
            status: "sent",
            sent_at: new Date().toISOString(),
          });
          sent += 1;
        } catch (e) {
          await ctx.query.update("sends", send.id, {
            status: "failed",
            error: (e as Error).message,
          });
        }
      }
      return { sent, attempted: pending.length };
    },
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
        "Pass a unique slug, the subject line, and a brief with the content, tone and call to action. Send it later with send_newsletter_campaign.",
      operationName: "draft_campaign",
      requiredPermission: "settings.write",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "subject", "brief"],
        properties: {
          slug: { type: "string", minLength: 1, maxLength: 120 },
          subject: { type: "string", minLength: 1, maxLength: 300 },
          brief: { type: "string", minLength: 1, maxLength: 8000 },
        },
      },
    },
    {
      name: "send_newsletter_campaign",
      description:
        "Send a DRAFT newsletter campaign to every confirmed subscriber. " +
        "APPROVAL-GATED: this PAUSES for the operator's Approve in the chat before anything is queued — emails that went out cannot be recalled. " +
        "Before calling, tell the operator the subject and the recipient count (list_newsletter_campaigns). Do not claim it was sent until approved. Only drafts can be sent.",
      operationName: "send_campaign",
      requiredPermission: "settings.write",
      approvalMode: "user-approval",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["campaignId"],
        properties: { campaignId: { type: "string", format: "uuid" } },
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
