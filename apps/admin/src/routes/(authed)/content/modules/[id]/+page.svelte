<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Image as ImageIcon } from "lucide-svelte";
  import { onDestroy, onMount } from "svelte";
  import MediaPicker from "$lib/components/MediaPicker.svelte";
  import { Alert, AlertDescription } from "$lib/components/ui/alert/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Label } from "$lib/components/ui/label/index.js";
  import { Textarea } from "$lib/components/ui/textarea/index.js";

  let { data, form } = $props();
  const module = data.module as {
    id: string;
    slug: string;
    displayName: string;
    html: string;
    css: string;
    js: string;
    deletedAt: string | null;
  };

  let html = $state(module.html);
  let pickerOpen = $state(false);
  let htmlEl: HTMLTextAreaElement | null = $state(null);

  function insertAtCaret(text: string): void {
    const el = htmlEl;
    if (!el) {
      html += text;
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    html = html.slice(0, start) + text + html.slice(end);
    queueMicrotask(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function onMediaPick(m: { url: string; alt: string }): void {
    const altAttr = m.alt ? ` alt="${m.alt.replace(/"/g, "&quot;")}"` : ' alt=""';
    insertAtCaret(`<img src="${m.url}"${altAttr} />`);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // Cmd+M / Ctrl+M opens the picker (when html textarea has focus
    // OR globally on this page).
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m") {
      e.preventDefault();
      pickerOpen = true;
    }
  }

  onMount(() => {
    document.addEventListener("keydown", onKeyDown);
  });
  onDestroy(() => {
    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", onKeyDown);
    }
  });
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">{module.slug}</h1>
    <p class="text-sm text-muted-foreground">
      <a class="underline" href={`/content/modules/${module.id}/history`}>View history ↗</a>
    </p>
  </div>

  {#if module.deletedAt}
    <Alert variant="destructive">
      <AlertDescription>This module is soft-deleted ({module.deletedAt}).</AlertDescription>
    </Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>Saved.</AlertDescription></Alert>
  {/if}

  <Card>
    <CardHeader>
      <CardTitle class="text-base">Edit module</CardTitle>
    </CardHeader>
    <CardContent>
      <form method="post" action="?/update" class="space-y-4">
        <input type="hidden" name="_csrf" value={data.csrfToken} />
        <div class="space-y-2">
          <Label for="displayName">Display name</Label>
          <Input id="displayName" name="displayName" type="text" value={module.displayName} required />
        </div>
        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <Label for="html">HTML</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onclick={() => (pickerOpen = true)}
              title="Insert media (Cmd+M)"
            >
              <ImageIcon class="mr-1 size-3.5" />
              Insert media
            </Button>
          </div>
          <Textarea
            id="html"
            name="html"
            rows={10}
            class="font-mono text-xs"
            value={html}
            oninput={(e) => (html = (e.currentTarget as HTMLTextAreaElement).value)}
            onfocusin={(e) => (htmlEl = e.currentTarget as HTMLTextAreaElement)}
          />
        </div>
        <div class="space-y-2">
          <Label for="css">CSS</Label>
          <Textarea id="css" name="css" rows={6} class="font-mono text-xs" value={module.css} />
        </div>
        <div class="space-y-2">
          <Label for="js">JS</Label>
          <Textarea id="js" name="js" rows={6} class="font-mono text-xs" value={module.js} />
        </div>
        <Button type="submit">Save</Button>
      </form>
    </CardContent>
  </Card>

  <MediaPicker bind:open={pickerOpen} onPick={onMediaPick} />

  {#if !module.deletedAt}
    <Card class="border-destructive/50">
      <CardHeader>
        <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
      </CardHeader>
      <CardContent>
        <form method="post" action="?/delete">
          <input type="hidden" name="_csrf" value={data.csrfToken} />
          <Button type="submit" variant="destructive">Soft-delete this module</Button>
        </form>
      </CardContent>
    </Card>
  {/if}
</div>
