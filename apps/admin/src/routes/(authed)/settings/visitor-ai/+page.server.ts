// SPDX-License-Identifier: MPL-2.0

/**
 * #1654 — Settings → Visitor AI: the AI that answers visitors through a
 * plugin's conversation (a site assistant). The Owner's settings (provider,
 * model, budgets, limits), the key of each environment (stored, rotated,
 * removed; never shown) and what visitors spent, read from the gateway's
 * ledger as untrusted data.
 */

import {
  describeError,
  removeVisitorAiKey,
  storeVisitorAiKey,
  VISITOR_AI_PROVIDERS,
  type VisitorAiSettings,
  visitorAiSettingsShape,
} from "@caelo-cms/admin-core";
import { execute } from "@caelo-cms/query-api";
import { fail } from "@sveltejs/kit";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
import type { Actions, PageServerLoad } from "./$types";

interface KeyState {
  provider: string | null;
  setAt: string | null;
}

interface Spend {
  last24hUsd: number;
  last30dUsd: number;
  perOperation: {
    pluginId: string;
    operation: string;
    turns: number;
    running: number;
    last30dUsd: number;
  }[];
  dropped: number;
}

export const load: PageServerLoad = async ({ locals }) => {
  requirePermission(locals, "settings.write");
  const { adapter, registry } = getQueryContext();
  const got = await execute(registry, adapter, locals.ctx, "visitor_ai.get", {});
  if (!got.ok) throw new Error(`visitor_ai.get: ${describeError(got.error)}`);
  const spent = await execute(registry, adapter, locals.ctx, "visitor_ai.spend", {});
  const v = got.value as {
    settings: VisitorAiSettings;
    keys: { live: KeyState; staging: KeyState };
    blocked: string | null;
    providerLimitHint: string;
  };
  return {
    ...v,
    providers: [...VISITOR_AI_PROVIDERS],
    spend: spent.ok ? (spent.value as Spend) : null,
    spendError: spent.ok ? null : describeError(spent.error),
  };
};

const num = (form: FormData, name: string): number => Number(form.get(name));
const optional = (form: FormData, name: string): number | null => {
  const v = form.get(name);
  return typeof v === "string" && v.trim() !== "" ? Number(v) : null;
};

export const actions: Actions = {
  save: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const parsed = visitorAiSettingsShape.safeParse({
      enabled: form.get("enabled") === "on",
      provider: form.get("provider"),
      model: form.get("model"),
      dailyBudgetUsd: num(form, "dailyBudgetUsd"),
      monthlyBudgetUsd: num(form, "monthlyBudgetUsd"),
      conversationBudgetUsd: num(form, "conversationBudgetUsd"),
      stagingDailyBudgetUsd: num(form, "stagingDailyBudgetUsd"),
      maxConcurrent: num(form, "maxConcurrent"),
      maxTurns: optional(form, "maxTurns"),
      maxQuestionChars: optional(form, "maxQuestionChars"),
      maxAnswerTokens: optional(form, "maxAnswerTokens"),
    });
    if (!parsed.success) return fail(400, { error: parsed.error.issues[0]?.message ?? "invalid" });
    const { adapter, registry } = getQueryContext();
    const before = await execute(registry, adapter, locals.ctx, "visitor_ai.get", {});
    const live = before.ok
      ? (before.value as { keys: { live: KeyState } }).keys.live.provider
      : null;
    if (parsed.data.enabled && live !== parsed.data.provider) {
      return fail(400, {
        error: `Store a ${parsed.data.provider} key first: the visitor AI cannot be switched on without one.`,
      });
    }
    const r = await execute(registry, adapter, locals.ctx, "visitor_ai.set", parsed.data);
    if (!r.ok) return fail(400, { error: describeError(r.error) });
    return {
      ok: true,
      message: "Saved. Both gateways use the new settings with the next question.",
    };
  },
  storeKey: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const { adapter, registry } = getQueryContext();
    const r = await storeVisitorAiKey(registry, adapter, locals.ctx, {
      provider: form.get("provider"),
      apiKey: form.get("apiKey"),
      staging: form.get("staging") === "same" ? "same" : "none",
    });
    if (!r.ok) return fail(422, { error: `${r.error}. ${r.nextStep}` });
    return {
      ok: true,
      message: `Key stored for ${r.stored.join(" and ")}. It is never shown again, not even to you.`,
    };
  },
  removeKey: async ({ request, locals }) => {
    requirePermission(locals, "settings.write");
    const form = await request.formData();
    const which = form.get("environment");
    if (which !== "live" && which !== "staging" && which !== "both")
      return fail(400, { error: "Choose which key to remove." });
    const { adapter, registry } = getQueryContext();
    const r = await removeVisitorAiKey(registry, adapter, locals.ctx, which);
    if (!r.ok) return fail(422, { error: `${r.error}. ${r.nextStep}` });
    return {
      ok: true,
      message:
        "Key removed: visitors' conversations now say the assistant is unavailable. Revoke it at the provider too.",
    };
  },
};
