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
 *
 * #1396 — tool images replay exactly as they were sent. A tool that returns
 * an image (screenshot_page, screenshot_external_page, generate_image, …)
 * reaches the model through a follow-up `user` message placed after every
 * tool result of its step ({@link toolImageMessage}, built by
 * tool-dispatch.ts). The image itself persists as an attachment on the tool
 * row. The replay rebuilds that same message from the tool row — same text,
 * same image part, same position after the step's tool rows — so the history
 * of the next turn is byte-identical to the request the live turn sent.
 * Replaying images from user rows only left those messages out, and every
 * turn after a screenshot re-read the whole history past that point instead
 * of hitting the prompt cache.
 */

import type { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { execute } from "@caelo-cms/query-api";
import {
  CHAT_IMAGE_MIMES,
  CHAT_MAX_ATTACHMENT_BYTES,
  type ChatAttachment,
  type ExecutionContext,
} from "@caelo-cms/shared";
import { getMediaStorage } from "../../media/storage.js";
import type {
  ChatMessageInput,
  ContentPart,
  ImagePart,
  ProviderServerToolCall,
} from "../provider.js";
import { repairToolCallPairing } from "./history-repair.js";
import { rewriteRetiredToolReferences } from "./retired-tool-references.js";
import type { AccumulatedToolCall } from "./types.js";

/** Provider payload guard — a base64-inflated 20MB PNG breaks calls. */
const MAX_ATTACHMENT_BYTES = CHAT_MAX_ATTACHMENT_BYTES;

export type AttachmentImageLoader = (
  att: ChatAttachment,
) => Promise<ImagePart | { failed: string }>;

/**
 * Default loader: media.get for the storage key, media storage for the
 * bytes. Uses the ORIGINAL variant — the model should judge the design
 * mockup at full fidelity, not a webp thumbnail.
 *
 * #1216 — one loader serves one turn: each image is read and encoded at
 * most once (a content-addressed screenshot that several messages
 * reference shares ONE base64 string), and every source is size-checked
 * before its bytes are read, so an oversized object never reaches memory.
 */
export function createMediaAttachmentLoader(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
): AttachmentImageLoader {
  const loaded = new Map<string, Promise<ImagePart | { failed: string }>>();
  const load = (att: ChatAttachment): Promise<ImagePart | { failed: string }> =>
    att.storageKey !== undefined
      ? loadChatImage(att.storageKey, att.mime)
      : loadMediaAsset(registry, adapter, humanCtx, att.assetId);
  return (att) => {
    const key = att.storageKey !== undefined ? `key:${att.storageKey}` : `asset:${att.assetId}`;
    let pending = loaded.get(key);
    if (!pending) {
      pending = load(att);
      loaded.set(key, pending);
    }
    return pending;
  };
}

/**
 * A chat image is a bare object-store key — no media_assets row exists for
 * it by design, so there is nothing to look up; its size comes from storage.
 */
async function loadChatImage(
  storageKey: string,
  mime: ChatAttachment["mime"],
): Promise<ImagePart | { failed: string }> {
  try {
    const size = await getMediaStorage().size(storageKey);
    if (size > MAX_ATTACHMENT_BYTES) {
      return {
        failed: `chat image ${storageKey} is ${size} bytes — exceeds the ${MAX_ATTACHMENT_BYTES}-byte provider cap`,
      };
    }
    const bytes = await getMediaStorage().get(storageKey);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { failed: `chat image ${storageKey} exceeds the provider byte cap` };
    }
    return { type: "image", base64: Buffer.from(bytes).toString("base64"), mediaType: mime };
  } catch (e) {
    return {
      failed: `chat image ${storageKey} is gone from storage: ${
        e instanceof Error ? e.message : String(e)
      }`,
    };
  }
}

