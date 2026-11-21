// SPDX-License-Identifier: MPL-2.0

/**
 * Declarative visitor conversations (epic #1644, R4, issue #1654): the
 * operation kind `ai-chat`.
 *
 * A plugin declares the conversation; the public gateway runs it with core
 * code. No plugin code runs on the public side (#1340): the gateway takes
 * the declaration from the plugin's signed manifest, the prompt from the
 * plugin's released configuration, and answers with the AI SDK's
 * `streamText`, at most `maxSteps` steps, whose only tools are the declared
 * search and read operations of active plugins. There is no write tool to
 * reach, whatever a page or a visitor writes into the conversation.
 *
 * The prompt is the plugin's configuration, never code: `prompt.fields`
 * names leaves of the plugin's `config` marked `visitorVisible`, which are
 * published with the release (a Stage freezes them, Publish live ships
 * them). The gateway puts them after the core's own rules, which it never
 * takes from a plugin: answer from the tool results only, cite them, treat
 * their text as data.
 *
 * What a conversation may cost is not in the manifest: the Owner sets the
 * provider, the model and the budgets (§11.A), and the gateway reserves each
 * turn's worst case in its own ledger before any token flows. `limits` are
 * the plugin's ceilings; the Owner's settings may lower them, never raise
 * them. Needs the `visitor_ai` capability and `requires: ["visitor-ai"]`.
 */

import { z } from "zod";
import type { PluginConfigSchema } from "./config.js";
import { configLeaves } from "./config.js";

const opName = z.string().regex(/^[a-z_][a-z0-9_]{0,119}$/);
const pluginSlug = z
  .string()
  .min(1)
  .max(55)
  .regex(/^[a-z][a-z0-9-]*$/, "must be a plugin slug (lowercase, dash-separated)");
const configPath = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,47}(\.[a-z][a-z0-9_]{0,47}){0,2}$/, "must be a config leaf path");

/** A conversation's ceilings, per conversation and per turn. */
export const aiChatLimits = z
  .object({
    /** Questions one conversation may ask. */
    maxTurns: z.number().int().min(1).max(20),
    /** Characters of one question. */
    maxQuestionChars: z.number().int().min(20).max(2000),
    /** Output tokens of each model step (the answer's ceiling). */
    maxAnswerTokens: z.number().int().min(64).max(2000),
  })
  .strict();
export type AiChatLimits = z.infer<typeof aiChatLimits>;

/** The ceilings a declaration that names none gets. */
export const DEFAULT_AI_CHAT_LIMITS: AiChatLimits = {
  maxTurns: 8,
  maxQuestionChars: 500,
  maxAnswerTokens: 600,
};

/** One tool of a conversation: a declared search or read operation of an active plugin. */
export const aiChatTool = z
  .object({
    plugin: pluginSlug,
    operation: opName,
  })
  .strict();
export type AiChatTool = z.infer<typeof aiChatTool>;

/** One declared visitor conversation. */
export const aiChatOperationManifest = z
  .object({
    name: opName,
    kind: z.literal("ai-chat"),
    /** What the conversation is for (the Owner reads it at approval). */
    description: z.string().min(1).max(600),
    /** The plugin's visitor-visible config leaves that make up the prompt, in order. */
    prompt: z
      .object({
        fields: z.array(configPath).min(1).max(8),
      })
      .strict(),
    /** The search and read operations the model may call; nothing else is a tool. */
    tools: z.array(aiChatTool).min(1).max(6),
    /** Model steps per turn: each tool round is one. */
    maxSteps: z.number().int().min(1).max(4).default(3),
    limits: aiChatLimits.default(DEFAULT_AI_CHAT_LIMITS),
    /**
     * How a conversation proves it is not a script: a proof of work when it
     * starts, whatever the site's captcha setting (visitor AI spends money).
     */
    captcha: z.enum(["pow"]).default("pow"),
  })
  .strict();
export type AiChatOperationManifest = z.infer<typeof aiChatOperationManifest>;
export type AiChatOperationInput = z.input<typeof aiChatOperationManifest>;

/** Most `ai-chat` operations per plugin. */
export const MAX_AI_CHAT_OPERATIONS = 2;

type Issue = (path: readonly (string | number)[], message: string) => void;

/** What {@link checkAiChatOperations} reads of the manifest. */
export interface AiChatManifestView {
  readonly slug: string;
  readonly aiChatOperations?: readonly AiChatOperationManifest[];
  readonly config?: PluginConfigSchema;
  readonly requestedCapabilities?: readonly string[];
  readonly requires?: readonly string[];
  readonly requiresPlugins?: readonly string[];
  readonly collectionOperations?: readonly { readonly name: string; readonly kind: string }[];
}

