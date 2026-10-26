<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /** Title + top-level tabs of *Content → Menus & lists* (epic #1107). */

  import LinkTabs from "./LinkTabs.svelte";

  interface Props {
    active: "lists" | "types";
    description: string;
  }
  let { active, description }: Props = $props();
</script>

<div class="flex flex-wrap items-end justify-between gap-3">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Menus &amp; lists</h1>
    <p class="text-sm text-muted-foreground">{description}</p>
  </div>
  <LinkTabs
    label="Menus and lists"
    tabs={[
      { href: "/content/lists", label: "Lists", active: active === "lists" },
      { href: "/content/lists/types", label: "Types", active: active === "types" },
    ]}
  />
</div>
