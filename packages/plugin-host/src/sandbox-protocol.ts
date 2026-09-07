// SPDX-License-Identifier: MPL-2.0

/** Bounded wire contract between an isolated plugin invocation and its host. */
import { z } from "zod";

export const SANDBOX_MESSAGE_BYTES = 1_048_576;
export const SANDBOX_CALL_LIMIT = 256;

/** Only these SDK calls may cross the process boundary. */
export const sandboxMethod = z.enum([
  "query.insert",
  "query.list",
  "query.update",
  "query.compareAndSwap",
  "query.delete",
  "api.list",
  "api.get",
  "captcha.requireProof",
]);

export const sandboxMessage = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("call"),
      id: z.number().int().nonnegative(),
      method: sandboxMethod,
      args: z.array(z.unknown()).max(4),
    })
    .strict(),
  z.object({ kind: z.literal("result"), value: z.unknown() }).strict(),
  z.object({ kind: z.literal("error"), message: z.string().max(4000) }).strict(),
]);

/** Parse complete bounded lines without buffering an unbounded child stream. */
export async function* sandboxLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffered = "";
  let bytes = 0;
  for await (const chunk of stream) {
    // Check each segment before concatenating, including a child that never emits a newline.
    let start = 0;
    for (let index = 0; index <= chunk.length; index++) {
      if (index < chunk.length && chunk[index] !== 10) continue;
      const segment = chunk.subarray(start, index);
      bytes += segment.length;
      if (bytes > SANDBOX_MESSAGE_BYTES) throw new Error("SandboxMessageTooLarge");
      buffered += decoder.decode(segment, { stream: true });
      if (index < chunk.length) {
        buffered += decoder.decode();
        if (buffered) yield buffered;
        buffered = "";
        bytes = 0;
      }
      start = index + 1;
    }
  }
  buffered += decoder.decode();
  if (buffered) throw new Error("SandboxTruncatedMessage");
}
