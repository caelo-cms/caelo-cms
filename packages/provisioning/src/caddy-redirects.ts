// SPDX-License-Identifier: MPL-2.0

/**
 * How the self-hosted Caddy picks up a deploy's redirect snippet (#587).
 *
 * Each public site block imports `<site root>/_redirects.caddy`, which the
 * static generator rewrites on every build. Caddy reads imports only when it
 * loads a config, so something must reload it after a deploy. The container
 * does that itself: its command runs Caddy plus a small loop that watches a
 * checksum of the snippets and runs `caddy reload` (against Caddy's own
 * localhost admin endpoint, inside the container) when they change.
 *
 * Why not the alternatives:
 * - `caddy run --watch` stops watching for good after the first config that
 *   fails to load — a snippet read while a deploy is still copying it would
 *   freeze the redirects until Caddy restarts.
 * - The admin reloading Caddy through the admin API would need a channel
 *   from the admin into Caddy and would post a file's content over HTTP.
 *
 * The loop waits until the checksum is stable across two reads before
 * reloading (a deploy may be mid-copy), and a reload Caddy rejects only
 * logs: Caddy keeps the previous config, and the next change retries.
 */

/** Seconds between checksum polls. */
const POLL_SECONDS = 2;

/**
 * The container's shell script: Caddy in the foreground of the container's
 * lifetime, reloaded when any file matching `snippetGlob` changes.
 *
 * @param snippetGlob Shell glob of the imported snippets, e.g.
 *   `/srv/caelo/output/*\/current/_redirects.caddy`.
 */
export function caddyRedirectReloadScript(snippetGlob: string): string {
  if (/[\s'"`$\\;&|<>]/.test(snippetGlob)) {
    throw new Error(`caddy-redirects: unsafe snippet glob ${JSON.stringify(snippetGlob)}`);
  }
  const config = "--config /etc/caddy/Caddyfile --adapter caddyfile";
  return [
    `sum() { cat ${snippetGlob} 2>/dev/null | md5sum; }`,
    "last=$(sum)",
    `caddy run ${config} &`,
    "pid=$!",
    `trap 'kill -TERM "$pid" 2>/dev/null; wait "$pid"; exit $?' TERM INT`,
    `while kill -0 "$pid" 2>/dev/null; do`,
    `  sleep ${POLL_SECONDS}`,
    "  now=$(sum)",
    `  [ "$now" = "$last" ] && continue`,
    // A deploy may still be copying the file: reload only a stable one.
    "  sleep 1",
    `  [ "$(sum)" = "$now" ] || continue`,
    "  last=$now",
    `  caddy reload ${config} || echo "caelo: redirects changed but Caddy rejected the reload; still serving the previous redirects" >&2`,
    "done",
    `wait "$pid"`,
  ].join("\n");
}

/**
 * A Compose `command:` line running {@link caddyRedirectReloadScript}. `$` is
 * doubled because Compose interpolates `$VAR` in the file; the JSON string is
 * a valid YAML double-quoted scalar.
 */
export function caddyRedirectReloadCommand(snippetGlob: string): string {
  const script = caddyRedirectReloadScript(snippetGlob).replaceAll("$", () => "$$");
  return `command: ["/bin/sh", "-c", ${JSON.stringify(script)}]`;
}
