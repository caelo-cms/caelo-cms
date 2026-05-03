// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-forms — Tier-1 plugin: contact + generic form submissions.
 *
 * P12 PR2.1 — first visitor-facing plugin built on the SDK that P11/P11.5/P12
 * pioneered. Validates ctx.query (cms_public RLS-scoped writes), ctx.visitor
 * (records who submitted), ctx.captcha (P12 stub), gateway dispatch via
 * `POST /api/plugin/forms/submit`, and chat-runner tool registration.
 *
 * Schema (cms_public.plugin_forms.*):
 *   forms              — form definitions (slug, fields, locale)
 *   form_submissions   — visitor-supplied data, status, visitor id
 *
 * Operations:
 *   submit             — PUBLIC. Visitor calls via gateway. Captcha-gated.
 *   list_submissions   — admin. Optional filter by form slug + status.
 *   mark_read          — admin. status='new' → 'read'.
 *   archive            — admin. Any status → 'archived'.
 *   create_form        — admin. Owner-curated form definition.
 *   summarize          — admin. Calls ctx.ai.complete on recent submissions.
 *
 * AI tools:
 *   list_form_submissions     — read-only browse for the chat-runner.
 *   summarize_form_submissions — wraps the summarize op.
 */

import {
  attachCaptchaProof,
  HONEYPOT_FIELD_NAME,
  honeypotFieldHtml,
  isHoneypotTripped,
  KIT_CSS,
  postPluginJson,
  setStatus,
} from "@caelo/plugin-component-kit";
import { defineComponent, definePlugin, type PluginContextTier1 } from "@caelo/plugin-sdk";

const SLUG = "forms";

interface SubmitInput {
  formSlug: string;
  pageId?: string;
  locale: string;
  data: Record<string, unknown>;
  /** Honeypot — hidden field auto-injected by &lt;caelo-form&gt;. Bots fill this; humans don't. */
  honeypot?: string | null;
  captchaToken?: string | null;
}

interface ListSubmissionsInput {
  formSlug?: string;
  status?: "new" | "read" | "archived" | "spam";
  limit?: number;
}

interface SubmissionRow {
  id: string;
  form_slug: string;
  page_id: string | null;
  locale: string;
  visitor_id: string;
  data: Record<string, unknown>;
  status: string;
  submitted_at: string;
}

