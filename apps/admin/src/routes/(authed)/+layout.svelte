<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { page } from "$app/state";
  import { toast } from "svelte-sonner";
  import AppShell from "$lib/components/AppShell.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";

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
      const s = f["staged"] as { previewUrl?: string; draftPageCount?: number };
      // Run #9 R10 — say what is NOT in the staged build. Staging ships
      // published pages only; a success toast that hides "your 92 draft
      // pages are absent" reads as "everything shipped" and sends the
      // operator to a preview that 404s their work.
      const parts: string[] = [];
      if (s.previewUrl) parts.push(`Preview: ${s.previewUrl}`);
      if (typeof s.draftPageCount === "number" && s.draftPageCount > 0) {
        parts.push(
          `${s.draftPageCount} draft page(s) are NOT in this build — publish them to stage them.`,
        );
      }
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
  >
    {@render children()}
  </AppShell>
{/if}
