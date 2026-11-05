// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1460 — every caller of the install's own AI has a defined result on
 * an install the Owner runs without a key, and no background worker is one
 * of them (a worker would log an error every tick for a state the Owner
 * chose). This pins the inventory: a new importer of the provider resolver
 * fails here until it is added with what it does in that mode, and a test
 * in `no-ai-key-mode.integration.test.ts`.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const RESOLVER_CALL =
  /\b(getActiveProvider|getActiveProviderForModel|getActiveProviderForPurpose|getProviderByName|getImageProviderApiKey)\(/;

/** Each caller, and its result in Power-MCP-only mode. */
const INVENTORY: Record<string, string> = {
  "apps/admin/src/hooks.server.ts":
    "the MCP bridge's provider: Power-MCP calls run AI-delegated, caelo_chat refuses first",
  "apps/admin/src/routes/(authed)/content/chat/[sessionId]/stream/+server.ts":
    "refuses with code no_install_ai",
  "packages/admin-core/src/ai/chat-runner/turn-completeness-judge.ts":
    "declines (null); runs only inside a chat turn, which this mode does not start",
  "packages/admin-core/src/ai/image-service.ts":
    "AiDelegated: over MCP (the agent makes the image); no chat turn reaches it",
  "packages/admin-core/src/ai/plugin-image-provider.ts": "refuses with NoInstallAi:",
  "packages/admin-core/src/ai/plugin-text-provider.ts": "refuses with NoInstallAi:",
  "packages/admin-core/src/ai/tools/query-page-html.ts":
    "hands the HTML to the agent over MCP; otherwise refuses and names keyword mode",
  "packages/admin-core/src/ai/tools/spawn-subagent.ts":
    "not on the Power-MCP catalogue; no chat turn reaches it",
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === "dist" || name === "__tests__") return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.(test|bench)\.ts$/.test(name) ? [path] : [];
  });
}

/** The file without its comment lines: a doc comment naming a call is no call. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join("\n");
}

describe("install AI callers (#1460)", () => {
  it("names every caller of the provider resolver", () => {
    const found = ["packages", "apps/admin/src"]
      .flatMap((d) => sources(resolve(REPO_ROOT, d)))
      .filter((path) => !path.endsWith("provider-resolver.ts"))
      .filter((path) => RESOLVER_CALL.test(code(path)))
      .map((path) => relative(REPO_ROOT, path))
      .sort();
    expect(found).toEqual(Object.keys(INVENTORY).sort());
  });

  it("has no background worker among them", () => {
    for (const path of Object.keys(INVENTORY)) expect(path).not.toMatch(/worker/i);
  });
});
