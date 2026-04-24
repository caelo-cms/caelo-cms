<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();
</script>

<nav>
  <a href="/">← Dashboard</a>
</nav>

<h1>Roles</h1>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<h2>Existing roles</h2>
<ul>
  {#each data.roles as role (role.id)}
    <li>
      <strong>{role.name}</strong>
      {#if role.isBuiltin}<em>(built-in)</em>{/if}
      — {role.description}
      <br />
      <small>Permissions: {role.permissions.join(", ") || "(none)"}</small>
      {#if !role.isBuiltin}
        <form method="post" action="?/delete" style="display: inline">
          <input type="hidden" name="roleId" value={role.id} />
          <button type="submit">Delete</button>
        </form>
      {/if}
    </li>
  {/each}
</ul>

<h2>Create a custom role</h2>
<form method="post" action="?/create">
  <label>
    Name (lowercase, digits, _ or -)
    <input name="name" type="text" required pattern="[a-z][a-z0-9_-]*" />
  </label>
  <label>
    Description
    <input name="description" type="text" />
  </label>
  <fieldset>
    <legend>Permissions</legend>
    {#each data.allPermissions as perm (perm)}
      <label style="display: block; font-weight: normal">
        <input type="checkbox" name="permissions" value={perm} />
        <code>{perm}</code>
      </label>
    {/each}
  </fieldset>
  <button type="submit">Create role</button>
</form>
