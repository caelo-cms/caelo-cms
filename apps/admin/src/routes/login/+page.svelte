<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  let { form } = $props();
</script>

<h1>Sign in</h1>

{#if form?.error}
  <p class="error">{form.error}</p>
{/if}

<form method="post">
  <label>
    Email
    <input name="email" type="email" autocomplete="username" required value={form?.email ?? ""} />
  </label>
  <label>
    Password
    <input name="password" type="password" autocomplete="current-password" required />
  </label>
  <button type="submit">Sign in</button>
</form>