/** An operator-uploaded media asset: its row names the key, mime and size. */
async function loadMediaAsset(
  registry: OperationRegistry,
  adapter: DatabaseAdapter,
  humanCtx: ExecutionContext,
  assetId: string | undefined,
): Promise<ImagePart | { failed: string }> {
  if (assetId === undefined)
    return { failed: "attachment names neither a storage key nor an asset" };
  const r = await execute(registry, adapter, humanCtx, "media.get", { assetId });
  if (!r.ok) return { failed: `media.get failed for ${assetId}` };
  const asset = (
    r.value as {
      asset: { storageKey: string; sizeBytes: number; mime: string } | null;
    }
  ).asset;
  if (!asset) return { failed: `media asset ${assetId} not found (deleted?)` };
  if (!CHAT_IMAGE_MIMES.includes(asset.mime as (typeof CHAT_IMAGE_MIMES)[number])) {
    return { failed: `media asset ${assetId} is not a supported chat image` };
  }
  if (asset.sizeBytes > MAX_ATTACHMENT_BYTES) {
    return {
      failed: `image ${assetId} is ${asset.sizeBytes} bytes — exceeds the ${MAX_ATTACHMENT_BYTES}-byte provider cap`,
    };
  }
  try {
    const bytes = await getMediaStorage().get(asset.storageKey);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES)
      return { failed: `image ${assetId} exceeds the provider byte cap` };
    return {
      type: "image",
      base64: Buffer.from(bytes).toString("base64"),
      mediaType: asset.mime as (typeof CHAT_IMAGE_MIMES)[number],
    };
  } catch (e) {
    return {
      failed: `storage read failed for ${assetId}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * #1396 — the follow-up user message that delivers a tool's image to the
 * model. The live turn (tool-dispatch.ts) and the replay
 * ({@link buildProviderHistory}) both build it here, so the two cannot
 * drift apart by a byte: a different text or shape on replay would
 * invalidate the provider's prompt cache from this message on.
 *
 * @param image the image part, or — on replay only — the text note that
 *   takes its place when the stored image can no longer be read.
 */
export function toolImageMessage(toolName: string, image: ContentPart): ChatMessageInput {
  return {
    role: "user",
    content: `[Screenshot returned by ${toolName}; analyse it for the operator's request.]`,
    additionalContent: [image],
  };
}

/**
 * Text that takes the place of a tool image whose stored copy is gone. Same
 * position and shape as compaction's IMAGE_REMOVED_NOTE: the message stays,
 * only its image part becomes a text part.
 */
function toolImageUnavailableNote(reason: string): string {
  return (
    `[NOTE: this image could NOT be loaded (${reason}). You can no longer see it — ` +
    "do not describe it from memory; take a new screenshot if you need it again.]"
  );
}

/**
 * Tool call id → tool name, from every assistant row of the history (the
 * SDK's assembly when present, else the reconstruction-lane `toolCalls`).
 * The follow-up text names the tool, and a tool row stores only the call id.
 */
function toolNamesByCallId(messages: readonly HistoryMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (Array.isArray(m.responseMessages) && m.responseMessages.length > 0) {
      for (const message of m.responseMessages as { role?: string; content?: unknown }[]) {
        if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
        for (const part of message.content as {
          type?: string;
          toolCallId?: string;
          toolName?: string;
        }[]) {
          if (part?.type === "tool-call" && part.toolCallId && part.toolName) {
            names.set(part.toolCallId, part.toolName);
          }
        }
      }
      continue;
    }
    if (!Array.isArray(m.toolCalls)) continue;
    for (const call of m.toolCalls as { id?: unknown; name?: unknown }[]) {
      if (typeof call?.id === "string" && typeof call.name === "string") {
        names.set(call.id, call.name);
      }
    }
  }
  return names;
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
 * Map persisted chat history into provider messages: every user row's
 * attachments become image parts on that message, and every tool row's image
 * becomes the follow-up user message the live turn sent, after the step's
 * last tool row (see the file header).
 *
 * `onRepair` (issue #442) fires when the pairing repair changed anything —
 * in particular when it healed a dangling providerExecuted tool-search call
 * (`strippedServerToolCallIds`), which the caller must surface as a
 * bug-report row: a heal means the session WAS wedged, and that must never
 * pass silently (CLAUDE.md §2).
 */
export async function buildProviderHistory(
  messages: readonly HistoryMessage[],
  loadImage: AttachmentImageLoader,
  onRepair?: (repair: import("./history-repair.js").HistoryRepairResult) => Promise<void> | void,
): Promise<ChatMessageInput[]> {
  const out: ChatMessageInput[] = [];
  // Option C — an assistant row that carries the SDK's canonical assembly
  // replays it verbatim (passthrough). The SDK already pairs tool_use ↔
  // tool_result and orders reasoning blocks correctly; the OUR-format pairing
  // repair below is now passthrough-AWARE (it harvests the nested ids into its
  // inventory and never strips a passthrough row), so it runs over a mixed
  // history and heals reconstruction-row orphans (e.g. an aborted turn's
  // unanswered tool_use) even when passthrough rows coexist.
  const callNames = toolNamesByCallId(messages);
  // Follow-ups of tool rows — #991's text of a tool-loading result and
  // #1396's tool images — are messages the live turn appended AFTER all of
  // its step's tool results (a user message between two results of one step
  // breaks the pairing). They are tied to the tool row they belong to and
  // placed only after the pairing repair, so a row the repair drops (a
  // repeated result) takes its follow-ups with it and a row it relocates
  // brings them along (see placeToolFollowUps).
  const followUpsOf = new Map<ChatMessageInput, ChatMessageInput[]>();
  const pushRow = (row: ChatMessageInput, followUps: readonly ChatMessageInput[]): void => {
    out.push(row);
    if (followUps.length > 0) followUpsOf.set(row, [...followUps]);
  };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const rowFollowUps: ChatMessageInput[] = [];
    if (m.role === "tool" && Array.isArray(m.responseMessages) && m.responseMessages.length > 0) {
      const split = splitToolFollowUps(m.responseMessages);
      if (split.followUps.length > 0) {
        // Live order per call: the tool-loading text, then the image.
        rowFollowUps.push(...split.followUps);
        rowFollowUps.push(...(await replayToolImages(m, callNames, loadImage)));
        pushRow({ role: m.role, content: m.content, sdkMessages: split.inPlace }, rowFollowUps);
        continue;
      }
    }
    if (m.role === "tool" && m.attachments && m.attachments.length > 0) {
      rowFollowUps.push(...(await replayToolImages(m, callNames, loadImage)));
    }
    // Any row carrying an SDK-canonical assembly replays it verbatim — an
    // assistant turn's response.messages (Option C) OR a persisted
    // tool-approval-response (Plan B production resume: the Owner's in-chat
    // Approve is stored as a role='tool' row whose responseMessages hold the
    // SDK tool-approval-response ModelMessage, replayed to resume the paused
    // gated turn).
    if (Array.isArray(m.responseMessages) && m.responseMessages.length > 0) {
      pushRow({ role: m.role, content: m.content, sdkMessages: m.responseMessages }, rowFollowUps);
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
      pushRow(base, rowFollowUps);
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
  // class), unanswered tool_uses, or issue #442's dangling providerExecuted
  // tool-search calls, which otherwise 400 every future turn permanently.
  // See history-repair.ts for the fault taxonomy.
  const repaired = repairToolCallPairing(out);
  if (
    repaired.droppedToolResultIds.length > 0 ||
    repaired.strippedToolCallIds.length > 0 ||
    repaired.droppedEmptyAssistantMessages > 0 ||
    repaired.strippedServerToolCallIds.length > 0 ||
    repaired.answeredInterruptedCalls.length > 0 ||
    repaired.relocatedToolResultIds.length > 0
  ) {
    console.error("[chat-runner] history-repaired", {
      droppedToolResultIds: repaired.droppedToolResultIds,
      strippedToolCallIds: repaired.strippedToolCallIds,
      droppedEmptyAssistantMessages: repaired.droppedEmptyAssistantMessages,
      strippedServerToolCallIds: repaired.strippedServerToolCallIds,
      answeredInterruptedCalls: repaired.answeredInterruptedCalls,
      relocatedToolResultIds: repaired.relocatedToolResultIds,
    });
    await onRepair?.(repaired);
  }
  // A tool-search result naming a since-retired tool 400s every replay;
  // point it at the live replacement (retired-tool-references.ts).
  const placed = placeToolFollowUps(repaired.messages, followUpsOf);
  const { messages: replayable, rewrites } = rewriteRetiredToolReferences(placed);
  if (rewrites.length > 0) {
    console.error("[chat-runner] history-retired-tool-references", { rewrites });
  }
  return replayable;
}

/**
 * #1396 — the follow-up message(s) a tool row's image(s) rode in the live
 * turn: one message per image, exactly as tool-dispatch.ts built it.
 *
 * A stored image that cannot be read any more keeps its message and gets a
 * text note in place of the image part. That keeps the history's shape (the
 * same messages in the same order) and tells the model the image is gone,
 * instead of letting it believe it still sees it; the prompt cache for that
 * old prefix is long expired by the time an image disappears. A tool row
 * whose call is in no assistant row is an orphan the pairing repair drops,
 * so it gets no follow-up either.
 */
async function replayToolImages(
  m: HistoryMessage,
  callNames: ReadonlyMap<string, string>,
  loadImage: AttachmentImageLoader,
): Promise<ChatMessageInput[]> {
  const toolName = m.toolCallId ? callNames.get(m.toolCallId) : undefined;
  if (toolName === undefined) return [];
  const followUps: ChatMessageInput[] = [];
  for (const att of m.attachments ?? []) {
    const loaded = await loadImage(att);
    followUps.push(
      toolImageMessage(
        toolName,
        "failed" in loaded
          ? { type: "text", text: toolImageUnavailableNote(loaded.failed) }
          : loaded,
      ),
    );
  }
  return followUps;
}

/**
 * #991 — a tool row's stored SDK messages, split into the ones that stay in
 * place (the tool message) and its text follow-ups (user messages with
 * string content), which replay as plain user rows after the tool-row run —
 * the same row the live turn appended, so the replayed bytes match.
 */
function splitToolFollowUps(responseMessages: readonly unknown[]): {
  inPlace: unknown[];
  followUps: ChatMessageInput[];
} {
  const inPlace: unknown[] = [];
  const followUps: ChatMessageInput[] = [];
  for (const message of responseMessages) {
    const msg = message as { role?: unknown; content?: unknown } | null;
    if (msg?.role === "user" && typeof msg.content === "string") {
      followUps.push({ role: "user", content: msg.content });
    } else {
      inPlace.push(message);
    }
  }
  return { inPlace, followUps };
}

/** Result ids a tool row answers: its own id, or those inside its SDK messages. */
function toolResultIdsOf(row: ChatMessageInput): string[] {
  if (row.toolCallId) return [row.toolCallId];
  const ids: string[] = [];
  for (const message of (row.sdkMessages ?? []) as { role?: string; content?: unknown }[]) {
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: string; toolCallId?: string }[]) {
      if (part?.type === "tool-result" && part.toolCallId) ids.push(part.toolCallId);
    }
  }
  return ids;
}

/**
 * Put every surviving tool row's follow-ups after the run of tool rows it
 * ends up in — where the live turn put them. A row the pairing repair
 * dropped (a repeated or orphaned result) has no follow-up in the output;
 * a relocated row brings its own. A passthrough row the repair rewrote is a
 * new object, so it is matched to its original by the result ids it still
 * answers.
 */
function placeToolFollowUps(
  messages: readonly ChatMessageInput[],
  followUpsOf: ReadonlyMap<ChatMessageInput, ChatMessageInput[]>,
): ChatMessageInput[] {
  if (followUpsOf.size === 0) return [...messages];
  const byResultId = new Map<string, ChatMessageInput>();
  for (const row of followUpsOf.keys()) {
    if (!row.sdkMessages) continue;
    for (const id of toolResultIdsOf(row)) if (!byResultId.has(id)) byResultId.set(id, row);
  }
  const placedFor = new Set<ChatMessageInput>();
  const out: ChatMessageInput[] = [];
  let pending: ChatMessageInput[] = [];
  for (const m of messages) {
    if (m.role !== "tool") {
      out.push(...pending);
      pending = [];
    }
    out.push(m);
    if (m.role !== "tool") continue;
    let original: ChatMessageInput | undefined = followUpsOf.has(m) ? m : undefined;
    if (!original && m.sdkMessages) {
      original = toolResultIdsOf(m)
        .map((id) => byResultId.get(id))
        .find((row) => row !== undefined);
    }
    if (!original || placedFor.has(original)) continue;
    placedFor.add(original);
    pending.push(...(followUpsOf.get(original) ?? []));
  }
  out.push(...pending);
  return out;
}
