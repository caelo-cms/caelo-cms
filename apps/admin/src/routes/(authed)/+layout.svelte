<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import AppShell from "$lib/components/AppShell.svelte";
  let { data, children } = $props();
</script>

<AppShell
  permissions={data.permissions}
  csrfToken={data.csrfToken}
  userEmail={data.currentUser?.email ?? null}
>
  {@render children()}
</AppShell>
