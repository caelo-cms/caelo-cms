// SPDX-License-Identifier: MPL-2.0

/**
 * issue #190 — provider-history assembly for operator-attached images.
 *
 * Attachments persist on chat_messages rows (migration 0111), so a
 * reloaded transcript keeps its thumbnails and a regenerated turn
 * knows what rode each message. For PROVIDER calls the policy is
 * deliberately asymmetric:
 *
 *   - the MOST RECENT user message with attachments gets its images
 *     inlined as image parts — that's the message the model is acting
 *     on right now;
 *   - older attachment-carrying messages get a text marker instead
 *     (`[attached image: …]`), because re-sending every historical
 *     image on every turn multiplies token cost by chat length while
 *     adding nothing the model didn't already see when the image was
 *     current.
 *
 * Failed or oversized loads become explicit text notes — the model
 * must never silently believe it saw an image it didn't (same rule as
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

function attachmentMarker(atts: readonly ChatAttachment[]): string {
  return atts
    .map((a) => `[attached image: ${a.alt && a.alt.length > 0 ? a.alt : a.mime}]`)
    .join(" ");
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
  const lastAttachedIdx = messages.reduce(
    (acc, m, i) => (m.role === "user" && m.attachments && m.attachments.length > 0 ? i : acc),
    -1,
  );
  const out: ChatMessageInput[] = [];
  // Option C — an assistant row that carries the SDK's canonical assembly
  // replays it verbatim (passthrough). Track whether any row did so: the
  // SDK already pairs tool_use ↔ tool_result and orders reasoning blocks
  // correctly, so the OUR-format pairing repair below must NOT run over a
  // passthrough history (it can't see the tool_use blocks nested inside the
  // opaque sdkMessages and would strip the matching tool-role rows as
  // orphans). Pre-1.0 hard cut: every new assistant row has these.
  let sawSdkPassthrough = false;
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
      sawSdkPassthrough = true;
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
    if (i !== lastAttachedIdx) {
      out.push({ ...base, content: `${m.content}\n${attachmentMarker(atts)}` });
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
  // Option C — the pairing repair operates on OUR reconstructed tool_use /
  // tool_result shape. With an SDK-passthrough history the assistant turns
  // are opaque ModelMessages, so the repair can't inspect their tool_use
  // ids and would drop the paired tool-role rows as orphans. The SDK's
  // assembly is already correctly paired, so skip the repair entirely.
  if (sawSdkPassthrough) return out;
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
