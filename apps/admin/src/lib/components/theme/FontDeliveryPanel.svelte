<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * Font delivery — what visitors download for each pinned font file of
   * the theme, and the per-axis override (themes.update_tokens fontAxes).
   *
   * Shown under the Typography tab. Each variable axis can follow the
   * default (weight range the site uses; other axes fixed at the font's
   * default), keep the full range, be limited to a range, or be fixed to
   * one value. The override belongs to the font file, so it applies to
   * every role using it.
   */
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import type { FontDeliveryReport } from "./font-delivery-report.js";

  interface Props {
    report: { ok: true; value: FontDeliveryReport } | { ok: false; error: string };
    csrfToken: string;
    themeSlug: string;
  }
  let { report, csrfToken, themeSlug }: Props = $props();

  type Face = FontDeliveryReport["faces"][number];
  type Mode = "default" | "full" | "range" | "pin";

  const AXIS_NAMES: Record<string, string> = {
    wght: "Weight",
    opsz: "Optical size",
    wdth: "Width",
    slnt: "Slant",
    ital: "Italic",
  };

  function initialMode(face: Face, tag: string): Mode {
    const setting = face.override?.[tag];
    if (setting === undefined) return "default";
    if (setting === "full") return "full";
    return typeof setting === "number" ? "pin" : "range";
  }

  function describe(face: Face, tag: string): string {
    const e = face.effective[tag];
    if (e === undefined) return "";
    const what =
      e.mode === "pin" ? `fixed at ${e.value}` : e.mode === "full" ? `full ${e.min}–${e.max}` : `${e.min}–${e.max}`;
    return `${what} (${face.origin[tag] === "override" ? "your setting" : "default"})`;
  }

  function kb(bytes: number): string {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  let modes = $state<Record<string, Mode>>({});
  $effect(() => {
    if (!report.ok) return;
    const next: Record<string, Mode> = {};
    for (const face of report.value.faces) {
      for (const tag of Object.keys(face.sourceAxes)) next[`${face.sha256}:${tag}`] = initialMode(face, tag);
    }
    modes = next;
  });
</script>

<section class="mt-6 space-y-3 rounded-md border p-4" aria-labelledby="font-delivery-heading">
  <div>
    <h3 id="font-delivery-heading" class="text-sm font-medium">Font delivery</h3>
    <p class="text-xs text-muted-foreground">
      What visitors download for each font file. By default only the weights your site uses are
      delivered and other variable axes are fixed at the font's default, which keeps pages fast.
      Fixing the optical size makes large headings use the text design of the font.
    </p>
  </div>
  {#if !report.ok}
    <p role="alert" class="text-sm text-destructive">{report.error}</p>
  {:else if report.value.faces.length === 0}
    <p class="text-xs text-muted-foreground">No font file is assigned to this theme. Assign one in Fonts.</p>
  {:else}
    {#if report.value.weightUsage.weights === null}
      <p class="text-xs text-muted-foreground">
        The weights your site uses could not be determined with certainty, so every weight is kept
        ({report.value.weightUsage.uncertain[0] ?? "unknown"}).
      </p>
    {/if}
    {#each report.value.faces as face (face.sha256)}
      <form method="post" action="?/setFontAxes" class="space-y-3 rounded-md border p-3">
        <input type="hidden" name="_csrf" value={csrfToken} />
        <input type="hidden" name="themeSlug" value={themeSlug} />
        <input type="hidden" name="role" value={face.roles[0]?.role ?? ""} />
        <div class="flex flex-wrap items-baseline gap-2">
          <p class="text-sm font-medium">{face.family}</p>
          <p class="text-xs text-muted-foreground">
            Used by {face.roles.map((r) => r.role).join(", ")} · font-weight {face.fontWeightDescriptor}
            {#if face.delivered}· {kb(face.delivered.totalBytes)} in {face.delivered.slices.length} files{/if}
          </p>
        </div>
        {#if face.error}<p role="alert" class="text-sm text-destructive">{face.error}</p>{/if}
        {#if face.locked}
          <p class="text-xs text-muted-foreground">The font's license forbids modifying this file; it is delivered complete.</p>
        {:else if Object.keys(face.sourceAxes).length === 0}
          <p class="text-xs text-muted-foreground">Not a variable font: there are no axes to limit.</p>
        {:else}
          {#each Object.entries(face.sourceAxes) as [tag, axis] (tag)}
            {@const key = `${face.sha256}:${tag}`}
            {@const setting = face.override?.[tag]}
            <div class="grid grid-cols-1 items-end gap-2 sm:grid-cols-4">
              <div class="grid gap-1">
                <Label for={`mode-${key}`} class="text-xs">{AXIS_NAMES[tag] ?? tag} ({axis.min}–{axis.max})</Label>
                <select
                  id={`mode-${key}`}
                  name={`mode_${tag}`}
                  class="rounded border bg-background p-2 text-xs"
                  bind:value={modes[key]}
                >
                  <option value="default">Default</option>
                  <option value="full">Keep full range</option>
                  <option value="range">Limit to a range</option>
                  <option value="pin">Fix to one value</option>
                </select>
              </div>
              {#if modes[key] === "range"}
                <Input aria-label={`${tag} minimum`} name={`min_${tag}`} type="number" step="any" min={axis.min} max={axis.max} value={typeof setting === "object" ? setting.min : axis.min} class="text-xs" />
                <Input aria-label={`${tag} maximum`} name={`max_${tag}`} type="number" step="any" min={axis.min} max={axis.max} value={typeof setting === "object" ? setting.max : axis.max} class="text-xs" />
              {:else if modes[key] === "pin"}
                <Input aria-label={`${tag} value`} name={`value_${tag}`} type="number" step="any" min={axis.min} max={axis.max} value={typeof setting === "number" ? setting : axis.default} class="text-xs" />
              {/if}
              <p class="text-xs text-muted-foreground sm:col-span-4">Now: {describe(face, tag)}</p>
            </div>
          {/each}
          <div class="flex justify-end">
            <Button type="submit" variant="outline">Save delivery for {face.family}</Button>
          </div>
        {/if}
      </form>
    {/each}
  {/if}
</section>
