// SPDX-License-Identifier: MPL-2.0
/** Base path of the section. */
export const SETTINGS_ROOT = "/settings";
export const SETTINGS_GROUPS = [
    {
        id: "site",
        label: "Site",
        description: "What every page is built from, and how search engines see it.",
        icon: "layout",
        entries: [
            {
                href: "/settings/site-defaults",
                label: "Site defaults",
                description: "The layout and template a new page starts with.",
                permission: "roles.manage",
                icon: "sliders",
            },
            {
                href: "/settings/seo",
                label: "SEO & site identity",
                description: "Public site address, language, sitemap and organisation details.",
                permission: "roles.manage",
                icon: "search",
                keywords: ["base url", "language", "sitemap", "json-ld", "google"],
            },
            {
                href: "/settings/layouts",
                label: "Layouts",
                description: "The header, footer and navigation wrapped around every page.",
                permission: "roles.manage",
                icon: "layout",
                keywords: ["header", "footer", "chrome", "navigation"],
                related: [
                    {
                        href: "/settings/layouts/new",
                        label: "New layout",
                        description: "Start a layout from scratch.",
                        permission: "roles.manage",
                    },
                    {
                        href: "/settings/layouts/pending",
                        label: "Layout proposals",
                        description: "Layout changes the AI prepared, waiting for your click.",
                        permission: "roles.manage",
                    },
                ],
            },
            {
                href: "/settings/redirects",
                label: "Redirects",
                description: "Send old addresses to new ones so links and rankings survive.",
                permission: "content.read",
                icon: "arrow-right-left",
                keywords: ["301", "302", "moved"],
            },
            {
                href: "/settings/links",
                label: "Internal links",
                description: "Links between your pages, converted to follow a page when it moves; what could not be.",
                permission: "roles.manage",
                icon: "link",
                keywords: ["broken links", "references", "migration", "href"],
            },
            {
                href: "/settings/media",
                label: "Media",
                description: "Image delivery (CDN copy) and library statistics.",
                permission: "roles.manage",
                icon: "image",
                keywords: ["images", "cdn"],
            },
            {
                href: "/settings/import",
                label: "Site import",
                description: "Bring an existing website over and review each imported page.",
                permission: "settings.write",
                icon: "download",
                keywords: ["migrate", "crawl", "move"],
                related: [
                    {
                        href: "/settings/import/pending",
                        label: "Import proposals",
                        description: "Crawls the AI prepared, waiting for your click.",
                        permission: "settings.write",
                    },
                ],
            },
        ],
    },
    {
        id: "publishing",
        label: "Domains & publishing",
        description: "Your web address, the staging preview, and getting changes live.",
        icon: "globe",
        entries: [
            {
                href: "/settings/domains",
                label: "Domains & SSL",
                description: "Your site's domains, certificates and the staging host.",
                permission: "settings.write",
                icon: "globe",
                keywords: ["staging host", "certificate", "https", "custom domain"],
                related: [
                    {
                        href: "/settings/domains/pending",
                        label: "Domain proposals",
                        description: "Domain changes the AI prepared, waiting for your click.",
                        permission: "settings.write",
                    },
                ],
            },
            {
                href: "/settings/dns",
                label: "DNS records",
                description: "The records your registrar needs, with a live check of each.",
                permission: "settings.write",
                icon: "workflow",
                keywords: ["registrar", "cname", "a record"],
            },
            {
                href: "/settings/staging",
                label: "Staging access",
                description: "Who may open the unpublished staging site, and how.",
                permission: "settings.read",
                icon: "shield-check",
                keywords: ["password", "preview", "crawler", "basic auth"],
            },
            {
                href: "/settings/deployments",
                label: "Deployments",
                description: "Draft, staging and live environments; promote or roll back.",
                permission: "ops.view",
                icon: "rocket",
                keywords: ["publish", "release", "rollback", "production"],
                related: [
                    {
                        href: "/settings/deployments/pending",
                        label: "Deploy proposals",
                        description: "Promotions or rollbacks the AI prepared.",
                        permission: "deploy.trigger",
                    },
                ],
            },
            {
                href: "/settings/quality",
                label: "Quality checks",
                description: "Speed, accessibility and SEO checks that guard every publish.",
                permission: "ops.view",
                icon: "gauge",
                keywords: ["lighthouse", "performance", "accessibility"],
                related: [
                    {
                        href: "/settings/quality/pending",
                        label: "Quality decisions",
                        description: "Findings the AI asked to accept or publish anyway.",
                        permission: "content.write",
                    },
                ],
            },
            {
                href: "/settings/updates",
                label: "Caelo updates",
                description: "The Caelo version you run, what's new, and how to install the newest release.",
                permission: "settings.read",
                icon: "circle-arrow-up",
                keywords: ["upgrade", "version", "release", "release notes", "new version"],
            },
        ],
    },
    {
        id: "ai",
        label: "AI assistant",
        description: "Which AI works on your site, what it knows, and what it may spend.",
        icon: "bot",
        entries: [
            {
                href: "/settings/ai",
                label: "AI provider & models",
                description: "Connect an AI provider and choose the models it uses.",
                permission: "settings.read",
                icon: "bot",
                keywords: ["api key", "model", "translation model", "image model"],
                related: [
                    {
                        href: "/settings/ai/pending",
                        label: "Provider proposals",
                        description: "Provider changes the AI prepared, waiting for your key.",
                        permission: "settings.write",
                    },
                ],
            },
            {
                href: "/settings/costs",
                label: "AI spending",
                description: "What the AI has cost, per day and per task.",
                permission: "settings.read",
                icon: "coins",
                keywords: ["cost", "tokens", "usage", "money"],
            },
            {
                href: "/settings/ai/budgets",
                label: "Spending limits",
                description: "Caps that stop the AI before it spends more than you allow.",
                permission: "settings.read",
                icon: "piggy-bank",
                keywords: ["budget", "cap", "limit"],
            },
            {
                href: "/settings/ai/pricing",
                label: "Model prices",
                description: "The per-model rates used to calculate AI cost.",
                permission: "settings.read",
                icon: "receipt",
                keywords: ["rates", "pricing"],
            },
            {
                href: "/settings/ai/memory",
                label: "Site memory",
                description: "Brand voice and standing instructions the AI reads every time.",
                permission: "settings.read",
                icon: "brain",
                keywords: ["tone", "voice", "instructions"],
                related: [
                    {
                        href: "/settings/ai/memory-proposals",
                        label: "Memory proposals",
                        description: "Things the AI suggested it should remember.",
                        permission: "settings.read",
                    },
                ],
            },
            {
                href: "/settings/skills",
                label: "Skills",
                description: "Know-how the AI applies to specific tasks; approve new ones.",
                permission: "settings.write",
                icon: "sparkles",
            },
            {
                href: "/settings/subagents",
                label: "Background AI runs",
                description: "Helper tasks the AI started, with status, cost and duration.",
                permission: "settings.write",
                icon: "activity",
                keywords: ["subagents", "agents"],
            },
            {
                href: "/settings/mcp",
                label: "External AI tools (MCP)",
                description: "Connect ChatGPT, Claude, Cursor and other AI tools by URL or token, and see which apps are connected.",
                permission: "settings.read",
                icon: "key",
                keywords: ["mcp", "token", "claude code", "chatgpt", "connector", "ide", "agent"],
                related: [
                    {
                        href: "/settings/mcp/remote",
                        label: "Connect by URL: step by step",
                        description: "Setup steps for ChatGPT, claude.ai, Claude Code, Cursor and other AI tools.",
                        permission: "settings.read",
                    },
                    {
                        href: "/settings/mcp/pending",
                        label: "Token proposals",
                        description: "Tokens the AI asked to create or revoke.",
                        permission: "settings.write",
                    },
                ],
            },
        ],
    },
    {
        id: "plugins",
        label: "Plugins",
        description: "Extra features for visitors (forms, comments, a newsletter): turn them on and decide what they may access.",
        icon: "puzzle",
        entries: [
            {
                href: "/settings/plugins",
                label: "Plugins",
                description: "Turn plugins on or off and approve what they may access.",
                permission: "settings.write",
                icon: "puzzle",
                keywords: ["activate", "extensions"],
                related: [
                    {
                        href: "/settings/plugins/pending",
                        label: "Plugin proposals",
                        description: "Plugin changes the AI prepared, waiting for your click.",
                        permission: "settings.write",
                    },
                ],
            },
            {
                href: "/settings/plugins/installations",
                label: "Install external plugins",
                description: "Upload a plugin package and review each access it asks for.",
                permission: "plugins.install",
                icon: "package",
                keywords: ["upload", "grants", "permissions"],
            },
            {
                href: "/settings/email",
                label: "Email delivery",
                description: "The service plugins use to send email.",
                permission: "settings.write",
                icon: "mail",
                keywords: ["smtp", "resend", "ses"],
                related: [
                    {
                        href: "/settings/email/pending",
                        label: "Email proposals",
                        description: "Email setup the AI prepared, waiting for credentials.",
                        permission: "settings.write",
                    },
                ],
            },
        ],
    },
    {
        id: "people",
        label: "People & access",
        description: "Who can sign in to the admin or the public site, and what they may do.",
        icon: "users",
        entries: [
            {
                href: "/settings/users",
                label: "Users",
                description: "Invite people to the admin and assign their roles.",
                permission: "users.manage",
                icon: "users",
                keywords: ["team", "invite", "iap", "operator access"],
                related: [
                    {
                        href: "/settings/users/pending",
                        label: "User proposals",
                        description: "Invitations and role changes the AI prepared.",
                        permission: "roles.manage",
                    },
                ],
            },
            {
                href: "/settings/google-sign-in",
                label: "Google sign-in",
                description: "Only needed for remote MCP (ChatGPT, claude.ai) or users outside your Google organisation (Gmail, other companies).",
                permission: "settings.read",
                icon: "key",
                keywords: [
                    "iap",
                    "oauth client",
                    "gmail",
                    "external users",
                    "you don't have access",
                    "remote mcp",
                ],
            },
            {
                href: "/settings/roles",
                label: "Roles",
                description: "What each role may do; create custom roles.",
                permission: "roles.manage",
                icon: "users-round",
                keywords: ["permissions"],
                related: [
                    {
                        href: "/settings/roles/pending",
                        label: "Role proposals",
                        description: "Role changes the AI prepared, waiting for your click.",
                        permission: "roles.manage",
                    },
                ],
            },
            {
                href: "/settings/auth",
                label: "Visitor accounts",
                description: "Whether visitors can sign up on your site, and how they sign in.",
                permission: "settings.write",
                icon: "lock",
                keywords: ["signup", "login", "oauth", "password"],
                related: [
                    {
                        href: "/settings/auth/pending",
                        label: "Sign-in proposals",
                        description: "Visitor sign-in changes the AI prepared.",
                        permission: "settings.write",
                    },
                ],
            },
        ],
    },
    {
        id: "oversight",
        label: "Approvals & safety",
        description: "Decide what the AI proposed, protect public forms, and trace what happened.",
        icon: "shield",
        entries: [
            {
                href: "/settings/pending",
                label: "Pending approvals",
                description: "Everything the AI prepared that still needs your click.",
                permission: "settings.read",
                icon: "inbox",
                keywords: ["proposals", "queue", "approve"],
                related: [
                    {
                        href: "/settings/tool-approvals/pending",
                        label: "Tool approvals",
                        description: "Single AI actions waiting for approval outside a chat.",
                        permission: "roles.manage",
                    },
                    {
                        href: "/settings/owner-settings/pending",
                        label: "Settings changes",
                        description: "Budget, price and gateway changes an external agent proposed.",
                        permission: "settings.write",
                    },
                    {
                        href: "/settings/snapshots/pending",
                        label: "Undo proposals",
                        description: "Requests to roll the site or a page back to an earlier state.",
                        permission: "roles.manage",
                    },
                    {
                        href: "/settings/templates/pending",
                        label: "Template proposals",
                        description: "Template changes the AI prepared.",
                        permission: "content.write",
                    },
                    {
                        href: "/settings/themes/pending",
                        label: "Theme proposals",
                        description: "Theme changes the AI prepared.",
                        permission: "roles.manage",
                    },
                    {
                        href: "/settings/url_migrations/pending",
                        label: "URL change proposals",
                        description: "Page address moves (with redirects) the AI prepared.",
                        permission: "roles.manage",
                    },
                ],
            },
            {
                href: "/settings/gateway",
                label: "Public form protection",
                description: "Rate limits, spam checks and size limits for visitor submissions.",
                permission: "settings.write",
                icon: "shield",
                keywords: ["gateway", "captcha", "rate limit", "spam", "waf"],
                related: [
                    {
                        href: "/settings/gateway/live",
                        label: "Live traffic",
                        description: "Requests, errors and throttling as they happen.",
                        permission: "settings.write",
                    },
                    {
                        href: "/settings/gateway/pending",
                        label: "Rate-limit proposals",
                        description: "Limit changes the AI prepared.",
                        permission: "settings.write",
                    },
                ],
            },
            {
                href: "/settings/bugs",
                label: "Detected bugs",
                description: "Problems the AI noticed while working, ready to report.",
                permission: "settings.read",
                icon: "bug",
            },
            {
                href: "/settings/ai/telemetry",
                label: "Usage data sharing",
                description: "Opt in to sending anonymous usage data to the Caelo project.",
                permission: "settings.read",
                icon: "radio",
                keywords: ["telemetry", "privacy"],
            },
        ],
    },
];
/**
 * Detail pages: opened from a row or a button on their parent, never from
 * the overview directly. `audit/[requestId]` is opened from a request id —
 * the overview's "Look up a request" form builds that URL.
 */
