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
      <CardTitle class="text-base">Available with i18n</CardTitle>
      <CardDescription>
        This panel ships with the internationalisation release. Until then, every page lives at <code
          >/&lt;slug&gt;</code
        > on a single domain.
      </CardDescription>
    </CardHeader>
  </Card>
</div>
