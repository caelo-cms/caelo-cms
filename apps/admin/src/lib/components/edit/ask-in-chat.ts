// SPDX-License-Identifier: MPL-2.0

/**
 * Puts `text` into the live editor's chat composer, for the operator to
 * read, edit and send. The editor's own controls (the SEO info, the plugin
 * toolbar items) use it for their "ask the AI" buttons; it never sends, so
 * nothing outside the operator's Send makes the AI act. The Overlay
 * expands a collapsed chat first, so the composer exists to receive it.
 */
export function askInChat(text: string): void {
  document.dispatchEvent(new CustomEvent("caelo:insert-into-composer", { detail: { text } }));
}
