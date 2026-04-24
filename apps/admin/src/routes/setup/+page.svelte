<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { form } = $props();
</script>

<h1>Welcome — create the first owner account</h1>

<p>
  This is a one-shot setup. After this account exists, the setup page
  disappears and users are created through the admin panel.
</p>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<form method="post">
  <label>
    Display name
    <input name="displayName" type="text" required value={form?.displayName ?? ""} />
  </label>
  <label>
    Email
    <input name="email" type="email" autocomplete="username" required value={form?.email ?? ""} />
  </label>
  <label>
    Password (min 8 chars)
    <input name="password" type="password" autocomplete="new-password" required minlength="8" />
  </label>
  <button type="submit">Create owner</button>
</form>
