<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
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

  let { form } = $props();
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
        />
      </div>
      <div class="space-y-2">
        <Label for="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>
      <Button type="submit" class="w-full">Sign in</Button>
    </form>
  </CardContent>
</Card>
