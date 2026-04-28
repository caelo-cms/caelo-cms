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
      const s = f["staged"] as { previewUrl?: string };
      toast.success("Staged.", {
        description: s.previewUrl ? `Preview: ${s.previewUrl}` : undefined,
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
