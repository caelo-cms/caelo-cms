<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data, form } = $props();

  // The CSRF token is exposed on the page via locals.user — read it from the
  // ambient +layout load on the server? We'll read via a data field below.
</script>

<nav>
  <a href="/security">← Security</a>
</nav>

<h1>Users</h1>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<h2>Existing users</h2>
<ul>
  {#each data.users as user (user.id)}
    <li>
      <strong>{user.email}</strong> — {user.displayName}
      {#if user.isFirstOwner}<em>(first owner)</em>{/if}
      <br />
      <small>Roles: {user.roles.join(", ") || "(none)"}</small>
      <form method="post" action="?/setRoles" style="display: inline">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <input type="hidden" name="userId" value={user.id} />
        {#each data.roles as roleName (roleName)}
          <label style="display: inline; font-weight: normal">
            <input
              type="checkbox"
              name="roleNames"
              value={roleName}
              checked={user.roles.includes(roleName)}
            />
            {roleName}
          </label>
        {/each}
        <button type="submit">Update roles</button>
      </form>
      {#if !user.isFirstOwner}
        <form method="post" action="?/delete" style="display: inline">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <input type="hidden" name="userId" value={user.id} />
          <button type="submit">Delete</button>
        </form>
      {/if}
    </li>
  {/each}
</ul>

<h2>Create a user</h2>
<form method="post" action="?/create">
  <input type="hidden" name="_csrf" value={data.csrfToken} />
  <label>
    Display name
    <input name="displayName" type="text" required />
  </label>
  <label>
    Email
    <input name="email" type="email" autocomplete="username" required />
  </label>
  <label>
    Password (min 8 chars)
    <input name="password" type="password" autocomplete="new-password" required minlength="8" />
  </label>
  <fieldset>
    <legend>Roles</legend>
    {#each data.roles as roleName (roleName)}
      <label style="display: block; font-weight: normal">
        <input type="checkbox" name="roleNames" value={roleName} />
        {roleName}
      </label>
    {/each}
  </fieldset>
  <button type="submit">Create user</button>
</form>
