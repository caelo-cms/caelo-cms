// SPDX-License-Identifier: MPL-2.0

/**
 * Read tools for the operator dashboards the agent could not see (agent-tool
 * parity, part 2): AI spend, a plugin's detail + AI spend against its cap,
 * the public gateway's traffic, request log and rate-limit profiles, the
 * email transport, filed bug reports and the media CDN settings.
 *
 * Every one is a pure read over an op that already admits the AI actor; the
 * operator panels render the same ops. They exist so "what did we spend on
 * AI this month?", "is the contact form being hammered?" or "is email set
 * up?" get answered in the chat instead of sending the operator to a panel.
 * Several return raw values that must not enter the transcript (a plugin's
 * full source, email transport config), so those set `includeValue: false`
 * and render only what the model needs.
 */

import { execute } from "@caelo-cms/query-api";
import { z } from "zod";
import type { listBugReportsOp } from "../../ops/ai/bug-reports.js";
import type { getEmailConfigOp } from "../../ops/email_config.js";
import type {
  listGatewayAnalyticsOp,
  listGatewayRequestsOp,
  listRateLimitProfilesOp,
} from "../../ops/gateway.js";
import type { mediaGetSettingsOp } from "../../ops/media.js";
import type { getPluginOp } from "../../ops/plugins/registry.js";
import type { aggregateAiCallsOp, aggregatePluginAiSpendOp } from "../../ops/security/ai_calls.js";
import type { aggregateAuditByOpPrefixOp } from "../../ops/security/ai_calls_by_op.js";
import { describeError } from "./_describe-error.js";
import { makeListReadTool, makeReadTool } from "./_make-read-tool.js";
import type { ToolDefinitionWithHandler } from "./dispatch.js";

type OpValue<O extends { output: z.ZodType }> = z.infer<O["output"]>;

const noInput = z.object({}).strict();

/** Microcents (1e-8 USD) → "$1.23"; null → "uncapped". */
function usdFromMicrocents(microcents: number | null): string {
  return microcents === null ? "uncapped" : `$${(microcents / 100_000_000).toFixed(2)}`;
}

const usd = (v: number): string => `$${v.toFixed(2)}`;

// ─── AI spend ────────────────────────────────────────────────────────

const aiSpendInput = z
  .object({
    sinceDays: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe("Window in days, counted back from now (default 30)."),
  })
  .strict();
type AiSpendInput = z.infer<typeof aiSpendInput>;

/** The cost dashboard's spend breakdown, plus where the AI's own activity went. */
export const getAiSpendTool: ToolDefinitionWithHandler<AiSpendInput> = {
  name: "get_ai_spend",
  description:
    "Report AI spend over a window (default the last 30 days): total cost + tokens, text vs image, per provider/model, per source (plugin, person, subagent), the most recent days, and which admin domains the AI's tool calls went to (op counts + failures). " +
    "Use when the operator asks what AI costs, why a budget warned, or which feature is expensive. " +
    "Not for the caps themselves (get_ai_budgets) or one plugin's spend against its cap (get_plugin).",
  schema: aiSpendInput,
  inputSchema: z.toJSONSchema(aiSpendInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const since = new Date(Date.now() - (input.sinceDays ?? 30) * 86_400_000).toISOString();
    const spend = await execute(toolCtx.registry, toolCtx.adapter, ctx, "ai_calls.aggregate", {
      since,
    });
    if (!spend.ok) {
      return { ok: false, content: `ai_calls.aggregate failed: ${describeError(spend.error)}` };
    }
    const v = spend.value as OpValue<typeof aggregateAiCallsOp>;
    const lines = [
      `AI spend since ${since.slice(0, 10)}: ${usd(v.totals.costUsd)} over ${v.totals.calls} calls ` +
        `(${v.totals.inputTokens} input / ${v.totals.outputTokens} output / ${v.totals.cachedTokens} cached tokens)`,
    ];
    if (v.perOperationType.length > 0) {
      lines.push(
        `by type: ${v.perOperationType.map((t) => `${t.operationType} ${usd(t.costUsd)} (${t.calls})`).join("; ")}`,
      );
    }
    for (const p of v.perProvider.slice(0, 10)) {
      lines.push(
        `model ${p.provider}/${p.model} (${p.operationType}): ${usd(p.costUsd)} (${p.calls} calls)`,
      );
    }
    for (const a of v.perAttribution.slice(0, 10)) {
      lines.push(`source ${a.kind} ${a.label}: ${usd(a.costUsd)} (${a.calls} calls)`);
    }
    for (const d of v.perDay.slice(-7)) {
      lines.push(`day ${d.day}: ${usd(d.costUsd)} (${d.calls} calls)`);
    }
    const activity = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "audit_events.aggregate_by_op_prefix",
      { sinceIso: since },
    );
    if (activity.ok) {
      const rows = (activity.value as OpValue<typeof aggregateAuditByOpPrefixOp>).rows;
      if (rows.length > 0) {
        lines.push(
          `AI activity by domain (ops run, failures): ${rows
            .slice(0, 15)
            .map((r) => `${r.opPrefix} ${r.opCount}/${r.failureCount}`)
            .join(", ")}`,
        );
      }
    } else {
      lines.push(`AI activity by domain unavailable: ${describeError(activity.error)}`);
    }
    return { ok: true, content: lines.join("\n"), value: v };
  },
};

