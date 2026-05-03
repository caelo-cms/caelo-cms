// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo/plugin-component-kit — shared Web Component helpers.
 *
 * Every Caelo plugin's Web Component (forms, comments, newsletter,
 * ratings, auth) ships an inline form / honeypot / status pattern.
 * This package consolidates that into a tiny set of helpers so:
 *   - changing the honeypot strategy edits one file (P13 will wire PoW),
 *   - inconsistencies between plugins (e.g. one escaping HTML, another
 *     not) are impossible by construction,
 *   - design tokens (`--caelo-color-*`, `--caelo-font-*`) are shared,
 *   - new plugins can mount a working surface in ~10 LOC.
 *
 * Zero deps. ESM. Browser-only — DO NOT import in server code.
 */

/** Per-component theme custom-property names — kept stable so the host
 *  page can override any of them via `:root { --caelo-color-primary: … }`. */
export const KIT_CSS = `
  :host {
    display: block;
    font-family: var(--caelo-font-body, system-ui, sans-serif);
    color: var(--caelo-color-fg, #111);
  }
  form { display: grid; gap: 0.75rem; max-width: 32rem; }
  label { display: grid; gap: 0.25rem; font-size: 0.875rem; }
  input, textarea {
    padding: 0.5rem;
    border: 1px solid var(--caelo-color-border, #ccc);
    border-radius: 0.25rem;
    font: inherit;
    background: var(--caelo-color-bg, #fff);
    color: inherit;
  }
  button {
    padding: 0.5rem 1rem;
    background: var(--caelo-color-primary, #2563eb);
    color: var(--caelo-color-on-primary, #fff);
    border: 0;
    border-radius: 0.25rem;
    cursor: pointer;
    font: inherit;
  }
  button[disabled] { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: transparent;
    color: var(--caelo-color-primary, #2563eb);
    border: 1px solid currentColor;
  }
  .hp { position: absolute; left: -9999px; top: -9999px; height: 0; width: 0; opacity: 0; pointer-events: none; }
  .ok { color: var(--caelo-color-success, #16a34a); font-size: 0.875rem; }
  .err { color: var(--caelo-color-danger, #dc2626); font-size: 0.875rem; }
`;

/** HTML-escape a string for safe interpolation into innerHTML. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Honeypot field markup. Bots fill the hidden input; real users don't.
 *  Plugin op handlers should reject or mark `status='spam'` if non-empty. */
export const HONEYPOT_FIELD_NAME = "hp_address";

export function honeypotFieldHtml(): string {
  return `<input class="hp" tabindex="-1" autocomplete="off" name="${HONEYPOT_FIELD_NAME}" />`;
}

/** Read the honeypot value from a FormData and return whether it tripped. */
export function isHoneypotTripped(fd: FormData): boolean {
  return ((fd.get(HONEYPOT_FIELD_NAME) as string | null) ?? "").trim() !== "";
}

/**
 * Tiny `fetch` wrapper for plugin POSTs. Always sends JSON, always
 * sends `credentials: same-origin` so the gateway's HttpOnly session
 * cookie travels along. Returns the parsed envelope as-is.
 */
export interface PluginEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { kind?: string; message?: string };
}

export async function postPluginJson<T = unknown>(
  pluginSlug: string,
  operation: string,
  body: Record<string, unknown>,
): Promise<PluginEnvelope<T>> {
  const res = await fetch(`/api/plugin/${pluginSlug}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  return res.json() as Promise<PluginEnvelope<T>>;
}

/**
 * Read the bake timestamp injected by the static generator's plugin
 * pass. Web Components use this to scope `since` queries on delta-fetch:
 * only fetch rows added AFTER the static page was baked.
 */
export function readBakeTimestamp(host: HTMLElement, slug: string): string | null {
  const pageId = host.getAttribute("page-id") ?? "";
  if (!pageId) return null;
  // Look up via the document (not host's shadow root) — the placeholder
  // lives in the host page, not inside the component.
  const doc = host.ownerDocument ?? document;
  const placeholder = doc.querySelector(`[data-caelo-plugin="${slug}"][data-page-id="${pageId}"]`);
  return placeholder?.getAttribute("data-baked-at") ?? null;
}

/**
 * Fetch a fresh PoW captcha challenge, solve it locally, and return the
 * proof object the plugin op should pass as `_caelo_captcha`. Real users
 * pay ~50ms; bots pay the same per submission. Returns null when the
 * gateway has captcha disabled (`provider: 'off'`).
 */
export interface CaptchaProof {
  readonly challenge: string;
  readonly nonce: string;
}

interface ChallengeEnvelope {
  ok: boolean;
  data?: { challenge: string; target: string; expiresAt: string };
}

export async function attachCaptchaProof(): Promise<CaptchaProof | null> {
  const res = await fetch("/api/captcha/challenge", { credentials: "same-origin" });
  if (res.status === 204) return null; // captcha disabled
  if (!res.ok) throw new Error(`captcha challenge fetch failed: ${res.status}`);
  const env = (await res.json()) as ChallengeEnvelope;
  if (!env.ok || !env.data) throw new Error("captcha challenge envelope malformed");
  const { challenge, target } = env.data;
  const nonce = await solvePow(challenge, target);
  return { challenge, nonce };
}

async function solvePow(challenge: string, target: string): Promise<string> {
  const enc = new TextEncoder();
  let counter = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const nonce = counter.toString(16);
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(`${challenge}${nonce}`));
    const hex = bufferToHex(digest);
    if (hex.startsWith(target)) return nonce;
    counter += 1;
    // Safety valve so a wildly mis-tuned target doesn't lock the page.
    if (counter > 5_000_000) throw new Error("pow solve exceeded budget");
  }
}

function bufferToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Set a `[data-status]` `<p>` element to a message + ok/err class. */
export function setStatus(
  el: HTMLElement | null,
  kind: "ok" | "err" | "clear",
  message = "",
): void {
  if (!el) return;
  if (kind === "clear") {
    el.textContent = "";
    el.className = "";
    return;
  }
  el.textContent = message;
  el.className = kind;
}
