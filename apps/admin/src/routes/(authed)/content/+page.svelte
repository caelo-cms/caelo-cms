<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { FileText, History, Layers, Layout, MessageSquare } from "lucide-svelte";
  import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  const tiles = [
    { href: "/content/pages", label: "Pages", desc: "Composed from modules; preview in an iframe", icon: FileText },
    { href: "/content/modules", label: "Modules", desc: "The only place raw HTML lives", icon: Layers },
    { href: "/content/templates", label: "Templates", desc: 'Layout shells with <caelo-slot name="…"> markers', icon: Layout },
    { href: "/content/chat", label: "Chats", desc: "Talk to the AI; Publish merges branch into main", icon: MessageSquare },
    { href: "/content/history", label: "History", desc: "Every site snapshot, with per-entity revert", icon: History },
  ];
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Content</h1>
    <p class="text-sm text-muted-foreground">
      Manage modules, templates, pages, chats, and the snapshot timeline.
    </p>
  </div>

  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
    {#each tiles as tile (tile.href)}
      <a href={tile.href} class="block">
        <Card class="transition-colors hover:bg-accent">
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <tile.icon class="size-4" />
              {tile.label}
            </CardTitle>
            <CardDescription>{tile.desc}</CardDescription>
          </CardHeader>
        </Card>
      </a>
    {/each}
  </div>
</div>