// ─── plugin detail ───────────────────────────────────────────────────

const getPluginInput = z
  .object({ slug: z.string().min(1).max(120).describe("Plugin slug as list_plugins shows it.") })
  .strict();
type GetPluginInput = z.infer<typeof getPluginInput>;

/** Names from a manifest array of `{ name }` objects (tools, skills). */
function names(list: unknown): string[] {
  return Array.isArray(list)
    ? list.flatMap((e) =>
        e && typeof e === "object" && typeof (e as { name?: unknown }).name === "string"
          ? [(e as { name: string }).name]
          : [],
      )
    : [];
}

/** One plugin's detail + its last-24h AI spend against its cap. */
export const getPluginTool: ToolDefinitionWithHandler<GetPluginInput> = {
  name: "get_plugin",
  description:
    "Read one plugin in detail: version, tier, status, signature, the validator's findings, the tools / skills / capabilities its manifest declares, and its AI spend over the last 24h against its AI cost cap. " +
    "Use when list_plugins' one-line summary is not enough — e.g. why a submission was rejected, what an inactive plugin would add before proposing activate_plugin, or whether a plugin is near its AI cap. " +
    "Never returns the plugin's source.",
  schema: getPluginInput,
  inputSchema: z.toJSONSchema(getPluginInput) as Record<string, unknown>,
  handler: async (ctx, input, toolCtx) => {
    const r = await execute(toolCtx.registry, toolCtx.adapter, ctx, "plugins.get", input);
    if (!r.ok) return { ok: false, content: `plugins.get failed: ${describeError(r.error)}` };
    const plugin = (r.value as OpValue<typeof getPluginOp>).plugin;
    if (!plugin) {
      return {
        ok: false,
        content: `No plugin "${input.slug}" — list_plugins shows the installed plugins and their slugs.`,
      };
    }
    const m = (plugin.manifestJson ?? {}) as Record<string, unknown>;
    const lines = [
      `${plugin.slug} v${plugin.version} — tier ${plugin.tier}, status ${plugin.status}, ${plugin.manifestSignature ? "release-signed" : "unsigned"}`,
      `tools: ${names(m.tools).join(", ") || "(none)"}`,
      `skills: ${names(m.skills).join(", ") || "(none)"}`,
      `requested capabilities: ${Array.isArray(m.requestedCapabilities) ? m.requestedCapabilities.join(", ") || "(none)" : "(none)"}`,
    ];
    if (plugin.rejectionReason) lines.push(`rejected: ${plugin.rejectionReason}`);
    for (const f of plugin.validationErrors) lines.push(`validator: ${JSON.stringify(f)}`);
    const spend = await execute(
      toolCtx.registry,
      toolCtx.adapter,
      ctx,
      "ai_calls.aggregate_per_plugin",
      { pluginId: plugin.id },
    );
    if (spend.ok) {
      const s = spend.value as OpValue<typeof aggregatePluginAiSpendOp>;
      lines.push(
        `AI spend last 24h: ${usdFromMicrocents(s.last24hMicrocents)} over ${s.last24hCalls} calls; cap ${usdFromMicrocents(s.capMicrocents)}` +
          (s.capExceeded ? " — CAP REACHED (the plugin's AI calls are refused)" : ""),
      );
    } else {
      lines.push(`AI spend unavailable: ${describeError(spend.error)}`);
    }
    // No `value`: the op row carries the plugin's full source code.
    return { ok: true, content: lines.join("\n") };
  },
};