/**
 * Lints the `ai-chat` operations: names of their own, prompt fields that are
 * visitor-visible config leaves, tools that are this plugin's search or read
 * operations or another plugin's (which must be in `requiresPlugins`, so
 * activation checks it is active), the capability and the requirement.
 */
export function checkAiChatOperations(
  m: AiChatManifestView,
  otherNames: readonly string[],
  issue: Issue,
): void {
  const ops = m.aiChatOperations ?? [];
  if (ops.length === 0) return;
  if (!(m.requestedCapabilities ?? []).includes("visitor_ai"))
    issue(["requestedCapabilities"], 'ai-chat operations need the "visitor_ai" capability');
  if (!(m.requires ?? []).includes("visitor-ai"))
    issue(
      ["requires"],
      'ai-chat operations need `requires: ["visitor-ai"]`, so activation waits for the Owner\'s key and budget',
    );
  const leaves = new Map(configLeaves(m.config ?? {}).map((l) => [l.path, l.field]));
  const seen = new Set(otherNames);
  for (const [i, op] of ops.entries()) {
    const path = ["aiChatOperations", i];
    if (seen.has(op.name))
      issue(
        [...path, "name"],
        `"${op.name}" is already an operation name: an ai-chat operation has no handler and needs a name of its own`,
      );
    seen.add(op.name);
    for (const [j, field] of op.prompt.fields.entries()) {
      const leaf = leaves.get(field);
      if (!leaf) issue([...path, "prompt", "fields", j], `"${field}" is not a leaf of \`config\``);
      else if (leaf.visitorVisible !== true)
        issue(
          [...path, "prompt", "fields", j],
          `"${field}" is not visitor-visible: mark it \`visitorVisible: true\` so it is published to the gateway`,
        );
    }
    const tools = new Set<string>();
    for (const [j, t] of op.tools.entries()) {
      const key = `${t.plugin}/${t.operation}`;
      if (tools.has(key)) issue([...path, "tools", j], `${key} is listed twice`);
      tools.add(key);
      if (t.plugin === m.slug) {
        const own = (m.collectionOperations ?? []).find((c) => c.name === t.operation);
        if (!own)
          issue(
            [...path, "tools", j, "operation"],
            `"${t.operation}" is not one of this plugin's collection operations`,
          );
        else if (own.kind !== "search" && own.kind !== "read")
          issue(
            [...path, "tools", j, "operation"],
            `"${t.operation}" is a ${own.kind} operation: a tool must be a search or read operation`,
          );
      } else if (!(m.requiresPlugins ?? []).includes(t.plugin)) {
        issue(
          [...path, "tools", j, "plugin"],
          `"${t.plugin}" must be in requiresPlugins, so the conversation cannot be activated without it`,
        );
      }
    }
  }
}

/**
 * #1655 — `ctx.chatTools`: the declared tools of the plugin's own `ai-chat`
 * operations, run on the admin side exactly as the gateway runs them for a
 * visitor (the same parameters, the same executor): on a Stage's release
 * for the Stage audit, on the newest staged or the live release for a
 * preview. Only a tool a conversation declares runs, and only while its
 * plugin is active; nothing else of another plugin is reachable.
 */
export interface PluginChatTools {
  /**
   * Runs one declared tool of `conversation` with the model's input:
   * `{ query }` for a search tool, `{ url }` (or `{ id }`) for a read tool.
   * `lang` is the visitor's language, which a search filters by.
   */
  run(
    conversation: string,
    tool: AiChatTool,
    input: Readonly<Record<string, string>>,
    opts: ChatToolRunOptions,
  ): Promise<ChatToolResult>;
}

/** Which release a {@link PluginChatTools.run} reads. */
export interface ChatToolRunOptions {
  readonly lang: string;
  /** A Stage's release (its run id); otherwise `at`. */
  readonly runId?: string;
  /** `staged` (default): the newest Stage with a ready index; `live`: what visitors get. */
  readonly at?: "staged" | "live";
}

/** One page a tool returned: what the gateway would number as a source. */
export interface ChatToolHit {
  /** The collection document's id (the page id for site-search). */
  readonly id: string;
  readonly url: string;
  readonly title: string;
  /** The section the hit points at, when the tool names one. */
  readonly anchor: string | null;
}

/** What a {@link PluginChatTools.run} answers. */
export interface ChatToolResult {
  readonly state: "pending" | "ready" | "failed" | "none";
  readonly error: string | null;
  readonly hits: readonly ChatToolHit[];
}
