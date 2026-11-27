// SPDX-License-Identifier: MPL-2.0

/**
 * #1763 — which files for agents a build writes (`/llms.txt`), as the
 * active plugins that declare an `agentFilesOperation` answer it. Core
 * writes the file from the build's indexing state (static-generator
 * llms-txt.ts); a plugin only switches it, so no plugin text reaches the
 * file and the plugin owns no route (#1729).
 *
 * The same path for every plugin (CLAUDE.md §2 one plugin model): a render
 * (read-only) invocation on the main line, the state a build renders, and
 * an answer validated here. Loud: a failing call or a malformed answer
 * throws and stops the build, rather than leaving a file out or in by
 * accident.
 */

import { pluginAgentFiles } from "@caelo-cms/plugin-sdk";
import {
  isPluginDisabled,
  loadedPlugins,
  MAIN_RENDER,
  renderInvocation,
  runPluginOperation,
} from "./dispatch.js";

/** The files for agents a build writes, and which plugins asked for each. */
export interface SiteAgentFiles {
  /** Write `/llms.txt`. */
  readonly llmsTxt: boolean;
  /** The plugins that switched `/llms.txt` on, sorted (for the build log). */
  readonly llmsTxtBy: readonly string[];
}

/**
 * Ask every active plugin with an `agentFilesOperation` which files it wants.
 *
 * @throws when a plugin's call fails or answers outside the SDK's shape.
 */
export async function resolveAgentFiles(): Promise<SiteAgentFiles> {
  const asking = loadedPlugins
    .all()
    .filter((lp) => !isPluginDisabled(lp.slug))
    .filter((lp) => typeof lp.definition.agentFilesOperation === "string")
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const llmsTxtBy: string[] = [];
  for (const lp of asking) {
    const operationName = lp.definition.agentFilesOperation as string;
    const r = await runPluginOperation({
      invocation: renderInvocation(MAIN_RENDER),
      pluginSlug: lp.slug,
      operationName,
      args: {},
    });
    if (!r.ok) {
      throw new Error(
        `agent files: ${lp.slug}.${operationName} failed: ${r.error.kind}: ${r.error.message}`,
      );
    }
    const parsed = pluginAgentFiles.safeParse(r.value);
    if (!parsed.success) {
      throw new Error(
        `agent files: plugin "${lp.slug}" returned an invalid answer: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    if (parsed.data.llmsTxt) llmsTxtBy.push(lp.slug);
  }
  return { llmsTxt: llmsTxtBy.length > 0, llmsTxtBy };
}
