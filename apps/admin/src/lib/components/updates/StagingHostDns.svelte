<!-- SPDX-License-Identifier: MPL-2.0 -->
<!--
  #1330 — the DNS records the protected staging site needs. The staging host
  is served by the staging gateway behind the staging gate; the update that
  set it up printed these once, this card keeps showing them.
-->
<script lang="ts">
  import type { StagingHostDns } from "@caelo-cms/admin-core";
  import { Card, CardContent, CardHeader, CardTitle } from "#lib/components/ui/card/index.js";

  let { dns }: { dns: StagingHostDns } = $props();
</script>

<Card data-testid="staging-host-dns" data-kind={dns.kind}>
  <CardHeader class="space-y-1">
    <CardTitle class="text-base">Staging site address</CardTitle>
    <p class="text-sm text-muted-foreground">
      Your staging site, <span class="font-mono">{dns.host}</span>, shows staged changes only to
      people who pass the staging access check (Settings → Staging access).
    </p>
  </CardHeader>
  <CardContent class="space-y-2 text-sm">
    {#if dns.kind === "records"}
      {#if dns.active}
        <p>The address points at it and has its certificate. Nothing to do.</p>
      {:else}
        <p>Set these records where your domain's DNS is managed:</p>
      {/if}
      {#if dns.records.length > 0}
        <table class="w-full font-mono text-xs">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th class="pr-4 font-normal">Name</th>
              <th class="pr-4 font-normal">Type</th>
              <th class="font-normal">Value</th>
            </tr>
          </thead>
          <tbody>
            {#each dns.records as r (`${r.name} ${r.type} ${r.value}`)}
              <tr>
                <td class="pr-4">{r.name}</td>
                <td class="pr-4">{r.type}</td>
                <td class="break-all">{r.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if dns.kind === "same-as-site"}
      <p>
        Point <span class="font-mono">{dns.host}</span> at the same address as
        <span class="font-mono">{dns.sameAs}</span> (an A record, or a CNAME to it).
      </p>
    {:else if dns.kind === "unavailable"}
      <p>The records could not be read: {dns.reason}.</p>
    {:else}
      <p>This hosting provider does not serve a protected staging site yet.</p>
    {/if}
  </CardContent>
</Card>
