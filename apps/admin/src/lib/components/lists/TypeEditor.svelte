<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * The editor of one list type (epic #1107): the Structure tab of a list
   * and the list-type page under Types. A type change behaves like any text
   * edit — draft, snapshot, undo, no approval. When the change would delete
   * stored values (a removed kind or field that still has entries), the
   * server refuses and names the lists; the operator then confirms and the
   * change is resent with `dropValues`.
   *
   * Without `content.structure` everything is shown read-only.
   */

  import type { ListTypeDef, NodeDef } from "@caelo-cms/shared";
  import { untrack } from "svelte";
  import { enhance } from "$app/forms";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";
  import type { FieldEditorContext } from "#lib/lists/field-context.js";
  import {
    listTypeIssues,
    newNode,
    removeNode,
    renameNode,
    setNode,
  } from "#lib/lists/type-editor.js";
  import ConflictDialog from "./ConflictDialog.svelte";
  import DropValuesDialog from "./DropValuesDialog.svelte";
  import NodeEditor from "./NodeEditor.svelte";

  interface Props {
    definition: ListTypeDef;
    version: number;
    ctx: FieldEditorContext;
    csrfToken: string;
    /** The page's form result (`conflict`, `dropValuesRequired`). */
    form: Record<string, unknown> | null | undefined;
    /** e.g. "Used by 3 lists: Main menu, Footer, …". */
    sharedNote: string;
  }
  let { definition, version, ctx, csrfToken, form, sharedNote }: Props = $props();

  // Seeded by the version effect below; untracked so editing never re-reads the prop.
  let def = $state<ListTypeDef>(untrack(() => structuredClone(definition)));
  let loadedVersion = $state(0);
  let dirty = $state(false);
  $effect(() => {
    if (version !== loadedVersion) {
      loadedVersion = version;
      def = structuredClone(definition);
      dirty = false;
    }
  });
  const savedKinds = $derived(new Set(Object.keys(definition.nodes)));
  const issues = $derived(listTypeIssues(def));
  const ro = $derived(ctx.readOnly);

  function edit(next: ListTypeDef): void {
    def = next;
    dirty = true;
  }

  let conflict = $state<string | null>(null);
  let dropPrompt = $state<string | null>(null);
  $effect(() => {
    if (typeof form?.conflict === "string") conflict = form.conflict;
    if (typeof form?.dropValuesRequired === "string") dropPrompt = form.dropValuesRequired;
  });

  let formEl = $state<HTMLFormElement | null>(null);
  let dropValues = $state(false);

  function confirmDrop(): void {
    dropPrompt = null;
    dropValues = true;
    formEl?.requestSubmit();
  }
</script>

<ConflictDialog message={conflict} what="This type" onclose={() => (conflict = null)} />
<DropValuesDialog message={dropPrompt} onconfirm={confirmDrop} onclose={() => (dropPrompt = null)} />

<div class="space-y-6" data-testid="type-editor">
  {#if ro}
    <Alert data-testid="structure-readonly">
      <AlertDescription>
        Read-only: changing the structure of lists needs the "content.structure" permission. You can
        still edit the entries.
      </AlertDescription>
    </Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">{def.name}</CardTitle>
      <CardDescription>{sharedNote}</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-4 md:grid-cols-2">
      <div class="space-y-1">
        <Label for="type-name">Name</Label>
        <Input id="type-name" value={def.name} disabled={ro} oninput={(e) => edit({ ...def, name: (e.currentTarget as HTMLInputElement).value })} />
      </div>
      <div class="space-y-1">
        <Label for="type-role">Used for</Label>
        <Select id="type-role" value={def.role} disabled={ro} onchange={(e: Event) => edit({ ...def, role: (e.currentTarget as HTMLSelectElement).value as ListTypeDef["role"] })}>
          <option value="navigation">Navigation (menus)</option>
          <option value="vocabulary">Vocabulary (categories, tags)</option>
          <option value="content">Content (any other list)</option>
        </Select>
      </div>
      <div class="space-y-1 md:col-span-2">
        <Label for="type-purpose">What lists of this type are for</Label>
        <Textarea id="type-purpose" value={def.purpose} disabled={ro} oninput={(e) => edit({ ...def, purpose: (e.currentTarget as HTMLTextAreaElement).value })} />
      </div>
      <fieldset class="space-y-1">
        <legend class="text-sm font-medium">Top level may contain</legend>
        {#each Object.keys(def.nodes) as k (k)}
          <label class="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={def.root.allow.includes(k)}
              disabled={ro}
              onchange={(e) => {
                const on = (e.currentTarget as HTMLInputElement).checked;
                edit({ ...def, root: { ...def.root, allow: on ? [...def.root.allow, k] : def.root.allow.filter((x) => x !== k) } });
              }}
            />
            {def.nodes[k]?.label ?? k}
          </label>
        {/each}
      </fieldset>
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="space-y-1">
          <Label for="type-root-max">Top-level entries at most</Label>
          <Input id="type-root-max" type="number" min={1} placeholder="no limit" value={def.root.max ?? ""} disabled={ro} oninput={(e) => {
            const n = Number((e.currentTarget as HTMLInputElement).value);
            const { max: _m, ...root } = def.root;
            edit({ ...def, root: Number.isInteger(n) && n > 0 ? { ...root, max: n } : root });
          }} />
        </div>
        <div class="space-y-1">
          <Label for="type-depth">Levels at most</Label>
          <Input id="type-depth" type="number" min={1} max={8} placeholder="from the kinds" value={def.max_depth ?? ""} disabled={ro} oninput={(e) => {
            const n = Number((e.currentTarget as HTMLInputElement).value);
            const { max_depth: _d, ...rest } = def;
            edit(Number.isInteger(n) && n >= 1 && n <= 8 ? { ...rest, max_depth: n } : rest);
          }} />
        </div>
      </div>
    </CardContent>
  </Card>

  {#each Object.entries(def.nodes) as [kind, node] (kind)}
    <NodeEditor
      {def}
      {kind}
      {node}
      saved={savedKinds.has(kind)}
      savedFieldNames={new Set((definition.nodes[kind]?.fields ?? []).map((f) => f.name))}
      {ctx}
      onchange={(n: NodeDef) => edit(setNode(def, kind, n))}
      onrename={(to) => { if (to && !def.nodes[to]) edit(renameNode(def, kind, to)); }}
      onremove={() => edit(removeNode(def, kind))}
    />
  {/each}

  {#if !ro}
    <Button type="button" variant="outline" onclick={() => {
      const { kind, node } = newNode(def, "New entry kind");
      edit({ ...def, nodes: { ...def.nodes, [kind]: node } });
    }}>Add entry kind</Button>
  {/if}

  {#if issues.length > 0}
    <Alert variant="destructive" data-testid="type-issues">
      <AlertDescription>
        <ul class="list-disc pl-4">
          {#each issues as i (`${i.path}:${i.message}`)}<li>{i.path ? `${i.path}: ` : ""}{i.message}</li>{/each}
        </ul>
      </AlertDescription>
    </Alert>
  {/if}

  {#if !ro}
    <form
      method="post"
      action="?/saveType"
      bind:this={formEl}
      use:enhance={({ formData }) => {
        formData.set("definition", JSON.stringify(def));
        if (dropValues) formData.set("dropValues", "true");
        dropValues = false;
        return async ({ update }) => {
          await update({ reset: false });
        };
      }}
    >
      <input type="hidden" name="_csrf" value={csrfToken} />
      <input type="hidden" name="expectedVersion" value={version} />
      <Button type="submit" disabled={!dirty || issues.length > 0} data-testid="save-structure">Save structure</Button>
    </form>
  {/if}
</div>
