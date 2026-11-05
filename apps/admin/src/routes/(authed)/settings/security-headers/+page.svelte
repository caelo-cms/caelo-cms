<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { CSP_SOURCE_KINDS, DENIED_BROWSER_FEATURES, REFERRER_POLICIES } from "@caelo-cms/shared";
  import { enhance } from "$app/forms";
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
  import { Label } from "#lib/components/ui/label/index.js";
  import { Select } from "#lib/components/ui/select/index.js";
  import { Textarea } from "#lib/components/ui/textarea/index.js";

  let { data, form } = $props();

  const kindLabel: Record<string, string> = {
    script: "Scripts",
    style: "Stylesheets",
    img: "Images",
    font: "Fonts",
    connect: "Requests from scripts",
    frame: "Embedded frames",
    media: "Audio and video",
    form: "Form targets",
  };
  const served = $derived([
    { title: "Staging sends", set: data.state?.staged ?? null },
    { title: "The live site sends", set: data.state?.live ?? null },
  ]);
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Security headers</h1>
    <p class="text-sm text-muted-foreground">
      What browsers may load on your site, and who may frame it. Each build works out what its pages
      need; here you decide the rest.
    </p>
  </div>

  {#if data.error}
    <Alert variant="destructive"><AlertDescription>{data.error}</AlertDescription></Alert>
  {/if}
  {#if form?.error}
    <Alert variant="destructive"><AlertDescription>{form.error}</AlertDescription></Alert>
  {/if}
  {#if form?.ok}
    <Alert><AlertDescription>{form.message}</AlertDescription></Alert>
  {/if}

  {#if data.state}
    {@const state = data.state}
    {#if !state.host.served}
      <Alert variant="destructive"><AlertDescription>{state.host.note}</AlertDescription></Alert>
    {/if}
    {#if state.stageNeeded}
      <Alert><AlertDescription>
        These settings are newer than the staged build. Stage to send them on staging, then Publish
        live.
      </AlertDescription></Alert>
    {/if}

    <form method="post" action="?/save" use:enhance class="space-y-6">
      <input type="hidden" name="_csrf" value={data.csrfToken} />
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Content Security Policy</CardTitle>
          <CardDescription>
            Test mode blocks nothing: browsers only report what the policy would stop, and the quality
            check after a Stage shows it. Enforcing makes browsers block it for every visitor.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-1">
            <Label for="cspMode">Mode</Label>
            <Select id="cspMode" name="cspMode" value={state.policy.cspMode}>
              <option value="report_only">Test (report only)</option>
              <option value="enforce">Enforce</option>
            </Select>
          </div>
          {#if state.enforceBlockers.length > 0}
            <Alert variant="destructive">
              <AlertDescription>
                Enforcing would stop these on the staged build:
                <ul class="mt-1 list-disc pl-4">
                  {#each state.enforceBlockers as blocker (blocker)}
                    <li>{blocker}</li>
                  {/each}
                </ul>
              </AlertDescription>
            </Alert>
          {/if}
          <p class="text-xs text-muted-foreground">
            The staged build allows {state.inlineScriptHashes} inline script(s) by hash and these
            sources:
          </p>
          <ul class="space-y-1 text-xs">
            {#each Object.entries(state.derivedOrigins) as [kind, list] (kind)}
              <li><span class="font-medium">{kindLabel[kind] ?? kind}:</span> <code class="font-mono">{list.join(" ")}</code></li>
            {/each}
            {#each state.plugins as plugin (plugin.slug)}
              <li>
                <span class="font-medium">Plugin {plugin.slug}:</span>
                {plugin.origins.length} origin(s), {plugin.inlineScripts} inline script(s)
              </li>
            {/each}
          </ul>
          <div class="grid gap-4 sm:grid-cols-2">
            {#each CSP_SOURCE_KINDS as kind (kind)}
              <div class="space-y-1">
                <Label for={`extra-${kind}`}>Also allow: {kindLabel[kind]}</Label>
                <Textarea
                  id={`extra-${kind}`}
                  name={`extra-${kind}`}
                  rows={2}
                  class="font-mono text-xs"
                  placeholder="https://cdn.example.com"
                  value={(state.policy.extraSources[kind] ?? []).join("\n")}
                />
              </div>
            {/each}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Framing and privacy</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-1">
            <Label for="frameAncestors">Sites that may embed this site in a frame</Label>
            <Textarea
              id="frameAncestors"
              name="frameAncestors"
              rows={2}
              class="font-mono text-xs"
              placeholder="https://partner.example.com"
              value={state.policy.frameAncestors.join("\n")}
            />
            <p class="text-xs text-muted-foreground">
              Empty is safest: no other site can frame yours, which stops clickjacking.
            </p>
          </div>
          <div class="space-y-1">
            <Label for="referrerPolicy">What other sites learn about where a visitor came from</Label>
            <Select id="referrerPolicy" name="referrerPolicy" value={state.policy.referrerPolicy}>
              {#each REFERRER_POLICIES as policy (policy)}
                <option value={policy}>{policy}</option>
              {/each}
            </Select>
          </div>
          <fieldset class="space-y-1">
            <legend class="text-sm font-medium">Browser features your own pages use</legend>
            <p class="text-xs text-muted-foreground">Everything unticked is denied on every page.</p>
            <div class="grid grid-cols-2 gap-1 sm:grid-cols-3">
              {#each DENIED_BROWSER_FEATURES as feature (feature)}
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`feature-${feature}`}
                    checked={state.policy.allowedFeatures.includes(feature)}
                  />
                  {feature}
                </label>
              {/each}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">HTTPS only (HSTS)</CardTitle>
          <CardDescription>
            {state.host.hostSendsHsts
              ? "Your hosting sends this header itself, so these settings have no effect."
              : "Browsers remember this for the whole period, so it cannot be taken back quickly."}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <div class="space-y-1">
            <Label for="hstsMaxAge">Seconds browsers remember it (0 sends no header)</Label>
            <Input
              id="hstsMaxAge"
              name="hstsMaxAge"
              type="number"
              min="0"
              max="63072000"
              value={state.policy.hsts.maxAgeSeconds}
            />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="hstsSubdomains" checked={state.policy.hsts.includeSubdomains} />
            Include every subdomain
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input type="checkbox" name="hstsPreload" checked={state.policy.hsts.preload} />
            Ask browsers to preload it
          </label>
        </CardContent>
      </Card>

      <Button type="submit" disabled={!state.host.served}>Save</Button>
    </form>

    {#each served as view (view.title)}
      <Card data-testid="security-headers-served">
        <CardHeader>
          <CardTitle class="text-base">{view.title}</CardTitle>
        </CardHeader>
        <CardContent>
          {#if view.set}
            <dl class="space-y-2 text-xs">
              {#each Object.entries(view.set.headers) as [name, value] (name)}
                <div>
                  <dt class="font-medium">{name}</dt>
                  <dd class="break-all font-mono">{value}</dd>
                </div>
              {/each}
            </dl>
            {#if view.set.cspCut}
              <p class="mt-2 text-xs text-destructive">
                The full policy did not fit a response header, so parts of it were left out.
              </p>
            {/if}
          {:else}
            <p class="text-sm text-muted-foreground">Nothing yet: this needs a new build.</p>
          {/if}
        </CardContent>
      </Card>
    {/each}
  {/if}
</div>
