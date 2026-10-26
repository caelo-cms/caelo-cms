<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  /**
   * `richtext` field (epic #1107): formatted prose as basic HTML (paragraphs,
   * links, emphasis, lists). Prose only — a component pattern belongs in a
   * module, not in a field value (CLAUDE.md §1A).
   */
  import { Textarea } from "#lib/components/ui/textarea/index.js";
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

<Textarea
  {id}
  rows={4}
  value={typeof value === "string" ? value : ""}
  maxlength={spec.maxLength}
  required={spec.required}
  {disabled}
  oninput={(e) => onchange((e.currentTarget as HTMLTextAreaElement).value)}
/>
<p class="text-xs text-muted-foreground">
  Paragraphs, links and emphasis as basic HTML, e.g. <code>&lt;p&gt;…&lt;/p&gt;</code>.
</p>