// ─── gateway ─────────────────────────────────────────────────────────

export const getGatewayAnalyticsTool = makeReadTool({
  name: "get_gateway_analytics",
  description:
    "Traffic on the public API gateway (visitor writes to plugin endpoints: forms, comments, signups) over a rolling window: requests, p95 latency, errors, throttled and honeypot-caught counts overall and for the busiest (plugin, operation) pairs. " +
    "Use when the operator asks whether a form is being spammed or a public endpoint is slow, and before proposing a rate limit with tune_rate_limit. For individual requests use list_gateway_requests.",
  opName: "gateway.list_analytics",
  input: z
    .object({
      windowSec: z
        .number()
        .int()
        .min(60)
        .max(86_400)
        .optional()
        .describe("Window in seconds (default 3600)."),
      topN: z.number().int().min(1).max(50).optional(),
    })
    .strict(),
  format: (value) => {
    const v = value as OpValue<typeof listGatewayAnalyticsOp>;
    const o = v.overall;
    return [
      `last ${v.windowSec}s: ${o.requests} requests, p95 ${o.p95Ms}ms, ${o.errorCount} errors, ${o.throttledCount} throttled, ${o.honeypotCount} honeypot`,
      ...v.perOp.map(
        (p) =>
          `${p.pluginSlug}.${p.operation}: ${p.requests} req, p95 ${p.p95Ms}ms, ${p.errorCount} errors, ${p.throttledCount} throttled`,
      ),
    ].join("\n");
  },
});

export const listGatewayRequestsTool = makeListReadTool<
  { pluginSlug?: string; onlyErrors?: boolean },
  OpValue<typeof listGatewayRequestsOp>["rows"][number]
>({
  name: "list_gateway_requests",
  description:
    "List the most recent requests to the public API gateway (newest first): plugin, operation, status, duration, body size, and whether it was rate-limited, honeypot-caught or passed the captcha. " +
    "Narrow with pluginSlug / onlyErrors. Use to diagnose a failing or abused public endpoint; for totals use get_gateway_analytics.",
  opName: "gateway.list_recent_requests",
  input: z
    .object({
      pluginSlug: z.string().min(1).max(120).optional(),
      onlyErrors: z.boolean().optional().describe("Only status >= 400."),
    })
    .strict(),
  buildOpInput: (input) => ({
    ...(input.pluginSlug ? { pluginSlug: input.pluginSlug } : {}),
    ...(input.onlyErrors !== undefined ? { onlyErrors: input.onlyErrors } : {}),
    // The op caps at 500; the list params page within what it returns.
    limit: Math.min(500, (input.offset ?? 0) + (input.limit ?? 50)),
  }),
  rows: (value) => (value as OpValue<typeof listGatewayRequestsOp>).rows,
  label: "requests",
  columns: [
    { key: "at", value: (r) => r.createdAt },
    { key: "op", value: (r) => `${r.pluginSlug}.${r.operation}` },
    { key: "status", value: (r) => r.statusCode },
    { key: "ms", value: (r) => r.durationMs },
    { key: "bytes", value: (r) => r.bodyBytes },
    {
      key: "flags",
      value: (r) =>
        [
          r.wasRateLimited ? "throttled" : "",
          r.wasHoneypotCaught ? "honeypot" : "",
          r.captchaPassed ? "captcha" : "",
        ]
          .filter(Boolean)
          .join("|"),
    },
    { key: "error", value: (r) => r.errorKind ?? "" },
  ],
  emptyMessage: "No gateway requests recorded (for that filter).",
});

