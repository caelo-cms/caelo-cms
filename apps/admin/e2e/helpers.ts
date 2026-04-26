// SPDX-License-Identifier: MPL-2.0

import { spawnSync } from "node:child_process";

/**
 * Playwright runs under Node — we cannot import `bun` here directly. This
 * helper spawns a small Bun subprocess so test fixtures can use Bun's native
 * SQL driver (and any `@caelo/admin-core` helpers it pulls in).
 */
/**
 * Runs a Bun-runtime script with optional extra env vars. Pass user-supplied
 * values through `extraEnv` and read them via `process.env.X` inside the
 * script — splicing them directly into the script string is unsafe and
 * confuses Bun's SQL tagged-template parser.
 *
 * `bun -e <script>` (not `bun run -e`) is the correct invocation; `bun run`
 * expects a file or package.json script name.
 */
export function runBunInline(script: string, extraEnv: Record<string, string> = {}): void {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  const result = spawnSync("bun", ["-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`bun -e failed (status ${result.status}): ${result.stderr || result.stdout}`);
  }
}
