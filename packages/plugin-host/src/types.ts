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
  /**
   * Single-shot completion. The host wraps this for `ctx.ai.complete(...)`.
   * `purpose` is the plugin's declared use; the implementation picks the
   * model for it (the Owner's per-purpose choice, else the chat model) and
   * reports the provider + model it actually ran on, which the host records
   * in `ai_calls` against the plugin.
   */
  complete(opts: {
    system: string;
    messages: ReadonlyArray<AIMessage>;
    maxTokens?: number;
    temperature?: number;
    purpose?: string;
  }): Promise<AICompletion>;
  /**
   * Structured output for `ctx.ai.generateObject(...)`: one object
   * constrained to `jsonSchema` (the AI SDK's `generateObject`). `object`
   * is `undefined` when the model's answer did not parse to the schema;
   * provider/API errors throw. Same `purpose` → model mapping and the
   * same provider/model/usage report as {@link complete}.
   */
  generateObject(opts: {
    system: string;
    messages: ReadonlyArray<AIMessage>;
    jsonSchema: Record<string, unknown>;
    maxTokens?: number;
    temperature?: number;
    purpose?: string;
  }): Promise<AIObjectCompletion>;
}

/** What one structured-output call produced, and on which provider/model. */
export interface AIObjectCompletion extends Omit<AICompletion, "text"> {
  /** The schema-valid object, or `undefined` when none parsed. */
  readonly object: unknown | undefined;
}

/** What one completion produced, and on which provider/model. */
export interface AICompletion {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Prompt-cache read tokens (billed at the reduced rate). */
  readonly cachedTokens: number;
  /** Prompt-cache write tokens (billed at the premium rate). */
  readonly cacheCreationTokens: number;
  /** Provider name as stored in `ai_providers.name`. */
  readonly provider: string;
  /** Model id the call actually ran on. */
  readonly model: string;
}