export default definePlugin<PluginContextTier1>({
  slug: SLUG,
  version: "1.0.0",
  tier: 1,
  schema: {
    forms: {
      id: "uuid",
      slug: "string",
      display_name: "string",
      schema_json: "jsonb",
      locale: "string",
      created_at: "timestamp",
    },
    form_submissions: {
      id: "uuid",
      form_slug: "string",
      page_id: "string",
      locale: "string",
      visitor_id: "string",
      data: "jsonb",
      status: "enum:new,read,archived,spam",
      submitted_at: "timestamp",
    },
  },
  requestedCapabilities: ["cms_admin", "ai_provider", "chat_runner_tools", "email"],
  operations: {
    /**
     * `submit` — PUBLIC visitor write. Routes through the gateway:
     *   POST /api/plugin/forms/submit
     *   { formSlug, pageId?, locale, data: {...}, captchaToken? }
     *
     * 1. Captcha gate (P12 stub passes everything in dev; P13 hardens).
     * 2. Verify the form definition exists.
     * 3. Insert into form_submissions with visitor_id from ctx.visitor.
     */
    submit: async (ctx, args) => {
      const input = args as SubmitInput;
      if (!input.formSlug || !input.locale || !input.data) {
        throw new Error("submit: formSlug, locale, data are required");
      }
      // Honeypot — bots fill the hidden field; mark spam silently and
      // return success so the bot doesn't retry. Real users never trip this.
      const honeypotTripped = (input.honeypot ?? "").trim() !== "";
      const ok = await ctx.captcha.requireProof(input.captchaToken ?? null);
      if (!ok) throw new Error("submit: captcha verification failed");

      // Confirm the form exists. Cheap RLS-scoped read.
      const forms = await ctx.query.list<"forms", { slug: string }>("forms", {
        slug: input.formSlug,
        limit: 1,
      });
      if (forms.length === 0) {
        throw new Error(`submit: no form with slug "${input.formSlug}"`);
      }

      const r = await ctx.query.insert("form_submissions", {
        form_slug: input.formSlug,
        page_id: input.pageId ?? "",
        locale: input.locale,
        visitor_id: ctx.visitor.id,
        data: input.data,
        status: honeypotTripped ? "spam" : "new",
      });
      return { submissionId: r.id, ...(honeypotTripped ? { honeypot: true } : {}) };
    },

    /**
     * `list_submissions` — admin read. Optional filter by formSlug + status.
     */
    list_submissions: async (ctx, args) => {
      const input = (args ?? {}) as ListSubmissionsInput;
      const filter: Record<string, unknown> = {};
      if (input.formSlug) filter.form_slug = input.formSlug;
      if (input.status) filter.status = input.status;
      filter.orderBy = "submitted_at";
      filter.orderDir = "desc";
      filter.limit = Math.min(input.limit ?? 50, 200);
      const rows = await ctx.query.list<"form_submissions", SubmissionRow>(
        "form_submissions",
        filter,
      );
      return { submissions: rows };
    },

    mark_read: async (ctx, args) => {
      const input = args as { submissionId: string };
      await ctx.query.update("form_submissions", input.submissionId, { status: "read" });
      return { updated: input.submissionId };
    },

    archive: async (ctx, args) => {
      const input = args as { submissionId: string };
      await ctx.query.update("form_submissions", input.submissionId, { status: "archived" });
      return { updated: input.submissionId };
    },

    create_form: async (ctx, args) => {
      const input = args as {
        slug: string;
        displayName: string;
        schemaJson: Record<string, unknown>;
        locale: string;
      };
      const r = await ctx.query.insert("forms", {
        slug: input.slug,
        display_name: input.displayName,
        schema_json: input.schemaJson,
        locale: input.locale,
      });
      return { formId: r.id };
    },

    /**
     * `summarize` — uses ctx.ai.complete on the latest 50 submissions to
     * produce a short Owner brief ("23 submissions; 6 mention pricing").
     * Returns "no submissions" if empty so the AI tool gives a clean answer.
     */
    summarize: async (ctx, args) => {
      const input = (args ?? {}) as { formSlug?: string; since?: string };
      if (!ctx.ai) throw new Error("summarize: ai_provider capability not granted");
      const filter: Record<string, unknown> = {
        limit: 50,
        orderBy: "submitted_at",
        orderDir: "desc",
      };
      if (input.formSlug) filter.form_slug = input.formSlug;
      if (input.since) filter.since = input.since;
      const rows = await ctx.query.list<"form_submissions", SubmissionRow>(
        "form_submissions",
        filter,
      );
      if (rows.length === 0) {
        return { summary: "No submissions in the requested window." };
      }
      const sample = rows
        .slice(0, 20)
        .map((r) => `- [${r.status}] ${JSON.stringify(r.data).slice(0, 200)}`)
        .join("\n");
      const completion = await ctx.ai.complete({
        system:
          "You summarise visitor form submissions for a CMS Owner. Be terse: count, the 3-5 most common themes, and any ALL-CAPS or angry-sounding ones flagged separately. Plain text only.",
        messages: [
          {
            role: "user",
            content: `Summarise these ${rows.length} submissions:\n${sample}`,
          },
        ],
        maxTokens: 400,
      });
      return { summary: completion.text, totalConsidered: rows.length };
    },
  },
  tools: [
    {
      name: "list_form_submissions",
      description:
        "Browse visitor form submissions. Read-only. Optional filter by formSlug + status (new/read/archived/spam). Returns up to 200 rows ordered by submitted_at desc.",
      operationName: "list_submissions",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          formSlug: { type: "string" },
          status: { type: "string", enum: ["new", "read", "archived", "spam"] },
          limit: { type: "number", minimum: 1, maximum: 200 },
        },
      },
    },
    {
      name: "summarize_form_submissions",
      description:
        "Produce a short summary of recent form submissions (count + common themes + flagged ones). Pass `formSlug` to scope to one form, or `since` (ISO timestamp) to scope to a time window.",
      operationName: "summarize",
      inputJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          formSlug: { type: "string" },
          since: { type: "string" },
        },
      },
    },
  ],
  /**
   * Web Component `<caelo-form>` — visitor-facing form.
   *
   * Attributes:
   *   slug      — the form's slug (matches a row in `forms`).
   *   page-id?  — optional page id to attribute the submission.
   *   locale    — visitor locale.
   *
   * Reads `forms.schema_json` shape: `{ fields: [{name, label, type, required?}] }`.
   * Emits a hidden honeypot field (`hp_address`) and rejects locally if filled.
   * POSTs to `/api/plugin/forms/submit`.
   */
  component: defineComponent({
    tag: "caelo-form",
    shadowMode: "open",
    mounted: async (host) => {
      const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const slug = host.getAttribute("slug") ?? "";
      const pageId = host.getAttribute("page-id") ?? "";
      const locale = host.getAttribute("locale") ?? "en";

      // Default fields if no schema metadata is supplied via attribute.
      // P13 will fetch the form schema from a public read endpoint.
      const fieldsAttr = host.getAttribute("fields");
      type Field = { name: string; label: string; type?: string; required?: boolean };
      const fields: Field[] = fieldsAttr
        ? (JSON.parse(fieldsAttr) as Field[])
        : [
            { name: "name", label: "Your name", type: "text", required: true },
            { name: "email", label: "Your email", type: "email", required: true },
            { name: "message", label: "Message", type: "textarea", required: true },
          ];

      const fieldHtml = fields
        .map((f) => {
          const id = `field-${f.name}`;
          const inputEl =
            f.type === "textarea"
              ? `<textarea id="${id}" name="${f.name}" rows="4"${f.required ? " required" : ""}></textarea>`
              : `<input id="${id}" name="${f.name}" type="${f.type ?? "text"}"${f.required ? " required" : ""} />`;
          return `<label for="${id}"><span>${f.label}</span>${inputEl}</label>`;
        })
        .join("");

      root.innerHTML = `
        <style>${KIT_CSS}</style>
        <form novalidate>
          ${fieldHtml}
          ${honeypotFieldHtml()}
          <button type="submit">Send</button>
          <p data-status aria-live="polite"></p>
        </form>
      `;

      const form = root.querySelector("form") as HTMLFormElement;
      const status = root.querySelector("[data-status]") as HTMLParagraphElement;
      const button = root.querySelector("button") as HTMLButtonElement;
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        setStatus(status, "clear");
        button.disabled = true;
        const fd = new FormData(form);
        if (isHoneypotTripped(fd)) {
          // Silently succeed for bots — real users see success too.
          setStatus(status, "ok", "Thanks — we'll be in touch.");
          form.reset();
          button.disabled = false;
          return;
        }
        const data: Record<string, unknown> = {};
        for (const f of fields) data[f.name] = fd.get(f.name) ?? "";
        try {
          const captcha = await attachCaptchaProof().catch(() => null);
          const json = await postPluginJson(SLUG, "submit", {
            formSlug: slug,
            pageId: pageId || undefined,
            locale,
            data,
            honeypot: (fd.get(HONEYPOT_FIELD_NAME) as string | null) ?? "",
            captchaToken: "dev",
            ...(captcha ? { _caelo_captcha: captcha } : {}),
          });
          if (json.ok) {
            setStatus(status, "ok", "Thanks — we'll be in touch.");
            form.reset();
          } else {
            setStatus(status, "err", json.error?.message ?? "Submission failed.");
          }
        } catch (e) {
          setStatus(status, "err", `Network error: ${(e as Error).message}`);
        } finally {
          button.disabled = false;
        }
      });
    },
  }),
  promptContext: [
    {
      label: "forms",
      render: async (ctx) => {
        if (!("query" in ctx)) return "";
        try {
          const newOnes = await ctx.query.list<"form_submissions", { id: string }>(
            "form_submissions",
            { status: "new", limit: 1 },
          );
          if (newOnes.length === 0) return "";
          // Tiny aggregator query.
          const all = await ctx.query.list<"form_submissions", { id: string; form_slug: string }>(
            "form_submissions",
            { status: "new", limit: 200 },
          );
          const byForm = new Map<string, number>();
          for (const r of all) byForm.set(r.form_slug, (byForm.get(r.form_slug) ?? 0) + 1);
          const lines = [...byForm.entries()].map(([slug, n]) => `- ${slug}: ${n} unread`);
          return ["# Form submissions awaiting review", ...lines].join("\n");
        } catch {
          return "";
        }
      },
    },
  ],
});
