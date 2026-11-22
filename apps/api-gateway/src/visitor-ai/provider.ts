// SPDX-License-Identifier: MPL-2.0

/**
 * The visitor AI's key and model (#1654).
 *
 * The key is this environment's own secret, mounted into this gateway only
 * as a file (`CAELO_VISITOR_AI_KEY_FILE`; Secret Manager `visitor-ai-key`
 * on the live gateway, `visitor-ai-staging-key` on the staging gateway, a
 * Compose secret self-hosted). Cloud Run reads a secret volume from Secret
 * Manager on every read, so a key the Owner rotates or removes takes effect
 * on the next turn without a new revision. It is read per turn and kept
 * nowhere else; `{}` (the CLI's first version) means no key.
 *
 * The model comes from the AI SDK's own providers: the SDK is the boundary
 * (CLAUDE.md §12), no parallel client. {@link setVisitorAiModelFactoryForTests}
 * is the test seam: integration tests and the browser fixture of #1655
 * (`apps/api-gateway/e2e/visitor-ai-site.ts`) answer with the SDK's mock
 * model, never with a real key.
 */

import { readFile } from "node:fs/promises";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import type { VisitorAiProvider } from "./published.js";

/** The env var naming this gateway's key file. */
export const VISITOR_AI_KEY_FILE_ENV = "CAELO_VISITOR_AI_KEY_FILE";

const keyFile = z.union([
  z
    .object({
      provider: z.enum(["anthropic", "openai", "google"]),
      apiKey: z.string().min(20).max(500),
    })
    .strict(),
  z.object({}).strict(),
]);

/** This environment's key, or null with why there is none. */
export async function readVisitorAiKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<
  | { readonly ok: true; readonly provider: VisitorAiProvider; readonly apiKey: string }
  | { readonly ok: false; readonly problem: string }
> {
  const path = env[VISITOR_AI_KEY_FILE_ENV]?.trim();
  if (!path)
    return {
      ok: false,
      problem: `${VISITOR_AI_KEY_FILE_ENV} is not set: this gateway has no visitor-AI key`,
    };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    return {
      ok: false,
      problem: `the visitor-AI key file cannot be read (${(e as NodeJS.ErrnoException).code ?? "error"})`,
    };
  }
  let parsed: z.infer<typeof keyFile>;
  try {
    const p = keyFile.safeParse(JSON.parse(text));
    if (!p.success) return { ok: false, problem: "the visitor-AI key file has an unknown shape" };
    parsed = p.data;
  } catch {
    return { ok: false, problem: "the visitor-AI key file is not JSON" };
  }
  if (!("provider" in parsed)) return { ok: false, problem: "no visitor-AI key is stored" };
  return { ok: true, provider: parsed.provider, apiKey: parsed.apiKey };
}

/** Builds the language model a turn runs on. */
export type VisitorAiModelFactory = (
  provider: VisitorAiProvider,
  model: string,
  apiKey: string,
) => LanguageModel;

const realFactory: VisitorAiModelFactory = (provider, model, apiKey) => {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey })(model);
    case "openai":
      return createOpenAI({ apiKey })(model);
    case "google":
      return createGoogleGenerativeAI({ apiKey })(model);
  }
};

let factory: VisitorAiModelFactory = realFactory;

/** The factory in use. */
export function visitorAiModel(
  provider: VisitorAiProvider,
  model: string,
  apiKey: string,
): LanguageModel {
  return factory(provider, model, apiKey);
}

/**
 * Test seam: answer turns with `f` (the AI SDK's `MockLanguageModelV4`,
 * say) instead of the provider; null restores the real providers. The key
 * file is still read, so a test also proves "no key → unavailable".
 */
export function setVisitorAiModelFactoryForTests(f: VisitorAiModelFactory | null): void {
  factory = f ?? realFactory;
}
