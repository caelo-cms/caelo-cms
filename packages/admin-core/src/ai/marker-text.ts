// SPDX-License-Identifier: MPL-2.0

/**
 * Neutralize a module display name for safe interpolation into the HTML
 * comment markers the chat-runner emits as page-content boundaries
 * (`<!-- BEGIN module=… displayName="…" -->`), which the AI reads back.
 *
 * Escapes backslashes BEFORE quotes — escaping the quote alone leaves a
 * trailing `\` able to escape the closing quote (CodeQL
 * js/incomplete-sanitization) — then removes the sequences that would
 * break out of the `<!-- … -->` comment itself (`-->`, any `--` run, raw
 * angle brackets, newlines). Behaviour-preserving for ordinary names.
 */
export function sanitizeMarkerDisplayName(name: string): string {
  return name
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/-{2,}/g, "-")
    .replace(/[<>\r\n]/g, " ");
}
