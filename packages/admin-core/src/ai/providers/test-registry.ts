// SPDX-License-Identifier: MPL-2.0

/**
 * In-memory registry of named test providers. Replaces the P5.1
 * `/tmp/caelo-ai-fixture.json` channel: a Playwright spec POSTs its
 * fixture to `/__test/providers` (dev only), gets back a name, then
 * sends `x-caelo-test-provider: <name>` on the chat SSE request. The
 * SSE handler resolves the name to an in-memory FixtureProvider /
 * MultiFixtureProvider instance.
 *
 * Why per-name in-memory rather than the old shared file:
 *   - No filesystem race when Playwright runs specs in parallel.
 *   - No leakage across runs (process restart wipes the registry).
 *   - The registry refuses to expose itself when NODE_ENV='production'
 *     so a deployed instance can never be coerced into using a fake AI.
 *
 * The `request` paramter on `register` is the Bun fetch Request — used
 * to derive a stable per-spec key so afterEach can clear just its own
 * fixtures without nuking sibling specs running in parallel.
 */

import type { AIProvider, ProviderEvent } from "../provider.js";
import { FixtureProvider, MultiFixtureProvider } from "./anthropic.js";

const registry = new Map<string, AIProvider>();

export function isTestRegistryEnabled(): boolean {
  return process.env["NODE_ENV"] !== "production";
}

export function registerTestProvider(
  name: string,
  events: ProviderEvent[][] | ProviderEvent[],
): void {
  if (!isTestRegistryEnabled()) {
    throw new Error("test provider registry is disabled in production");
  }
  const isMulti = Array.isArray(events) && events.length > 0 && Array.isArray(events[0]);
  const provider = isMulti
    ? new MultiFixtureProvider(events as ProviderEvent[][])
    : new FixtureProvider(events as ProviderEvent[]);
  registry.set(name, provider);
}

export function resolveTestProvider(name: string | null | undefined): AIProvider | null {
  if (!isTestRegistryEnabled() || !name) return null;
  return registry.get(name) ?? null;
}

export function clearTestProvider(name: string): void {
  registry.delete(name);
}

export function clearAllTestProviders(): void {
  registry.clear();
}
