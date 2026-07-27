// SPDX-License-Identifier: MPL-2.0

/**
 * issue #190 / #356 — provider-history assembly for images.
 *
 * Attachments persist on chat_messages rows (migration 0111), so a reloaded
 * transcript keeps its thumbnails and a replayed turn knows what rode each
 * message. EVERY attached image is inlined as an image part, on every call,
 * for as long as its message survives in history. Compaction is the only
 * thing that removes one — the same rule that governs every other message.
 *
 * This reverses #190's original asymmetry, which inlined only the most recent
 * attachment-carrying message and replaced older ones with a text marker. The
 * stated reason was that re-sending historical images "multiplies token cost
 * by chat length". Two things were wrong with that:
 *
 *   - an image is roughly one to three thousand tokens — smaller than text
 *     tool results we keep for the whole session — and a retained, unchanged
 *     block bills far below its first-read price on any provider with prompt
 *     caching. Retention is cheap; re-fetching is not, because a re-fetch is
 *     an extra agent loop carrying the entire working context;
 *   - replacing an image with a marker IS an edit to the prompt prefix, and
 *     an edited prefix invalidates the cached message history from that point
 *     on. The policy that existed to save tokens spent a full history re-read
 *     every time it fired.
 *
 * The operator-facing consequence was worse than the cost one: the model kept
 * its own prose about an image it could no longer see, with nothing marking
 * the absence, and would reason from that lossy summary or re-fetch the image
 * before every section of a build.
 *
 * Failed or missing loads still become explicit text notes — the model must
 * never silently believe it saw an image it didn't (same rule as
 * screenshot_external_page's loud UNAVAILABLE).
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import type { ChatAttachment, ExecutionContext } from "@caelo-cms/shared";
import { getMediaStorage } from "../../media/storage.js";
import type {
  ChatMessageInput,
  ContentPart,
  ImagePart,
  ProviderServerToolCall,
} from "../provider.js";
import { repairToolCallPairing } from "./history-repair.js";
import type { AccumulatedToolCall } from "./types.js";

/** Provider payload guard — a base64-inflated 20MB PNG breaks calls. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type AttachmentImageLoader = (
  att: ChatAttachment,
) => Promise<ImagePart | { failed: string }>;

/**
 * Default loader: media.get for the storage key, media storage for the
 * bytes. Uses the ORIGINAL variant — the model should judge the design
 * mockup at full fidelity, not a webp thumbnail.
 */
