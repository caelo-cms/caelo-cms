<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import AppShell from "#lib/components/AppShell.svelte";
  import CommandPalette from "#lib/components/CommandPalette.svelte";

  let { data, children } = $props();

  /**
   * P6.5.1 #2 — single source of toast feedback for every authenticated
   * route. SvelteKit threads form-action results through `page.form`;
   * we watch the few standard shapes (`error`, `ok`, `published`,
   * `staged`) and surface them as Sonner toasts in addition to the
   * inline `<Alert>` banners individual routes already render. Routes
   * keep working without any per-route `use:enhance`; the toast is a
   * supplementary cue.
   */
  let lastSerialised = $state("");
  $effect(() => {
    const f = page.form as Record<string, unknown> | null | undefined;
    if (!f) return;
    const key = JSON.stringify(f);
    if (key === lastSerialised) return;
    lastSerialised = key;

    if (typeof f["error"] === "string") {
      toast.error(f["error"] as string);
    } else if (f["published"] && typeof f["published"] === "object") {
      toast.success("Published to production.");
    } else if (f["staged"] && typeof f["staged"] === "object") {
      const s = f["staged"] as {
        previewUrl?: string;
        previewLabel?: string;
        draftPageCount?: number;
        draftPageTitles?: string[];
        alsoIncludes?: string[];
        unpublishedLinkWarning?: string | null;
      };
      // Run #9 R10 — say what is NOT in the staged build. Staging ships
      // published pages only; a success toast that hides "your 92 draft
      // pages are absent" reads as "everything shipped" and sends the
      // operator to a preview that 404s their work.
      const parts: string[] = [];
      if (s.previewLabel ?? s.previewUrl) parts.push(`Preview: ${s.previewLabel ?? s.previewUrl}`);
      // Issue #620 — on the shared draft another chat's change to the same
      // module/page ships with this Stage; say whose.
      if (Array.isArray(s.alsoIncludes) && s.alsoIncludes.length > 0) {
        parts.push(`Also staged changes from: ${s.alsoIncludes.join(", ")}.`);
      }
      if (typeof s.draftPageCount === "number" && s.draftPageCount > 0) {
        const titles = Array.isArray(s.draftPageTitles) ? s.draftPageTitles : [];
        const named =
          titles.length > 0
            ? ` (${titles.join(", ")}${s.draftPageCount > titles.length ? ", …" : ""})`
            : "";
        parts.push(
          `${s.draftPageCount} draft page(s) are NOT in this build${named} — set them to published and Stage again to include them.`,
        );
      }
      // #724 — links to pages the build does not contain lead nowhere.
      if (typeof s.unpublishedLinkWarning === "string") parts.push(s.unpublishedLinkWarning);
      toast.success("Staged.", {
        description: parts.length > 0 ? parts.join(" — ") : undefined,
      });
    } else if (typeof f["ok"] === "boolean" && f["ok"] === true) {
      toast.success("Saved.");
    } else if (typeof f["ok"] === "string") {
      toast.success(f["ok"] as string);
    }
  });
</script>

<!-- P6.6b — global Cmd+K command palette + vim-style two-key
     shortcuts. Mounted once for every authenticated route; auto-skips
     when focus is in an editable element. -->
<CommandPalette />

{#if page.url.pathname.startsWith("/edit")}
  <!-- P6.7.2 — /edit is the chrome-less surface: no AppShell, no sidebar,
       no topbar. Auth + CSRF still flow from the layout's server load.
       The route renders its own slim toolbar + iframe + chat overlay. -->
  {@render children()}
{:else}
  <AppShell
    permissions={data.permissions}
    csrfToken={data.csrfToken}
    userEmail={data.currentUser?.email ?? null}
    aiSpend7d={data.aiSpend7d}
  >
    {@render children()}
  </AppShell>
{/if}
