// SPDX-License-Identifier: MPL-2.0

/**
 * Shared types for the v0.2.46 chat debug panel. Lives in a .ts file
 * (not the .svelte) so callers can import the types without pulling in
 * the component's compiled module. Mirrors the SSE event payload shape
 * from chat-runner.ts.
 */

export interface DebugToolCall {
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  result?: { ok: boolean; content: string };
  startedAt: number;
  endedAt?: number;
}

export interface DebugUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** USD (the SSE event reports `cost` as a USD float). */
  cost: number;
}
