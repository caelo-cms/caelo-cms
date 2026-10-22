<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { confirmSubmit } from "#lib/confirm.svelte.js";
  import { enhance } from "$app/forms";
  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Badge } from "#lib/components/ui/badge/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import { Label } from "#lib/components/ui/label/index.js";

  let { data, form } = $props();
  /** #970 — the user whose "Change email" field is open. */
  let changingEmailFor = $state<string | null>(null);
  const report = $derived(data.operatorAccess?.status === "ok" ? data.operatorAccess.report : null);

  // A user/role change waits for the Google IAP sync job (up to 90 s, see
  // admin-core user_access.ts). Without visible progress a second click
  // re-submits it — a duplicate create, or a second job run.
  let syncing = $state(false);
  const whileSyncing =
    (reset: boolean): Parameters<typeof enhance>[1] =>
    () => {
      syncing = true;
      return async ({ update }) => {
        try {
          await update({ reset });
        } finally {
          syncing = false;
        }
      };
    };
</script>

<div class="space-y-6">
  <div class="flex flex-wrap items-start justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Users</h1>
      <p class="text-sm text-muted-foreground">Create, update, delete admin users; assign roles.</p>
    </div>
    {#if data.operatorAccess}
      <!-- Google IAP installs: the sync job recomputes who may pass IAP from
           this list (hourly, and after every user/role change). The button
           is the retry path when a run failed. -->
      <form method="post" action="?/resyncOperatorAccess" use:enhance={whileSyncing(false)}>
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <Button type="submit" size="sm" variant="outline" disabled={syncing}>Re-sync Google IAP access</Button>
      </form>
    {/if}
  </div>

  {#if syncing}
    <Alert>
      <AlertDescription>
        Saving{data.operatorAccess ? " and updating Google IAP access — this can take up to a minute and a half" : ""}…
      </AlertDescription>
    </Alert>
  {/if}

  {#if data.operatorAccess?.status === "error"}
    <Alert variant="destructive">
      <AlertDescription>
        Google IAP sync status unavailable: {data.operatorAccess.error} Next step: {data.operatorAccess.nextStep}
      </AlertDescription>
    </Alert>
  {:else if data.operatorAccess?.status === "ok" && data.operatorAccess.run}
    {@const run = data.operatorAccess.run}
    {#if run.state === "failed" || run.state === "cancelled"}
      <Alert variant="destructive" data-testid="operator-access-sync-failed">
        <AlertDescription>
          The last Google IAP sync {run.state === "failed" ? "failed" : "was cancelled"}
          ({run.execution}{run.completedAt ? `, ${run.completedAt}` : ""}). IAP may not match this
          list. <a class="underline" href={run.logsUrl} target="_blank" rel="noreferrer">Read its log</a>,
          fix the cause, then re-sync.
          {#if report?.signInClientProblem}
            <span class="mt-1 block">Google sign-in client: {report.signInClientProblem}</span>
          {/if}
        </AlertDescription>
      </Alert>
    {:else}
      <p class="text-xs text-muted-foreground" data-testid="operator-access-sync-status">
        Google IAP sync: {run.state === "running"
          ? "running now"
          : `in sync as of ${run.completedAt ?? "the last run"}${data.noGoogleAccount.length > 0 ? ", except the users listed below" : ""}`}
        (<a class="underline" href={run.logsUrl} target="_blank" rel="noreferrer">log</a>).
      </p>
    {/if}
  {/if}

  {#if data.noGoogleAccount.length > 0}
    <Alert variant="destructive" data-testid="users-no-google-account">
      <AlertDescription class="space-y-2">
        <p class="font-medium">These users have no Google account and cannot sign in:</p>
        <p class="text-xs">
          Google lets only Google accounts (Gmail or Google Workspace) through the admin's sign-in.
          Change the email to the person's Google account address, or delete the user.
        </p>
        <ul class="space-y-2">
          {#each data.noGoogleAccount as user (user.id)}
            <li class="space-y-2 rounded-md border bg-background p-2" data-testid="users-no-google-account-row">
              <div class="flex flex-wrap items-center gap-2">
                <strong>{user.email}</strong>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={syncing}
                  onclick={() => (changingEmailFor = changingEmailFor === user.id ? null : user.id)}
                >
                  Change email
                </Button>
                {#if !user.isFirstOwner}
                  <form method="post" action="?/delete" use:enhance={whileSyncing(false)}>
                    <input type="hidden" name="_csrf" value={data.csrfToken} />
                    <input type="hidden" name="userId" value={user.id} />
                    <Button type="submit" size="sm" variant="destructive" disabled={syncing}>Delete</Button>
                  </form>
                {/if}
              </div>
              {#if changingEmailFor === user.id}
                <form
                  method="post"
                  action="?/changeEmail"
                  use:enhance={whileSyncing(true)}
                  class="flex flex-wrap items-end gap-2"
                >
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="userId" value={user.id} />
                  <div class="space-y-1">
                    <Label for={`email-${user.id}`} class="text-xs">Google account address</Label>
                    <Input
                      id={`email-${user.id}`}
                      name="email"
                      type="email"
                      required
                      class="h-8 w-72"
                      placeholder="name@gmail.com"
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={syncing}>Save email</Button>
                </form>
              {/if}
            </li>
          {/each}
        </ul>
      </AlertDescription>
    </Alert>
  {/if}

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert>
      <AlertDescription>Saved.{typeof form.ok === "string" ? ` ${form.ok}` : ""}</AlertDescription>
    </Alert>
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
              <form
                method="post"
                action="?/setRoles"
                use:enhance={whileSyncing(false)}
                class="flex flex-wrap items-center gap-3"
              >
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
                <Button type="submit" size="sm" variant="outline" disabled={syncing}>Update roles</Button>
              </form>
              {#if !user.isFirstOwner}
                <form method="post" action="?/delete" use:enhance={whileSyncing(false)} use:confirmSubmit={{ title: `Delete user ${user.email}?`, description: "They lose access to the admin immediately.", confirmLabel: "Delete user" }}>
                  <input type="hidden" name="_csrf" value={data.csrfToken} />
                  <input type="hidden" name="userId" value={user.id} />
                  <Button type="submit" size="sm" variant="destructive" disabled={syncing}>Delete</Button>
                </form>
              {/if}
            </div>
            <form method="post" action="?/resetPassword" class="mt-2 flex flex-wrap items-end gap-2" use:confirmSubmit={{ title: `Set a new password for ${user.email}?`, description: "Their current password stops working immediately.", confirmLabel: "Set password" }}>
              <input type="hidden" name="_csrf" value={data.csrfToken} />
              <input type="hidden" name="userId" value={user.id} />
              <div class="space-y-1">
                <Label for={`pw-${user.id}`} class="text-xs">Set new password</Label>
                <Input
                  id={`pw-${user.id}`}
                  name="newPassword"
                  type="password"
                  autocomplete="new-password"
                  required
                  minlength={10}
                  class="h-8 w-56"
                  placeholder="min 10 chars"
                />
              </div>
              <Button type="submit" size="sm" variant="outline">Reset password</Button>
            </form>
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
      <form method="post" action="?/create" use:enhance={whileSyncing(true)} class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="grid gap-4 md:grid-cols-2">
          <div class="space-y-2">
            <Label for="displayName">Display name</Label>
            <Input id="displayName" name="displayName" type="text" required />
          </div>
          <div class="space-y-2">
            <Label for="email">Email</Label>
            <Input id="email" name="email" type="email" autocomplete="username" required />
            {#if data.operatorAccess}
              <p class="text-xs text-muted-foreground" data-testid="users-create-google-hint">
                Use the person's Google account address (Gmail or Google Workspace): only Google
                accounts can sign in to this admin. Google offers no way to check an address
                before saving, so Caelo checks it with the access sync right after you create the
                user with a role and shows the answer here (a user without a role gets no access, so Google is not asked).
              </p>
            {/if}
          </div>
        </div>
        <div class="space-y-2">
          <Label for="password">Password (min 10 chars)</Label>
          <Input id="password" name="password" type="password" autocomplete="new-password" required minlength={10} />
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
        <Button type="submit" disabled={syncing}>Create user</Button>
        {#if form && "createdWithoutGoogleAccount" in form && form.createdWithoutGoogleAccount}
          <Alert variant="destructive" data-testid="users-created-no-google-account">
            <AlertDescription>
              {form.createdEmail} was created, but Google has no account with that address, so they
              cannot sign in yet. Change the email to their Google account address (above, under
              "These users have no Google account"), or delete the user.
            </AlertDescription>
          </Alert>
        {/if}
      </form>
    </CardContent>
  </Card>
</div>
