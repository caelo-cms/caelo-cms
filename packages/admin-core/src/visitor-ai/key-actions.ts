// SPDX-License-Identifier: MPL-2.0

/**
 * The Owner's key actions for the visitor AI (#1654): store a key (on the
 * approval card of `propose_set_visitor_ai` or under Settings → Visitor AI),
 * rotate it (store another) and remove it.
 *
 * The key passes through this process once, on its way from the Owner's
 * browser to the secret store, and is never written anywhere else: not to
 * cms_admin, not to cms_public, not to a log, not into the chat. Only
 * `visitor_ai.record_key` reaches the database, with the provider and the
 * time. These actions are human-only: the caller (an admin endpoint)
 * checks that the person holds `settings.write`, the permission the
 * proposal's approver needs.
 *
 * Before storing, the key is shown to its provider (a models list, which
 * costs nothing): a key the provider refuses is not stored, so the widget
 * never says "unavailable" because of a typo.
 */

import { type DatabaseAdapter, execute, type OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { z } from "zod";
import {
  VISITOR_AI_PROVIDERS,
  type VisitorAiEnvironment,
  type VisitorAiProvider,
} from "../ops/visitor_ai.js";
import {
  type VisitorAiKeyStore,
  VisitorAiKeyStoreUnavailable,
  visitorAiKeyStore,
} from "./key-store.js";

/** What the Owner sends to store a key. */
export const storeVisitorAiKeyInput = z
  .object({
    provider: z.enum(VISITOR_AI_PROVIDERS),
    apiKey: z.string().min(20).max(500).regex(/^\S+$/, "a key has no spaces or line breaks"),
    /** `same`: staging uses this key too; `none`: staging has none (its chats say unavailable). */
    staging: z.enum(["same", "none"]),
  })
  .strict();

/** The outcome as the page or the card shows it. */
export type VisitorAiKeyResult =
  | { readonly ok: true; readonly stored: readonly VisitorAiEnvironment[] }
  | { readonly ok: false; readonly error: string; readonly nextStep: string };

/** Injectable for tests: the stores and the provider check. */
export interface VisitorAiKeyDeps {
  readonly store?: (environment: VisitorAiEnvironment) => VisitorAiKeyStore;
  readonly fetch?: typeof fetch;
}

const CHECK: Readonly<
  Record<VisitorAiProvider, (key: string) => { url: string; headers: Record<string, string> }>
> = {
  anthropic: (key) => ({
    url: "https://api.anthropic.com/v1/models?limit=1",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  }),
  openai: (key) => ({
    url: "https://api.openai.com/v1/models",
    headers: { authorization: `Bearer ${key}` },
  }),
  google: (key) => ({
    url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
    headers: { "x-goog-api-key": key },
  }),
};

/** Whether the provider accepts the key; never throws, never logs the key. */
async function providerAccepts(
  provider: VisitorAiProvider,
  key: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  const { url, headers } = CHECK[provider](key);
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return null;
    if (res.status === 401 || res.status === 403)
      return `${provider} refused the key (HTTP ${res.status})`;
    return `${provider} answered HTTP ${res.status} when the key was checked`;
  } catch (e) {
    return `${provider} could not be reached to check the key (${e instanceof Error ? e.name : "error"})`;
  }
}

async function record(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  environment: VisitorAiEnvironment,
  provider: VisitorAiProvider | null,
): Promise<string | null> {
  const r = await execute(registry, adapter, ctx, "visitor_ai.record_key", {
    environment,
    provider,
  });
  return r.ok ? null : JSON.stringify(r.error);
}

function storesOf(deps: VisitorAiKeyDeps) {
  return deps.store ?? ((environment: VisitorAiEnvironment) => visitorAiKeyStore(environment));
}

/** Store (or rotate) the key for the live site and, as chosen, staging. */
export async function storeVisitorAiKey(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  raw: unknown,
  deps: VisitorAiKeyDeps = {},
): Promise<VisitorAiKeyResult> {
  const parsed = storeVisitorAiKeyInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "invalid key",
      nextStep: "Paste the key exactly as the provider shows it.",
    };
  }
  const input = parsed.data;
  const refused = await providerAccepts(input.provider, input.apiKey, deps.fetch ?? fetch);
  if (refused) {
    return {
      ok: false,
      error: refused,
      nextStep: `Nothing was stored. Check the key in your ${input.provider} account (and that it may list models), then paste it again.`,
    };
  }
  const stores = storesOf(deps);
  const stored: VisitorAiEnvironment[] = [];
  try {
    await stores("live").write({ provider: input.provider, apiKey: input.apiKey });
    stored.push("live");
    await stores("staging").write(
      input.staging === "same" ? { provider: input.provider, apiKey: input.apiKey } : null,
    );
    stored.push("staging");
  } catch (e) {
    return {
      ok: false,
      error:
        e instanceof VisitorAiKeyStoreUnavailable
          ? e.message
          : `the secret store refused the key: ${e instanceof Error ? e.message : String(e)}`,
      nextStep:
        stored.length > 0
          ? "The live key is stored; store it again to set staging too."
          : "Nothing was stored. Run `cms-provision upgrade` if the store is missing, then try again.",
    };
  }
  for (const [environment, provider] of [
    ["live", input.provider],
    ["staging", input.staging === "same" ? input.provider : null],
  ] as const) {
    const failed = await record(registry, adapter, ctx, environment, provider);
    if (failed) {
      return {
        ok: false,
        error: `the key is stored, but not recorded: ${failed}`,
        nextStep: "Store it again (storing the same key twice is harmless).",
      };
    }
  }
  return { ok: true, stored };
}

/** Remove the key of `environment` (or both): the store keeps `{}`, the gateway answers unavailable. */
export async function removeVisitorAiKey(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  ctx: ExecutionContext,
  which: VisitorAiEnvironment | "both",
  deps: VisitorAiKeyDeps = {},
): Promise<VisitorAiKeyResult> {
  const environments: VisitorAiEnvironment[] = which === "both" ? ["live", "staging"] : [which];
  const stores = storesOf(deps);
  for (const environment of environments) {
    try {
      await stores(environment).write(null);
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        nextStep: "The key is still stored. Try again; revoke it at the provider meanwhile.",
      };
    }
    const failed = await record(registry, adapter, ctx, environment, null);
    if (failed) {
      return {
        ok: false,
        error: `the key is removed, but not recorded: ${failed}`,
        nextStep: "Remove it again.",
      };
    }
  }
  return { ok: true, stored: environments };
}