export function createMediaAttachmentLoader(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
): AttachmentImageLoader {
  return async (att) => {
    // A chat image is a bare object-store key — no media_assets row exists
    // for it by design, so there is nothing to look up.
    if (att.storageKey !== undefined) {
      try {
        const bytes = await getMediaStorage().get(att.storageKey);
        return {
          type: "image",
          base64: Buffer.from(bytes).toString("base64"),
          mediaType: att.mime,
        };
      } catch (e) {
        return {
          failed: `chat image ${att.storageKey} is gone from storage: ${
            e instanceof Error ? e.message : String(e)
          }`,
        };
      }
    }
    const r = await execute(registry, adapter, humanCtx, "media.get", { assetId: att.assetId });
    if (!r.ok) return { failed: `media.get failed for ${att.assetId}` };
    const asset = (
      r.value as {
        asset: { storageKey: string; sizeBytes: number; mime: string } | null;
      }
    ).asset;
    if (!asset) return { failed: `media asset ${att.assetId} not found (deleted?)` };
    if (asset.sizeBytes > MAX_ATTACHMENT_BYTES) {
      return {
        failed: `image ${att.assetId} is ${asset.sizeBytes} bytes — exceeds the ${MAX_ATTACHMENT_BYTES}-byte provider cap`,
      };
    }
    try {
      const bytes = await getMediaStorage().get(asset.storageKey);
      return {
        type: "image",
        base64: Buffer.from(bytes).toString("base64"),
        mediaType: att.mime,
      };
    } catch (e) {
      return {
        failed: `storage read failed for ${att.assetId}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}

export interface HistoryMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls: unknown;
  toolCallId: string | null;
  thinkingBlocks: { thinking: string; signature: string }[] | null;
  attachments?: ChatAttachment[] | null;
  /**
   * Option C — the SDK-canonical ModelMessage assembly for an assistant
   * turn (CLAUDE.md §12). When present, replay hands these straight back
   * to the SDK (via ChatMessageInput.sdkMessages) instead of rebuilding
   * from content/toolCalls/thinkingBlocks. Null on user/tool rows.
   */
  responseMessages?: unknown[] | null;
}

/**
 * Map persisted chat history into provider messages, inlining the most
 * recent user message's attachments as image parts (see file header
 * for the inline-vs-marker policy).
 */
export async function buildProviderHistory(
  messages: readonly HistoryMessage[],
  loadImage: AttachmentImageLoader,
): Promise<ChatMessageInput[]> {
  const out: ChatMessageInput[] = [];
  // Option C — an assistant row that carries the SDK's canonical assembly
  // replays it verbatim (passthrough). The SDK already pairs tool_use ↔
  // tool_result and orders reasoning blocks correctly; the OUR-format pairing
  // repair below is now passthrough-AWARE (it harvests the nested ids into its
  // inventory and never strips a passthrough row), so it runs over a mixed
  // history and heals reconstruction-row orphans (e.g. an aborted turn's
  // unanswered tool_use) even when passthrough rows coexist.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    // Any row carrying an SDK-canonical assembly replays it verbatim — an
    // assistant turn's response.messages (Option C) OR a persisted
    // tool-approval-response (Plan B production resume: the Owner's in-chat
    // Approve is stored as a role='tool' row whose responseMessages hold the
    // SDK tool-approval-response ModelMessage, replayed to resume the paused
    // gated turn).
    if (Array.isArray(m.responseMessages) && m.responseMessages.length > 0) {
      out.push({ role: m.role, content: m.content, sdkMessages: m.responseMessages });
      continue;
    }
    // Split the persisted tool_calls jsonb: serverExecuted-tagged rows
    // are Tool Search calls the API ran itself — they replay as
    // server_tool_use/tool_search_tool_result blocks (never dispatched,
    // never paired with a tool-role result), so they must NOT enter
    // `toolCalls` where the pairing repair would strip them as
    // unanswered.
    const rawCalls = Array.isArray(m.toolCalls) ? (m.toolCalls as Record<string, unknown>[]) : [];
    const serverCalls = rawCalls.filter((c) => c?.serverExecuted === true);
    const clientCalls = rawCalls.filter((c) => c?.serverExecuted !== true);
    const base: ChatMessageInput = {
      role: m.role,
      content: m.content,
      toolCalls:
        clientCalls.length > 0 ? (clientCalls as unknown as AccumulatedToolCall[]) : undefined,
      ...(serverCalls.length > 0
        ? { serverToolCalls: serverCalls as unknown as ProviderServerToolCall[] }
        : {}),
      toolCallId: m.toolCallId ?? undefined,
      // Defense-in-depth for already-poisoned sessions (see
      // streaming.ts): filter empty thinking blocks out of the replay —
      // the API rejects them with a 400 and the chat can never recover.
      ...(m.thinkingBlocks?.some((t) => t.thinking.length > 0)
        ? { thinkingBlocks: m.thinkingBlocks.filter((t) => t.thinking.length > 0) }
        : {}),
    };
    const atts = m.role === "user" && m.attachments ? m.attachments : [];
    if (atts.length === 0) {
      out.push(base);
      continue;
    }
    const parts: ContentPart[] = [];
    const failures: string[] = [];
    for (const att of atts) {
      const loaded = await loadImage(att);
      if ("failed" in loaded) failures.push(loaded.failed);
      else parts.push(loaded);
    }
    const failureNote =
      failures.length > 0
        ? `\n[NOTE: ${failures.length} attached image(s) could NOT be loaded — ${failures.join("; ")}. Do not pretend you saw them; tell the operator.]`
        : "";
    out.push({
      ...base,
      content: `${m.content}${failureNote}`,
      ...(parts.length > 0 ? { additionalContent: parts } : {}),
    });
  }
  // Run #10 D1 — tool_use/tool_result pairing repair. Heals sessions
  // already poisoned by orphan tool_results (the `approval-<uuid>` ack
  // class) or unanswered tool_uses, which otherwise 400 every future
  // turn permanently. See history-repair.ts for the fault taxonomy.
  const repaired = repairToolCallPairing(out);
  if (
    repaired.droppedToolResultIds.length > 0 ||
    repaired.strippedToolCallIds.length > 0 ||
    repaired.droppedEmptyAssistantMessages > 0
  ) {
    console.error("[chat-runner] history-repaired", {
      droppedToolResultIds: repaired.droppedToolResultIds,
      strippedToolCallIds: repaired.strippedToolCallIds,
      droppedEmptyAssistantMessages: repaired.droppedEmptyAssistantMessages,
    });
  }
  return repaired.messages;
}
