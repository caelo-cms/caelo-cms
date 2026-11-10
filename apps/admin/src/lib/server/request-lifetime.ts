// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — when an admin request is over. The plugin host renews its
 * runtime heartbeat while any request is in flight
 * (`holdRuntimeHeartbeat`), so a server busy with a long request — a chat
 * turn streams for minutes — keeps counting as live for the other servers.
 * SvelteKit's `resolve` returns once a response's headers are ready, and an
 * event stream goes on after that; its end is the end of its body.
 */

/**
 * Call `release` once `response` is sent: at once for a body that is
 * complete when the handler answers, after the last chunk — or when the
 * client went away — for an event stream (`text/event-stream`, the chat
 * stream, a remote MCP call's streamed answer, the gateway live view).
 *
 * @returns the response to send, wrapped when its end has to be observed
 */
export function releaseWhenSent(response: Response, release: () => void): Response {
  const body = response.body;
  const streams = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!body || !streams) {
    release();
    return response;
  }
  const reader = body.getReader();
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
