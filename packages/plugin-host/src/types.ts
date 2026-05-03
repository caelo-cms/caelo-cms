// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/types — minimal shape we accept for the AI provider so
 * we don't have to circularly import @caelo-cms/admin-core. The host is a leaf
 * dependency of admin-core; admin-core exposes its provider implementation,
 * the host just calls it through this structural type.
 */

export interface AIMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AIProvider {
  /** Single-shot completion. The host wraps this for `ctx.ai.complete(...)`. */
  complete(opts: {
    system: string;
    messages: ReadonlyArray<AIMessage>;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}
