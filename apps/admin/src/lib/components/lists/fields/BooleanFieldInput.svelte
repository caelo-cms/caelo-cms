<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /** `boolean` field (epic #1107). */
  interface Props {
    id: string;
    value: unknown;
    disabled: boolean;
    onchange: (v: unknown) => void;
  }
  let { id, value, disabled, onchange }: Props = $props();
</script>

<input
  {id}
  type="checkbox"
  class="size-4"
  checked={value === true}
  {disabled}
  onchange={(e) => onchange((e.currentTarget as HTMLInputElement).checked)}
/>
