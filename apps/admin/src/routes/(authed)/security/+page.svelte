<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Bot, Coins, Globe, Layout, Rocket, Settings, Users, UsersRound } from "lucide-svelte";
  import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  const tiles = [
    { href: "/security/users", label: "Users", desc: "Create, update, delete admin users", icon: Users },
    { href: "/security/roles", label: "Roles", desc: "Built-in + Owner-defined custom roles", icon: UsersRound },
    { href: "/security/layouts", label: "Layouts", desc: "Site-wide chrome (header / footer / nav)", icon: Layout },
    { href: "/security/site-defaults", label: "Site defaults", desc: "Default layout + template for new pages", icon: Settings },
    { href: "/security/ai", label: "AI provider", desc: "Anthropic configuration + active provider", icon: Bot },
    { href: "/security/deployments", label: "Deployments", desc: "Ops view — dev / staging / production + promote", icon: Rocket },
    { href: "/security/costs", label: "AI cost controls", desc: "Token + spend dashboard", icon: Coins },
    { href: "/security/domains", label: "Domains", desc: "Populated in P9 / P14", icon: Globe },
  ];
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Security control panel</h1>
    <p class="text-sm text-muted-foreground">
      Admin-only — fully separate from the AI layer.
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
