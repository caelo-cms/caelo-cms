<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { data } = $props();
</script>

<h1>Caelo CMS</h1>

<p>Signed in as <strong>{data.user.email}</strong></p>

<p>
  Roles: <code>{data.user.roles.join(", ")}</code><br />
  Permissions: <code>{data.user.permissions.join(", ")}</code>
</p>

<nav>
  <a href="/security/roles">Manage roles</a>
  <form method="post" action="/logout" style="display: inline">
    <button type="submit">Log out</button>
  </form>
</nav>
