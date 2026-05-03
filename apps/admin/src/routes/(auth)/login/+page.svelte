<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { loginFormSchema } from "@caelo-cms/shared";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { bindZodForm } from "$lib/forms/zod-bind.svelte.js";

  let { form } = $props();

  // P6.6 closing pass — client-side mirror of the login shape. The
  // canonical "invalid credentials" failure still surfaces server-
  // side via form?.error since it depends on the DB.
  const loginForm = bindZodForm(loginFormSchema, { email: form?.email ?? "" });
</script>

<Card>
  <CardHeader>
    <CardTitle>Sign in</CardTitle>
    <CardDescription>Caelo admin</CardDescription>
  </CardHeader>
  <CardContent class="space-y-4">
    {#if form?.error}
      <Alert variant="destructive">
        <AlertDescription>{form.error}</AlertDescription>
      </Alert>
    {/if}
    <form method="post" class="space-y-4">
      <div class="space-y-2">
        <Label for="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autocomplete="username"
          required
          value={form?.email ?? ""}
          aria-invalid={loginForm.errors.email ? "true" : undefined}
          aria-describedby={loginForm.errors.email ? "email-err" : undefined}
          oninput={(e) => loginForm.update("email", (e.currentTarget as HTMLInputElement).value)}
        />
        {#if loginForm.errors.email}
          <p id="email-err" class="text-xs text-destructive">{loginForm.errors.email}</p>
        {/if}
      </div>
      <div class="space-y-2">
        <Label for="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
          aria-invalid={loginForm.errors.password ? "true" : undefined}
          aria-describedby={loginForm.errors.password ? "password-err" : undefined}
          oninput={(e) =>
            loginForm.update("password", (e.currentTarget as HTMLInputElement).value)}
        />
        {#if loginForm.errors.password}
          <p id="password-err" class="text-xs text-destructive">{loginForm.errors.password}</p>
        {/if}
      </div>
      <!-- Submit stays enabled even when client-side validation hasn't
           run yet — Playwright `fill()` doesn't always trigger our
           oninput handler in time, and HTML5 `required` + server-side
           validation are the real safety net. The inline errors below
           each input give live feedback; the button never blocks. -->
      <Button type="submit" class="w-full">Sign in</Button>
    </form>
  </CardContent>
</Card>