export const SETTINGS_SUB_PAGES = [
    { route: "/settings/layouts/[id]", parent: "/settings/layouts", permission: "roles.manage" },
    { route: "/settings/import/[runId]", parent: "/settings/import", permission: "settings.write" },
    { route: "/settings/audit/[requestId]", parent: SETTINGS_ROOT, permission: "settings.read" },
];
/** Permission needed for the overview's "Look up a request" form. */
export const AUDIT_LOOKUP_PERMISSION = "settings.read";
/** Every link the overview can show (entries and their related links). */
export function allSettingsLinks() {
    return SETTINGS_GROUPS.flatMap((g) => g.entries.flatMap((e) => [e, ...(e.related ?? [])]));
}
function canSee(perms, permission) {
    return Array.isArray(perms)
        ? perms.includes(permission)
        : perms.has(permission);
}
/**
 * The groups as the viewer may see them: entries whose page they cannot open
 * are dropped, related links likewise, and empty groups disappear.
 *
 * A related link is gated by its own page, not by its parent's: when the
 * parent is hidden but the viewer may open the related page (an editor with
 * `content.write` and the Template proposals queue under the Owner-only
 * approvals inbox), the link is promoted to a row of its own, wearing the
 * parent's icon.
 *
 * @param perms the viewer's effective permissions.
 */
