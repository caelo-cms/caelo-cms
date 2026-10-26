<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /** `number` field (epic #1107), bounded by the type's min / max. */
  import { Input } from "#lib/components/ui/input/index.js";
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

<Input
  {id}
  type="number"
  step="any"
  min={spec.min}
  max={spec.max}
  value={typeof value === "number" ? String(value) : typeof value === "string" ? value : ""}
  required={spec.required}
  {disabled}
  oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value)}
/>
