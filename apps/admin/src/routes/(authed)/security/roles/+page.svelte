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
    <h1 class="text-2xl font-semibold tracking-tight">Roles</h1>
    <p class="text-sm text-muted-foreground">
      Built-in roles plus Owner-defined custom roles. Routes check permissions, not role names.
    </p>
  </div>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Existing roles</CardTitle>
    </CardHeader>
    <CardContent>
      <ul class="space-y-3">
        {#each data.roles as role (role.id)}
          <li class="rounded-md border p-3 text-sm">
            <div class="flex flex-wrap items-center gap-2">
              <strong>{role.name}</strong>
              {#if role.isBuiltin}<Badge variant="outline">built-in</Badge>{/if}
              <span class="text-muted-foreground">— {role.description}</span>
              {#if !role.isBuiltin}
                <form method="post" action="?/delete" class="ml-auto">
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="roleId" value={role.id} />
                  <Button type="submit" size="sm" variant="destructive">Delete</Button>
                </form>
              {/if}
            </div>
            <p class="mt-1 text-xs text-muted-foreground">
              Permissions: {role.permissions.join(", ") || "(none)"}
            </p>
          </li>
        {/each}
      </ul>
    </CardContent>
  </Card>

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Create a custom role</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/create" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="name">Name</Label>
            <Input id="name" name="name" type="text" required pattern="[a-z][a-z0-9_-]*" />
          </div>
          <div class="space-y-2">
            <Label for="description">Description</Label>
            <Input id="description" name="description" type="text" />
          </div>
        </div>
        <fieldset class="rounded-md border p-3">
          <legend class="px-1 text-sm font-medium">Permissions</legend>
          <div class="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {#each data.allPermissions as perm (perm)}
              <label class="flex items-center gap-2 text-sm">
                <input type="checkbox" name="permissions" value={perm} class="h-4 w-4 rounded border-input" />
                <code>{perm}</code>
              </label>
            {/each}
          </div>
        </fieldset>
        <Button type="submit">Create role</Button>
      </form>
    </CardContent>
  </Card>
</div>
