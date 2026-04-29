<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Domains &amp; URL strategy</h1>
    <p class="text-sm text-muted-foreground">
      Per-locale URL routing (subdirectory, subdomain, separate domain) and DNS guidance.
    </p>
  </div>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">See <a href="/security/locales" class="underline">Locales &amp; URL routing</a></CardTitle>
      <CardDescription>
        P9 i18n shipped this surface under <code>/security/locales</code>. Per-locale strategy and
        DNS guidance live there.
      </CardDescription>
    </CardHeader>
  </Card>
</div>
