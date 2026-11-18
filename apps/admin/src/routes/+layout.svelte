<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import "../app.css";
  import { beforeNavigate, invalidate } from "$app/navigation";
  import { updated } from "$app/state";
  import NavigationProgress from "#lib/components/NavigationProgress.svelte";
  import SubmitLoadingObserver from "#lib/components/SubmitLoadingObserver.svelte";
  import { Toaster } from "#lib/components/ui/sonner/index.js";
  import { CSRF_DEPENDENCY, fetchFreshCsrfToken, keepCsrfTokenFresh } from "#lib/csrf-refresh.js";
  import { fullLoadTarget } from "#lib/version-skew.js";
  let { children, data } = $props();

  // #1656 — once a newer release is deployed, this tab's components may not
  // read the server's page data any more: load the target fully instead.
  beforeNavigate((navigation) => {
    const target = fullLoadTarget(updated.current, navigation, location.origin);
    if (target !== null) location.href = target;
  });

  // Renew the CSRF form token before it expires in a long-lived tab; every
  // new token restarts the countdown. `invalidate(…, true)` keeps
  // `page.state` (shallow routing) as it is.
  $effect(() => {
    if (data.csrfToken === "") return;
    return keepCsrfTokenFresh(data.csrfRefreshAfterMs, () =>
      fetchFreshCsrfToken(fetch, () => invalidate(CSRF_DEPENDENCY, true)),
    );
  });
</script>

<NavigationProgress />
{@render children()}
<Toaster />
<SubmitLoadingObserver />
