<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";

  let { data, form } = $props();
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Users</h1>
    <p class="text-sm text-muted-foreground">Create, update, delete admin users; assign roles.</p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing users</CardTitle>
    </CardHeader>
    <CardContent>
      <ul class="space-y-3">
        {#each data.users as user (user.id)}
          <li class="rounded-md border p-3 text-sm">
            <div class="flex items-center gap-2">
              <strong>{user.email}</strong>
              <span class="text-muted-foreground">— {user.displayName}</span>
              {#if user.isFirstOwner}<Badge variant="outline">first owner</Badge>{/if}
            </div>
            <p class="mt-1 text-xs text-muted-foreground">
              Roles: {user.roles.join(", ") || "(none)"}
            </p>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <form method="post" action="?/setRoles" class="flex flex-wrap items-center gap-3">
                <input type="hidden" name="_csrf" value={data.csrfToken} />
                <input type="hidden" name="userId" value={user.id} />
                {#each data.roles as roleName (roleName)}
                  <label class="inline-flex items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      name="roleNames"
                      value={roleName}
                      checked={user.roles.includes(roleName)}
                      class="h-4 w-4 rounded border-input"
                    />
                    {roleName}
                  </label>
                {/each}
                <Button type="submit" size="sm" variant="outline">Update roles</Button>
              </form>
              {#if !user.isFirstOwner}
                <form method="post" action="?/delete">
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="userId" value={user.id} />
                  <Button type="submit" size="sm" variant="destructive">Delete</Button>
                </form>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Create a user</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/create" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="displayName">Display name</Label>
            <Input id="displayName" name="displayName" type="text" required />
          </div>
          <div class="space-y-2">
            <Label for="email">Email</Label>
            <Input id="email" name="email" type="email" autocomplete="username" required />
          </div>
        </div>
        <div class="space-y-2">
          <Label for="password">Password (min 8 chars)</Label>
          <Input id="password" name="password" type="password" autocomplete="new-password" required minlength={8} />
        </div>
        <fieldset class="rounded-md border p-3">
          <legend class="px-1 text-sm font-medium">Roles</legend>
          <div class="space-y-1">
            {#each data.roles as roleName (roleName)}
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" name="roleNames" value={roleName} class="h-4 w-4 rounded border-input" />
                {roleName}
              </label>
            {/each}
          </div>
        </fieldset>
        <Button type="submit">Create user</Button>
      </form>
    </CardContent>
  </Card>
</div>
