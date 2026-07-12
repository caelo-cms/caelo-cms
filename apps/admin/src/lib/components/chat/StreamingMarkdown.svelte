<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.45 — streaming markdown renderer for chat assistant + tool
   * messages. Parses GFM with marked + sanitizes with DOMPurify before
   * inserting via {@html}.
   *
   * "Streaming-friendly" means: re-render on every text-delta is fine.
   * marked tolerates partial input (unclosed code fences, dangling list
   * items) by treating it as in-progress. The cost is one parse per
   * delta — for chat-sized transcripts (≤ a few KB per message) that's
   * sub-millisecond and well within the budget the SSE arrives at.
   *
   * User messages stay plain-text rendered upstream; only assistant +
   * tool messages flow through here.
   */

  import { browser } from "$app/environment";
  import DOMPurify from "dompurify";
  import { marked } from "marked";

  interface Props {
    text: string;
    /** Optional class string applied to the wrapping <div>. */
    class?: string;
  }
  let { text, class: className = "" }: Props = $props();

  // marked options:
  //  - gfm: tables, strikethrough, autolinks, fenced code
  //  - breaks: single newline → <br>; matches operator chat phrasing
  //  - async: false → marked.parse returns a string synchronously
  marked.setOptions({ gfm: true, breaks: true, async: false });

  // DOMPurify needs a real DOM (window/document). On SSR (the
  // /edit live-edit overlay renders the chat panel server-side via
  // SvelteKit), there is no window — calling sanitize() throws and
  // the entire page returns 500. Gate sanitization behind `browser`
  // and render a plain-text fallback during SSR. The client hydrates
  // to the rendered markdown on mount; the visible flicker is
  // imperceptible because the chat panel mounts before any paint
  // that contains assistant text. Server-side avoiding {@html}
  // entirely also closes the XSS hole that an SSR DOMPurify shim
  // would have opened — there's no path where unsanitized text ever
  // reaches a {@html} sink.
  let html = $derived(
    browser
      ? DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
          // Allow common markdown output but block any HTML the LLM
          // might emit that would break out of the message bubble.
          ALLOWED_TAGS: [
            "p", "br", "hr", "blockquote",
            "ul", "ol", "li",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "strong", "em", "del", "code", "pre",
            "a", "img",
            "table", "thead", "tbody", "tr", "th", "td",
            "span", "div",
          ],
          ALLOWED_ATTR: ["href", "title", "alt", "src", "class"],
        })
      : "",
  );
</script>

<div class={`chat-markdown text-sm leading-relaxed ${className}`}>
  {#if browser}
    {@html html}
  {:else}
    <pre class="whitespace-pre-wrap break-words font-sans">{text}</pre>
  {/if}
</div>

<style>
  /* Style overrides scoped to the rendered markdown. tailwind's prose
     plugin handles most things; this keeps overall vertical rhythm
     compact for chat bubbles. */
  div :global(p) { margin: 0.25rem 0; }
  div :global(p:first-child) { margin-top: 0; }
  div :global(p:last-child) { margin-bottom: 0; }
  div :global(pre) {
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    background: hsl(var(--muted));
    overflow-x: auto;
    font-size: 0.85em;
  }
  div :global(code) {
    padding: 0.1rem 0.3rem;
    border-radius: 0.25rem;
    background: hsl(var(--muted));
    font-size: 0.85em;
  }
  div :global(pre code) {
    padding: 0;
    background: transparent;
  }
  /* Tailwind preflight strips list markers and the `prose` plugin was
     never installed (the old class list was dead) — numbered/bulleted
     lists in assistant messages rendered marker-less. Restore them. */
  div :global(ul), div :global(ol) { margin: 0.25rem 0; padding-left: 1.4rem; }
  div :global(ol) { list-style: decimal; }
  div :global(ul) { list-style: disc; }
  div :global(li) { margin: 0.25rem 0; }
  div :global(li::marker) { color: hsl(var(--muted-foreground)); }
  div :global(h1), div :global(h2), div :global(h3) { margin: 0.5rem 0 0.25rem; font-weight: 600; }
  div :global(a) { color: hsl(var(--primary)); text-decoration: underline; text-underline-offset: 2px; }
  div :global(table) { border-collapse: collapse; margin: 0.5rem 0; font-size: 0.85em; }
  div :global(th), div :global(td) { border: 1px solid hsl(var(--border)); padding: 0.25rem 0.5rem; }
  div :global(blockquote) {
    border-left: 3px solid hsl(var(--border));
    padding-left: 0.75rem;
    color: hsl(var(--muted-foreground));
    margin: 0.5rem 0;
  }
</style>
