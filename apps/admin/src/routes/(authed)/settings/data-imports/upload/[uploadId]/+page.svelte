<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /** The upload page an agent's link opens (request_data_upload, docs/data-imports.md). */

  import { Alert, AlertDescription } from "#lib/components/ui/alert/index.js";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";

  let { data, form } = $props();
</script>

<div class="max-w-xl space-y-6">
  <h1 class="text-2xl font-semibold tracking-tight">Upload a file for the AI</h1>

  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {:else if data.status === "ready"}
    <Alert>
      <AlertDescription>
        {data.filename} is uploaded. Go back to the chat and tell the AI it is there.
      </AlertDescription>
    </Alert>
  {:else}
    <Card>
      <CardHeader>
        <CardTitle>Choose the export file</CardTitle>
        <CardDescription>
          A CSV, JSON Lines or JSON file of up to 10 MB. The AI asked for it to import data; the
          file goes straight to Caelo and is kept until {data.expiresAt.slice(0, 10)}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form method="post" enctype="multipart/form-data" class="flex flex-wrap items-center gap-3">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Input id="data-upload-file" type="file" name="file" accept=".csv,.jsonl,.ndjson,.json,.txt" class="max-w-sm" />
          <Button type="submit">Upload</Button>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>
