<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /** `text` field (epic #1107). */
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
  type="text"
  value={typeof value === "string" ? value : ""}
  maxlength={spec.maxLength}
  required={spec.required}
  {disabled}
  oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value)}
/>