export function visibleSettingsGroups(perms) {
    return SETTINGS_GROUPS.map((g) => ({
        ...g,
        entries: g.entries.flatMap((e) => {
            const related = (e.related ?? []).filter((r) => canSee(perms, r.permission));
            if (canSee(perms, e.permission))
                return [{ ...e, related }];
            return related.map((r) => ({ ...r, icon: e.icon }));
        }),
    })).filter((g) => g.entries.length > 0);
}
/** True when the viewer can open at least one Settings page. */
export function hasAnySettingsAccess(perms) {
    return visibleSettingsGroups(perms).length > 0;
}
/**
 * Case-insensitive filter over label, description and keywords; a related
 * link that matches keeps its entry visible. An empty query returns `groups`.
 */
export function filterSettingsGroups(groups, query) {
    const q = query.trim().toLowerCase();
    if (q === "")
        return [...groups];
    const hit = (l, keywords = []) => [l.label, l.description, ...keywords].some((s) => s.toLowerCase().includes(q));
    return groups
        .map((g) => 
    // Typing a group's name ("plugins") shows the whole group.
    g.label.toLowerCase().includes(q)
        ? { ...g }
        : {
            ...g,
            entries: g.entries.filter((e) => hit(e, e.keywords) || (e.related ?? []).some((r) => hit(r))),
        })
        .filter((g) => g.entries.length > 0);
}
/**
 * Breadcrumb label for one `/settings/...` path prefix, or null when the
 * model does not name it (the shell then falls back to the URL segment).
 */
export function settingsCrumbLabel(path) {
    if (path === SETTINGS_ROOT)
        return "Settings";
    return allSettingsLinks().find((l) => l.href === path)?.label ?? null;
}
