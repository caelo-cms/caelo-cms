<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import TypeEditor from "#lib/components/lists/TypeEditor.svelte";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";

  let { data, form } = $props();

  const others = $derived(data.typeLists.filter((l) => l.id !== data.list.id));
  const sharedNote = $derived(
    others.length === 0 && data.typeLocalLists.length === 0
      ? "Only this list uses this type."
      : `Changing it also changes ${[
          others.length > 0
            ? `${others.length} other list${others.length === 1 ? "" : "s"} (${others
                .slice(0, 3)
                .map((l) => l.name)
                .join(", ")}${others.length > 3 ? ", …" : ""})`
            : null,
          data.typeLocalLists.length > 0
            ? `${data.typeLocalLists.length} list${data.typeLocalLists.length === 1 ? "" : "s"} inside sections`
            : null,
        ]
          .filter(Boolean)
          .join(" and ")}.`,
  );
  const ctx: FieldEditorContext = $derived({
    pages: data.pages,
    modules: [],
    vocabularies: data.vocabularies,
    readOnly: !data.canStructure,
  });
</script>

<TypeEditor
  definition={data.listType.definition}
  version={data.listType.version}
  {ctx}
  csrfToken={data.csrfToken}
  form={form as Record<string, unknown> | null}
  {sharedNote}
/>
