// SPDX-License-Identifier: MPL-2.0

import type { ProviderName } from "./provider.js";

/** Shared by key resolution and the credential UI; never return the key to clients. */
export function providerEnvKey(
  name: ProviderName,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  switch (name) {
    case "google":
      return env.GOOGLE_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "openai":
      return env.OPENAI_API_KEY;
    case "anthropic":
      return env.ANTHROPIC_API_KEY;
    case "local-openai-compat":
      return env.LOCAL_OPENAI_API_KEY;
  }
}
