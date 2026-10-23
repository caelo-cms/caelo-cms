<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Issue #971 — "One-time credentials": the passwords / tokens an approval
   * produced, waiting for the person who clicked Approve. The AI never sees
   * them; its result points the operator here. Each one is generated when
   * the operator clicks Show (or, for a new user, emailed as a set-password
   * link) and shown in this browser once — nothing secret is stored, so a
   * reload cannot bring it back.
   *
   * Rendered in the Live Edit chat (`refreshKey` re-reads after approvals)
   * and on the domain's settings pages (`kind` narrows the list).
   */

  import { KeyRound } from "lucide-svelte";
  import { Button } from "#lib/components/ui/button/index.js";

  type Kind = "user_temporary_password" | "mcp_token";
  interface Handoff {
    id: string;
    kind: Kind;
    label: string;
    expiresAt: string;
  }
  interface Issued {
    id: string;
    label: string;
    secret?: string;
    emailedTo?: string;
  }

  interface Props {
    csrfToken: string;
    kind?: Kind;
    /** Any value; a change re-reads the list (e.g. after an approval applied). */
    refreshKey?: unknown;
  }
  let { csrfToken, kind, refreshKey }: Props = $props();

  let handoffs = $state<Handoff[]>([]);
  let emailAvailable = $state(false);
  let issued = $state<Issued[]>([]);
  let busy = $state<Record<string, boolean>>({});
  let problem = $state<string | null>(null);

  async function load(): Promise<void> {
    try {
      const q = kind ? `?kind=${kind}` : "";
      const res = await fetch(`/settings/credentials${q}`, { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const data = (await res.json()) as { handoffs: Handoff[]; emailAvailable: boolean };
      handoffs = data.handoffs;
      emailAvailable = data.emailAvailable;
    } catch {
      // Best-effort read: a blip keeps the current list.
    }
  }

  $effect(() => {
    void refreshKey;
    void load();
  });

  async function issue(h: Handoff, via: "reveal" | "email"): Promise<void> {
    busy = { ...busy, [h.id]: true };
    problem = null;
    try {
      const res = await fetch("/settings/credentials", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ handoffId: h.id, via }),
      });
      if (!res.ok) {
        problem = (await res.text()) || `Could not issue the credential (${res.status}).`;
        return;
      }
      const data = (await res.json()) as { label: string; secret?: string; emailedTo?: string };
      issued = [...issued, { id: h.id, ...data }];
      handoffs = handoffs.filter((x) => x.id !== h.id);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    } finally {
      busy = { ...busy, [h.id]: false };
    }
  }
</script>

{#if handoffs.length > 0 || issued.length > 0 || problem}
  <section
    class="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm"
    data-testid="credential-handoffs"
  >
    <div class="flex items-center gap-2 font-medium">
      <KeyRound class="size-4" />
      One-time credentials
    </div>
    <p class="text-xs text-muted-foreground">
      Created by an approval you clicked. The AI never sees them. Each is shown here once — copy it
      before you leave this page.
    </p>
    {#each handoffs as h (h.id)}
      <div class="flex flex-wrap items-center gap-2" data-testid="credential-handoff">
        <span class="mr-auto">{h.label}</span>
        <Button
          size="sm"
          disabled={busy[h.id] === true}
          data-testid="credential-handoff-reveal"
          onclick={() => issue(h, "reveal")}>Show once</Button
        >
        {#if h.kind === "user_temporary_password" && emailAvailable}
          <Button
            size="sm"
            variant="outline"
            disabled={busy[h.id] === true}
            data-testid="credential-handoff-email"
            onclick={() => issue(h, "email")}>Email a set-password link</Button
          >
        {/if}
      </div>
    {/each}
    {#each issued as c (c.id)}
      <div class="space-y-1" data-testid="credential-handoff-issued">
        <div>{c.label}</div>
        {#if c.secret}
          <code
            class="block select-all break-all rounded bg-muted px-2 py-1 font-mono text-sm"
            data-testid="credential-handoff-secret">{c.secret}</code
          >
          <div class="text-xs text-muted-foreground">Copy it now — it is not shown again.</div>
        {:else if c.emailedTo}
          <div class="text-xs text-muted-foreground">
            A set-password link went to {c.emailedTo} (valid one hour). If it does not arrive, reset
            the password under Settings → Users.
          </div>
        {/if}
      </div>
    {/each}
    {#if problem}
      <div class="text-xs text-destructive">{problem}</div>
    {/if}
  </section>
{/if}
