<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /*
   * #781 — the arrival frame shared by every (auth) route (login, setup,
   * forgot, reset, welcome/*). The person is still a visitor here, so
   * these screens carry the Caelatum sky that the website and the
   * installer's welcome page open with; inside the admin shell the sky
   * never appears. `--sky` is `none` in dark mode, leaving the plain
   * night-blue background. The form itself sits on <AuthPlate>.
   */
  let { children } = $props();
</script>

<div
  class="flex min-h-screen flex-col items-center justify-center bg-background bg-(image:--sky) px-4 py-12"
>
  <div class="w-full max-w-sm">
    <p class="mb-4 text-center text-xs font-semibold uppercase tracking-[0.14em] text-sky-label">
      Caelo admin
    </p>
    {@render children()}
  </div>
</div>
