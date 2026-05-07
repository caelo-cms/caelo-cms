<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button-variants.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  let { data } = $props();

  // Map each domain → its dedicated /security/<domain>/pending route.
  // Per-domain pages handle the action shapes (secret-supply for
  // email/ai_providers, password reveal for users/mcp_tokens, etc.).
  const queueRouteFor: Record<string, string> = {
    deploy: "/security/deployments/pending",
    layouts: "/security/layouts/pending",
    users: "/security/users/pending",
    roles: "/security/roles/pending",
    snapshots: "/security/snapshots/pending",
    experiments: "/security/experiments/pending",
    email_config: "/security/email/pending",
    ai_providers: "/security/ai/pending",
    mcp_tokens: "/security/mcp/pending",
    templates: "/security/templates/pending",
    domains: "/security/domains/pending",
    locales: "/security/locales/pending",
    gateway: "/security/gateway",
    site_memory: "/security/ai/memory-proposals",
    skills: "/security/skills",
  };
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Pending proposals</h1>
    <p class="text-sm text-muted-foreground">
      Every AI-proposed action waiting for your click, across every gated domain. Click through
      to the per-domain queue to approve or reject — the secret-supply / password-reveal / blast-
      radius previews live there.
    </p>
  </div>

  {#if data.total === 0}
    <Card>
      <CardContent class="py-12 text-center text-sm text-muted-foreground">
        Nothing pending. AI-proposed actions will land here when they're queued.
      </CardContent>
    </Card>
  {:else}
    <Card>
      <CardHeader>
        <CardTitle class="text-base">
          {data.total} pending across {Object.keys(data.byDomain).length} domain{Object.keys(data.byDomain).length === 1 ? "" : "s"}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div class="flex flex-wrap gap-2">
          {#each Object.entries(data.byDomain) as [domain, count] (domain)}
            <a href={queueRouteFor[domain] ?? "#"} class="contents">
              <Badge variant="secondary">{domain}: {count}</Badge>
            </a>
          {/each}
        </div>
      </CardContent>
    </Card>

    <div class="space-y-2">
      {#each data.items as item (item.proposalId)}
        {@const route = queueRouteFor[item.domain] ?? "#"}
        <Card>
          <CardContent class="flex items-start gap-3 py-3 text-sm">
            <Badge variant="outline" class="shrink-0">{item.domain}.{item.kind}</Badge>
            <div class="min-w-0 flex-1">
              <div class="font-medium">{item.summary}</div>
              <div class="text-xs text-muted-foreground">
                <span class="font-mono">{item.proposalId.slice(0, 8)}</span>
                · {new Date(item.proposedAt).toISOString().slice(0, 19)}Z
                {#if item.chatSessionTitle}
                  · from chat:
                  <a
                    href={`/edit?chat=${item.chatSessionId}`}
                    class="underline underline-offset-2"
                  >
                    {item.chatSessionTitle}
                  </a>
                {/if}
              </div>
            </div>
            <a
              href={route}
              class={`${buttonVariants({ variant: "outline", size: "sm" })} shrink-0`}
            >
              Review
            </a>
          </CardContent>
        </Card>
      {/each}
    </div>
  {/if}
</div>
