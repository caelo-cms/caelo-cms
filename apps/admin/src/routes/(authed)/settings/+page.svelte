<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * Settings overview (issue #684). Groups, rows and permissions come from
   * `#lib/settings-nav.ts`; this file only renders them. Adding a Settings
   * page means adding it to that model — its test fails otherwise.
   */

  import { goto } from "$app/navigation";
  import {
    Activity,
    ArrowRightLeft,
    Bot,
    Brain,
    Bug,
    ChevronRight,
    CircleArrowUp,
    Coins,
    Database,
    Download,
    Gauge,
    Globe,
    Image as ImageIcon,
    Inbox,
    Key,
    Layout,
    Link2,
    Lock,
    Mail,
    MessageSquare,
    Package,
    PiggyBank,
    Puzzle,
    Radio,
    Receipt,
    Rocket,
    Search,
    Shield,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    Star,
    Users,
    UsersRound,
    Workflow,
  } from "lucide-svelte";
  import EmptyStatePlaceholder from "#lib/components/EmptyStatePlaceholder.svelte";
  import { Button } from "#lib/components/ui/button/index.js";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
  } from "#lib/components/ui/card/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import {
    AUDIT_LOOKUP_PERMISSION,
    filterSettingsGroups,
    type SettingsIcon,
    visibleSettingsGroups,
  } from "#lib/settings-nav.js";

  let { data } = $props();

  // biome-ignore lint/suspicious/noExplicitAny: lucide-svelte icon type
  const ICONS: Record<SettingsIcon, any> = {
    activity: Activity,
    "arrow-right-left": ArrowRightLeft,
    bot: Bot,
    brain: Brain,
    bug: Bug,
    "circle-arrow-up": CircleArrowUp,
    coins: Coins,
    database: Database,
    download: Download,
    gauge: Gauge,
    globe: Globe,
    image: ImageIcon,
    inbox: Inbox,
    key: Key,
    layout: Layout,
    link: Link2,
    lock: Lock,
    mail: Mail,
    "message-square": MessageSquare,
    package: Package,
    "piggy-bank": PiggyBank,
    puzzle: Puzzle,
    radio: Radio,
    receipt: Receipt,
    rocket: Rocket,
    search: Search,
    shield: Shield,
    "shield-check": ShieldCheck,
    sliders: SlidersHorizontal,
    sparkles: Sparkles,
    star: Star,
    users: Users,
    "users-round": UsersRound,
    workflow: Workflow,
  };

  let query = $state("");
  let requestId = $state("");

  const groups = $derived(visibleSettingsGroups(data.permissions));
  const shown = $derived(filterSettingsGroups(groups, query));
  const canLookUpAudit = $derived(data.permissions.includes(AUDIT_LOOKUP_PERMISSION));

  function openAudit(e: SubmitEvent) {
    e.preventDefault();
    const id = requestId.trim();
    if (id) void goto(`/settings/audit/${encodeURIComponent(id)}`);
  }
</script>

<div class="space-y-6">
  <div class="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      <p class="max-w-2xl text-sm text-muted-foreground">
        Everything about your site that isn't a page — domains, the AI, plugins and who has
        access. Most of it you can also just ask for in the chat; the AI prepares the change and
        you approve it.
      </p>
    </div>
    <div class="relative w-full md:w-72">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        type="search"
        placeholder="Find a setting…"
        aria-label="Find a setting"
        class="pl-8"
        bind:value={query}
        data-testid="settings-filter"
      />
    </div>
  </div>

  {#if query.trim() === "" && groups.length > 1}
    <nav aria-label="Settings groups" class="flex flex-wrap gap-2">
      {#each groups as group (group.id)}
        {@const GroupIcon = ICONS[group.icon]}
        <a
          href={`#${group.id}`}
          class="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground motion-reduce:transition-none"
        >
          <GroupIcon class="size-3.5" aria-hidden="true" />
          {group.label}
        </a>
      {/each}
    </nav>
  {/if}

  {#if shown.length === 0}
    <EmptyStatePlaceholder
      icon={Search}
      title={`No setting matches “${query.trim()}”`}
      description="Try another word — or describe what you want in the chat and the AI finds the right place."
    />
  {:else}
    <div class="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
      {#each shown as group (group.id)}
        {@const GroupIcon = ICONS[group.icon]}
        <section id={group.id} class="scroll-mt-20" data-testid={`settings-group-${group.id}`}>
          <Card>
            <CardHeader class="flex flex-row items-start gap-3 space-y-0">
              <span
                class="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary"
                aria-hidden="true"
              >
                <GroupIcon class="size-5" />
              </span>
              <div class="space-y-1">
                <h2 class="text-base font-semibold leading-none tracking-tight">
                  {group.label}
                </h2>
                <CardDescription>{group.description}</CardDescription>
              </div>
            </CardHeader>
            <CardContent class="pt-0">
              <ul class="divide-y">
                {#each group.entries as entry (entry.href)}
                  {@const EntryIcon = ICONS[entry.icon]}
                  <li class="py-1" data-testid="settings-entry" data-href={entry.href}>
                    <a
                      href={entry.href}
                      class="group -mx-2 flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-accent motion-reduce:transition-none"
                    >
                      <EntryIcon
                        class="mt-0.5 size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                        aria-hidden="true"
                      />
                      <span class="min-w-0 flex-1">
                        <span class="block text-sm font-medium">{entry.label}</span>
                        <span class="block text-sm text-muted-foreground">{entry.description}</span>
                      </span>
                      <ChevronRight
                        class="mt-0.5 size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
                        aria-hidden="true"
                      />
                    </a>
                    {#if entry.related && entry.related.length > 0}
                      <ul
                        class="mb-1 ml-7 flex flex-wrap gap-x-3 gap-y-1 text-xs"
                        aria-label={`More for ${entry.label}`}
                      >
                        {#each entry.related as link (link.href)}
                          <li>
                            <a
                              href={link.href}
                              title={link.description}
                              class="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                              data-testid="settings-related"
                            >
                              {link.label}
                            </a>
                          </li>
                        {/each}
                      </ul>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#if group.id === "oversight" && canLookUpAudit}
                <form
                  class="mt-3 flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-center"
                  onsubmit={openAudit}
                  aria-label="Look up a request"
                >
                  <label for="audit-request-id" class="text-sm font-medium sm:w-40 sm:shrink-0">
                    Look up a request
                  </label>
                  <Input
                    id="audit-request-id"
                    placeholder="Request id"
                    title="The request id shown in an error or an MCP reply"
                    class="font-mono text-xs"
                    bind:value={requestId}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    disabled={requestId.trim() === ""}
                  >
                    Open
                  </Button>
                </form>
              {/if}
            </CardContent>
          </Card>
        </section>
      {/each}
    </div>
  {/if}
</div>
