// SPDX-License-Identifier: MPL-2.0

/**
 * issue #356 — periodic sweep for chat images.
 *
 * Images the AI produces during a chat (page screenshots, external-site
 * captures, crawled source pages) are conversation content: they persist on
 * their message and replay for as long as that message lives, exactly like
 * text. That makes them accumulate, and unlike an operator's uploads they have
 * no life outside the conversation that produced them — nobody curates them,
 * nobody browses them, and once a chat is old they are dead weight in the
 * object store.
 *
 * So they live under their own `chat-images/` prefix rather than in
 * `media_assets`, and this worker removes the old ones weekly.
 *
 * Two properties make the sweep non-obvious:
 *
 *   - **keys are content-addressed**, so two chats that screenshot the same
 *     unchanged page share one object. A key may only be deleted when NO
 *     surviving message still references it, otherwise the sweep would blind
 *     an active conversation;
 *   - **the storage adapter has no `list()`** (see `MediaStorageAdapter`), so
 *     the sweep is driven from `chat_messages.attachments` rather than by
 *     walking the prefix. That is the better direction anyway: storage and DB
 *     cannot drift apart, because the DB is what decides.
 *
 * The aged rows also lose their attachment reference, so a replayed old
 * transcript shows the text result without attempting a read that would fail.
 *
 * Cadence: every 24h, sweeping images older than 7 days. Same bootstrap shape
 * as proposal-gc-worker.ts; called from hooks.server.ts.
 */

import type { DatabaseAdapter } from "@caelo-cms/query-api";
import { isChatImageKey } from "@caelo-cms/shared";

import { getMediaStorage } from "./media/storage.js";

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ChatImageGcOpts {
  readonly adapter: DatabaseAdapter;
  /** Override poll interval (ms). Tests pass smaller values. */
  readonly intervalMs?: number;
  /** Chat images on messages older than this are swept. Default 7 days. */
  readonly staleAfterMs?: number;
}

let workerHandle: ReturnType<typeof setInterval> | null = null;

export interface ChatImageGcResult {
  /** Objects actually removed from storage. */
  readonly deletedObjects: number;
  /** Keys left alone because a surviving message still references them. */
  readonly keptShared: number;
  /** Message rows whose attachment reference was cleared. */
  readonly clearedRows: number;
}

/**
 * One sweep. Exported so a test can drive it directly instead of waiting a
 * day, and so an operator tool can trigger it on demand later.
 */
export async function sweepChatImagesOnce(opts: ChatImageGcOpts): Promise<ChatImageGcResult> {
  const cutoffSeconds = Math.floor((opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS) / 1000);
  let deletedObjects = 0;
  let keptShared = 0;
  let clearedRows = 0;

  const { staleKeys, liveKeys, rowIds } = await opts.adapter.rawAdmin().begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    // Keys referenced by messages PAST the cutoff (deletion candidates) and
    // keys referenced by messages inside it (must survive). A key in both sets
    // is shared with a live conversation and stays.
    const rows = (await tx.unsafe(
      `SELECT m.id::text AS id,
              a->>'storageKey' AS key,
              (m.created_at < now() - make_interval(secs => ${cutoffSeconds})) AS is_stale
         FROM chat_messages m,
              LATERAL jsonb_array_elements(m.attachments::jsonb) a
        WHERE m.attachments IS NOT NULL
          AND a ? 'storageKey'`,
    )) as unknown as { id: string; key: string; is_stale: boolean }[];

    const stale = new Set<string>();
    const live = new Set<string>();
    const ids = new Set<string>();
    for (const r of rows) {
      if (!r.key || !isChatImageKey(r.key)) continue;
      if (r.is_stale) {
        stale.add(r.key);
        ids.add(r.id);
      } else {
        live.add(r.key);
      }
    }
    return { staleKeys: [...stale], liveKeys: live, rowIds: [...ids] };
  });

  for (const key of staleKeys) {
    if (liveKeys.has(key)) {
      keptShared += 1;
      continue;
    }
    try {
      await getMediaStorage().delete(key);
      deletedObjects += 1;
    } catch (e) {
      // A missing object is the desired end state, so this is not worth
      // failing the sweep over — but it is worth saying, because a systematic
      // failure here means the store is growing unchecked.
      console.error("[chat-image-gc] delete failed", {
        key,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (rowIds.length > 0) {
    await opts.adapter.rawAdmin().begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const result = (await tx.unsafe(
        `UPDATE chat_messages
            SET attachments = NULL
          WHERE id = ANY(ARRAY[${rowIds.map((id) => `'${id}'::uuid`).join(",")}])
          RETURNING id`,
      )) as unknown as { id: string }[];
      clearedRows = result.length;
    });
  }

  return { deletedObjects, keptShared, clearedRows };
}

/** Start the daily sweep. Idempotent — a second call is a no-op. */
export function startChatImageGcWorker(opts: ChatImageGcOpts): void {
  if (workerHandle !== null) return;
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const run = (): void => {
    void sweepChatImagesOnce(opts)
      .then((r) => {
        if (r.deletedObjects > 0 || r.clearedRows > 0) {
          console.error("[chat-image-gc] swept", r);
        }
      })
      .catch((e: unknown) => {
        console.error("[chat-image-gc] sweep failed", {
          message: e instanceof Error ? e.message : String(e),
        });
      });
  };
  workerHandle = setInterval(run, intervalMs);
  // Node keeps the process alive for a pending timer; a housekeeping sweep
  // must never be the reason a container refuses to exit.
  workerHandle.unref?.();
  run();
}

/** Stop the sweep (tests, graceful shutdown). */
export function stopChatImageGcWorker(): void {
  if (workerHandle === null) return;
  clearInterval(workerHandle);
  workerHandle = null;
}
