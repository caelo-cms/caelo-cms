<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * v0.2.46 — card for bulk_* tools. The bulk handlers return summary
   * lines like "Updated 12 pages (notFound=0, conflicts on: …)". We
   * surface the key counts as a row of badges so the operator's eye
   * lands on success/failure at a glance.
   */

  import { Layers } from "lucide-svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";

  interface Props {
    name: string;
    content: string;
  }
  let { name, content }: Props = $props();

  // Pull "Updated 12", "Deleted 8", "alreadyDeleted=2", etc. as
  // count badges. Crude but the bulk-op result strings are uniform.
  const counts = $derived.by(() => {
    const out: { label: string; value: string; tone: "ok" | "warn" | "muted" }[] = [];
    const m1 = content.match(/(?:Updated|Deleted|Created)\s+(\d+)/);
    if (m1) out.push({ label: m1[0]?.split(" ")[0] ?? "Done", value: m1[1] ?? "?", tone: "ok" });
    const m2 = content.match(/notFound\s*=\s*(\d+)/);
    if (m2) out.push({ label: "notFound", value: m2[1] ?? "?", tone: "muted" });
    const m3 = content.match(/alreadyDeleted\s*=\s*(\d+)/);
    if (m3) out.push({ label: "alreadyDeleted", value: m3[1] ?? "?", tone: "muted" });
    const m4 = content.match(/(?:conflicts|failed)\s+on:\s*([^.]+)/);
    if (m4) {
      const ids = m4[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      if (ids.length > 0) out.push({ label: "conflicts", value: String(ids.length), tone: "warn" });
    }
    return out;
  });
</script>

<div class="rounded-md border bg-card p-3 text-sm" data-testid="tool-card-bulk">
  <div class="flex items-center gap-2">
    <Badge variant="secondary" class="gap-1">
      <Layers class="size-3" />
      <span>{name}</span>
    </Badge>
  </div>
  <p class="mt-1.5 text-sm">{content}</p>
  {#if counts.length > 0}
    <div class="mt-2 flex flex-wrap gap-1.5">
      {#each counts as c (c.label)}
        <Badge
          variant={c.tone === "warn" ? "destructive" : c.tone === "ok" ? "default" : "outline"}
        >
          {c.label}: {c.value}
        </Badge>
      {/each}
    </div>
  {/if}
</div>
