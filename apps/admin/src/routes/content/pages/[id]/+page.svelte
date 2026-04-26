<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
  type Module = {
    moduleId: string;
    slug: string;
    displayName: string;
    isDeleted?: boolean;
  };
  type Block = { blockName: string; modules: Module[] };
  const page = data.page as {
    id: string;
    slug: string;
    locale: string;
    title: string;
    status: "draft" | "published";
    templateId: string;
    version: number;
    deletedAt: string | null;
    blocks: Block[];
  };
  const allModules = data.allModules as { id: string; slug: string; displayName: string }[];
  const allTemplates = data.allTemplates as {
    id: string;
    slug: string;
    blocks: { name: string; displayName: string }[];
  }[];

  // Build a working copy of "modules per block" indexed by block name. Start
  // from whatever the template currently exposes (so adding a new block in
  // the template surfaces here) and overlay the page's existing layout.
  const template = allTemplates.find((t) => t.id === page.templateId);
  const slotNames = template?.blocks.map((b) => b.name) ?? [];
  const initial = new Map<string, Module[]>();
  for (const name of slotNames) initial.set(name, []);
  for (const b of page.blocks) initial.set(b.blockName, b.modules.slice());
  let layout = $state(
    [...initial.entries()].map(([blockName, modules]) => ({ blockName, modules })),
  );

  function addModule(blockName: string, moduleId: string): void {
    const m = allModules.find((x) => x.id === moduleId);
    if (!m) return;
    layout = layout.map((b) =>
      b.blockName === blockName
        ? {
            ...b,
            modules: [
              ...b.modules,
              { moduleId: m.id, slug: m.slug, displayName: m.displayName, isDeleted: false },
            ],
          }
        : b,
    );
  }
  function removeAt(blockName: string, idx: number): void {
    layout = layout.map((b) =>
      b.blockName === blockName
        ? { ...b, modules: b.modules.filter((_, i) => i !== idx) }
        : b,
    );
  }
  function moveUp(blockName: string, idx: number): void {
    if (idx === 0) return;
    layout = layout.map((b) => {
      if (b.blockName !== blockName) return b;
      const next = b.modules.slice();
      const tmp = next[idx];
      const above = next[idx - 1];
      if (!tmp || !above) return b;
      next[idx - 1] = tmp;
      next[idx] = above;
      return { ...b, modules: next };
    });
  }
</script>

<nav>
  <a href="/content/pages">← Pages</a>
</nav>

<h1>Page: {page.slug} <small>({page.locale})</small></h1>

{#if page.deletedAt}
  <p class="error">This page is soft-deleted ({page.deletedAt}).</p>
{/if}
{#if form?.error}
  <p class="error">{form.error}</p>
{/if}
{#if form?.ok}
  <p>Saved.</p>
{/if}

<p>
  <a href={`/content/pages/${page.id}/preview`} target="_blank" rel="noopener"
    >Open preview in a new tab →</a
  >
</p>

<h2>Metadata</h2>
<form method="post" action="?/update">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <input type="hidden" name="expectedVersion" value={page.version} />
  <label>
    Title
    <input name="title" type="text" value={page.title} required />
  </label>
  <label>
    Status
    <select name="status">
      <option value="draft" selected={page.status === "draft"}>Draft</option>
      <option value="published" selected={page.status === "published"}>Published</option>
    </select>
  </label>
  <button type="submit">Save metadata</button>
</form>

<h2>Layout</h2>
{#if !template}
  <p class="error">Template not found — this page references a deleted template.</p>
{:else}
  <form method="post" action="?/setModules">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <input type="hidden" name="expectedVersion" value={page.version} />
    {#each layout as block (block.blockName)}
      <fieldset style="margin-bottom: 1rem">
        <legend><strong>{block.blockName}</strong></legend>
        <input
          type="hidden"
          name={`blocks[${block.blockName}]`}
          value={block.modules.map((m) => m.moduleId).join(",")}
        />
        {#if block.modules.length === 0}
          <p><em>(empty)</em></p>
        {:else}
          <ol>
            {#each block.modules as m, idx (`${m.moduleId}-${idx}`)}
              <li>
                {m.slug} — {m.displayName}
                {#if m.isDeleted}
                  <strong class="error">(deleted — will not render; remove or replace)</strong>
                {/if}
                <button type="button" onclick={() => moveUp(block.blockName, idx)}>↑</button>
                <button type="button" onclick={() => removeAt(block.blockName, idx)}>×</button>
              </li>
            {/each}
          </ol>
        {/if}
        <label>
          Add module
          <select onchange={(e) => {
            const target = e.currentTarget as HTMLSelectElement;
            const value = target.value;
            if (value) addModule(block.blockName, value);
            target.value = "";
          }}>
            <option value="">…</option>
            {#each allModules as m (m.id)}
              <option value={m.id}>{m.slug} — {m.displayName}</option>
            {/each}
          </select>
        </label>
      </fieldset>
    {/each}
    <button type="submit">Save layout</button>
  </form>
{/if}

{#if !page.deletedAt}
  <h2>Danger zone</h2>
  <form method="post" action="?/delete">
    <input type="hidden" name="_csrf" value={data.csrfToken} />
    <button type="submit">Soft-delete this page</button>
  </form>
{/if}
