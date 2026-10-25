<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `icon` field (epic #1107): an icon name. The module maps names to its
   * own sprite or icon font, so the editor offers no gallery — just the
   * name the module understands.
   */
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
  placeholder="e.g. arrow-right"
  pattern={"[a-z0-9\\-]{1,64}"}
  value={typeof value === "string" ? value : ""}
  required={spec.required}
  {disabled}
  oninput={(e) => onchange((e.currentTarget as HTMLInputElement).value)}
/>