export const listRateLimitProfilesTool = makeListReadTool<
  Record<string, never>,
  OpValue<typeof listRateLimitProfilesOp>["profiles"][number]
>({
  name: "list_rate_limit_profiles",
  description:
    "List the named rate-limit profiles (per-visitor max per window) and how many plugin endpoints use each. " +
    "Read before proposing a per-endpoint limit with tune_rate_limit, so the proposal fits the limits already in use.",
  opName: "gateway.list_rate_limit_profiles",
  input: noInput,
  rows: (value) => (value as OpValue<typeof listRateLimitProfilesOp>).profiles,
  label: "profiles",
  columns: [
    { key: "name", value: (p) => p.name },
    { key: "limit", value: (p) => `${p.perVisitorMax}/${p.windowSeconds}s` },
    { key: "usedBy", value: (p) => p.usedBy },
    { key: "description", value: (p) => p.description },
  ],
  emptyMessage:
    "No rate-limit profiles defined — every endpoint uses its own override or the default.",
});

// ─── email, bug reports, media settings ─────────────────────────────

export const getEmailConfigTool = makeReadTool({
  name: "get_email_config",
  description:
    'Read how the site sends email: transport (none / smtp / resend / ses), from-address and transport settings. Credentials read as "[redacted]" when set — you see THAT a key is configured, never the key. ' +
    "Use before propose_set_email_config, or when a form or newsletter mail did not arrive (then send_test_email checks delivery).",
  opName: "email_config.get",
  input: noInput,
  // The op redacts secrets for the AI actor (#588); keeping the raw value
  // out of the transcript is a second fence, not the only one.
  includeValue: false,
  format: (value) => {
    const c = (value as OpValue<typeof getEmailConfigOp>).config;
    if (c.transport === "none") return "Email is not set up (transport: none).";
    return `transport: ${c.transport}\nfrom: ${c.fromAddress || "(not set)"}\nsettings: ${JSON.stringify(c.config)}\nupdated: ${c.updatedAt}`;
  },
});

export const listBugReportsTool = makeListReadTool<
  { status?: "new" | "triaged" | "fixed" | "invalid" },
  OpValue<typeof listBugReportsOp>["reports"][number]
>({
  name: "list_bug_reports",
  description:
    "List the defect reports already filed against Caelo (by you via bug_report, or auto-captured by the chat), newest first. " +
    "Call BEFORE bug_report to see whether the problem is already reported; filter by status (new / triaged / fixed / invalid).",
  opName: "ai_bug_reports.list",
  input: z.object({ status: z.enum(["new", "triaged", "fixed", "invalid"]).optional() }).strict(),
  buildOpInput: (input) => ({
    ...(input.status ? { status: input.status } : {}),
    limit: Math.min(200, (input.offset ?? 0) + (input.limit ?? 50)),
  }),
  rows: (value) => (value as OpValue<typeof listBugReportsOp>).reports,
  label: "bug_reports",
  columns: [
    { key: "createdAt", value: (r) => r.createdAt },
    { key: "status", value: (r) => r.status },
    { key: "severity", value: (r) => r.severity },
    { key: "tool", value: (r) => r.suspectedTool ?? "" },
    { key: "title", value: (r) => r.title },
  ],
  emptyMessage: "No bug reports filed (for that status).",
});

export const getMediaSettingsTool = makeReadTool({
  name: "get_media_settings",
  description:
    "Read the media CDN settings: whether heavily used images are copied to the CDN and the usage count at which they are. " +
    "Changing them is an Owner decision (billing/infrastructure) at /security/media.",
  opName: "media.get_settings",
  input: noInput,
  format: (value) => {
    const v = value as OpValue<typeof mediaGetSettingsOp>;
    return `CDN copy ${v.cdnCopyEnabled ? "enabled" : "disabled"}; threshold ${v.cdnUsageThreshold} uses`;
  },
});
