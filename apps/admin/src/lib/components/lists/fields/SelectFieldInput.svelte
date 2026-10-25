<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /** `select` field (epic #1107): one of the type's options. */
  import { Select } from "#lib/components/ui/select/index.js";
  import type { FieldInputSpec } from "#lib/lists/field-form.js";

  interface Props {
    id: string;
    spec: FieldInputSpec;
    value: unknown;
    disabled: boolean;
    onchange: (v: unknown) => void;
  }
  let { id, spec, value, disabled, onchange }: Props = $props();
</script>

<Select
  {id}
  value={typeof value === "string" ? value : ""}
  required={spec.required}
  {disabled}
  onchange={(e: Event) => onchange((e.currentTarget as HTMLSelectElement).value || undefined)}
>
  {#if !spec.required}<option value="">—</option>{/if}
  {#each spec.options ?? [] as o (o)}
    <option value={o}>{o.replaceAll("_", " ")}</option>
  {/each}
</Select>
