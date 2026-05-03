<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
  import { Activity, ArrowRightLeft, Bot, Coins, Database, Download, FlaskConical, Globe, Image as ImageIcon, Inbox, Key, Layout, Lock, Mail, MessageSquare, Puzzle, Rocket, Search, Settings, Shield, Sparkles, Star, Users, UsersRound } from "lucide-svelte";
  import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card/index.js";

  const tiles = [
    { href: "/security/users", label: "Users", desc: "Create, update, delete admin users", icon: Users },
    { href: "/security/roles", label: "Roles", desc: "Built-in + Owner-defined custom roles", icon: UsersRound },
    { href: "/security/layouts", label: "Layouts", desc: "Site-wide chrome (header / footer / nav)", icon: Layout },
    { href: "/security/site-defaults", label: "Site defaults", desc: "Default layout + template for new pages", icon: Settings },
    { href: "/security/structured", label: "Structured data", desc: "Nav menus, taxonomies, tags, link lists", icon: Database },
    { href: "/security/media", label: "Media", desc: "CDN copy toggle + library stats", icon: ImageIcon },
    { href: "/security/seo", label: "SEO", desc: "Site base URL, sitemap toggle, organization JSON, stale-SEO queue", icon: Search },
    { href: "/security/redirects", label: "Redirects", desc: "301/302 path mappings; auto-emitted to per-provider redirect files", icon: ArrowRightLeft },
    { href: "/security/locales", label: "Locales & URL routing", desc: "Languages + URL strategies; AI proposals queued for Owner approval", icon: Globe },
    { href: "/security/glossary", label: "Glossary", desc: "Per-locale canonical translations; injected into AI Mode 1/2 prompts", icon: Database },
    { href: "/security/style-guide", label: "Style guide", desc: "Per-locale tone/voice; shapes AI translations", icon: Bot },
    { href: "/security/skills", label: "Skills", desc: "AI skill bodies + auto-engagement + AI-proposed skills queue", icon: Sparkles },
    { href: "/security/subagents", label: "Subagent runs", desc: "Spawned subagents with role, status, cost, duration", icon: Sparkles },
    { href: "/security/plugins", label: "Plugins", desc: "Tier 1 (core, signed) + Tier 2 (AI-authored, sandboxed) — approve / disable", icon: Puzzle },
    { href: "/security/plugins/forms", label: "Form submissions", desc: "Visitor form inbox — mark read, archive, view payloads", icon: Inbox },
    { href: "/security/plugins/comments", label: "Comments queue", desc: "Pending visitor comments + AI moderation", icon: MessageSquare },
    { href: "/security/plugins/newsletter", label: "Newsletter", desc: "Draft AI campaigns + queue sends", icon: Mail },
    { href: "/security/plugins/ratings", label: "Ratings", desc: "Per-page rating aggregates + manual refresh", icon: Star },
    { href: "/security/email", label: "Email transport", desc: "Resend / SMTP / SES selection for plugin email sends", icon: Mail },
    { href: "/security/gateway", label: "Gateway", desc: "Public-write hardening: rate-limits, captcha, body cap, request log", icon: Shield },
    { href: "/security/gateway/live", label: "Gateway live", desc: "Real-time rolling analytics — p95, errors, throttled, top ops", icon: Activity },
    { href: "/security/experiments", label: "A/B experiments", desc: "Variant routing per page; client-side stable hash; impressions log", icon: FlaskConical },
    { href: "/security/import", label: "Site import", desc: "Crawl an existing site; stage as draft pages; Owner reviews per page", icon: Download },
    { href: "/security/import/pending", label: "Import proposals", desc: "AI-proposed crawls awaiting Owner approval", icon: Inbox },
    { href: "/security/gateway/pending", label: "Rate-limit proposals", desc: "AI-proposed per-(plugin, op) rate-limit changes — Owner approves", icon: Inbox },
    { href: "/security/auth", label: "Visitor auth", desc: "Signup policy, password length, OAuth providers (P15)", icon: Lock },
    { href: "/security/auth/pending", label: "Auth proposals (queue)", desc: "AI-proposed auth_config changes — Owner approves or rejects", icon: Inbox },
    { href: "/security/ai", label: "AI provider", desc: "Anthropic configuration + active provider", icon: Bot },
    { href: "/security/mcp", label: "MCP tokens", desc: "Bearer tokens for `bunx @caelo-cms/mcp-server` — drive your install from Claude Code / IDE", icon: Key },
    { href: "/security/deployments", label: "Deployments", desc: "Ops view — dev / staging / production + promote", icon: Rocket },
    { href: "/security/dns", label: "DNS records", desc: "Per-(provider, env) DNS records the active stack expects + live resolver checks", icon: Globe },
    { href: "/security/costs", label: "AI cost controls", desc: "Token + spend dashboard", icon: Coins },
  ];
</script>

<div class="space-y-4">
  <div>
    <h1 class="text-2xl font-semibold tracking-tight">Security control panel</h1>
    <p class="text-sm text-muted-foreground">
      Admin-only — fully separate from the AI layer.
    </p>
  </div>
  <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
    {#each tiles as tile (tile.href)}
      <a href={tile.href} class="block">
        <Card class="transition-colors hover:bg-accent">
          <CardHeader>
            <CardTitle class="flex items-center gap-2 text-base">
              <tile.icon class="size-4" />
              {tile.label}
            </CardTitle>
            <CardDescription>{tile.desc}</CardDescription>
          </CardHeader>
        </Card>
      </a>
    {/each}
  </div>
</div>
