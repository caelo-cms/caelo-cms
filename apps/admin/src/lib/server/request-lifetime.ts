// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1361 — when an admin request is over. The plugin host renews its
 * runtime heartbeat while any request is in flight
 * (`holdRuntimeHeartbeat`), so a server busy with a long request keeps
 * counting as live for the other servers. SvelteKit's `resolve` returns once
 * a response's headers are ready, and its body can go on long after that: an
 * event stream (a chat turn streams for minutes), a page whose load streams,
 * a large media file to a slow client. The request ends with its body.
 */

/**
 * Call `release` once `response` is sent: after its body's last chunk, or
 * when the client went away. At once when there is no body to wait for:
 * none, or one that carries an `ETag`. SvelteKit sets an ETag only on a page
 * it rendered whole, and after this hook it answers a matching
 * `If-None-Match` with a 304 of its own, dropping the body unread, so a
 * wrapped one would never release.
 *
 * @returns the response to send, wrapped when its end has to be observed
 */
export function releaseWhenSent(response: Response, release: () => void): Response {
  const body = response.body;
  // A locked body cannot be sent at all; the adapter reports it.
  if (!body || body.locked || response.headers.has("etag")) {
    release();
    return response;
  }
  const reader = body.getReader();
  // Pull-through, one chunk per read: a body that is complete when the
  // handler answers still settles all its reads before the next macrotask,
  // which is how the adapter measures it for a `content-length`.
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
