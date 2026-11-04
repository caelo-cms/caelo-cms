// SPDX-License-Identifier: MPL-2.0

import type { PluginCapability } from "./index.js";

/** A plugin capability in the Owner's words. */
export interface PluginCapabilityInfo {
  /** What the permission is called. */
  readonly label: string;
  /** What approving it allows (CMS_REQUIREMENTS §14.5). */
  readonly allows: string;
}

/**
 * Every capability in plain language, for the Owner's approval. A `Record`
 * over the enum, so a new capability does not compile without its text.
 */
export const PLUGIN_CAPABILITY_INFO: Readonly<Record<PluginCapability, PluginCapabilityInfo>> = {
  cms_admin: {
    label: "Site content",
    allows: "Read and change your pages, modules and other content through Caelo's own operations.",
  },
  cms_admin_schema: {
    label: "Private data storage",
    allows:
      "Keep its own tables in the authoring database. Visitors reach only the fields it declares for them.",
  },
  ai_provider: {
    label: "AI calls",
    allows: "Call your AI provider. These calls count towards your AI spend.",
  },
  snapshots: {
    label: "Snapshots",
    allows: "Write to the site's history so its changes can be undone.",
  },
  chat_runner_tools: {
    label: "AI chat tools",
    allows: "Add tools the AI can use in your chats.",
  },
  background_workers: {
    label: "Background jobs",
    allows: "Run scheduled work on its own, without anyone in the admin.",
  },
  change_journal: {
    label: "Change feed",
    allows: "Follow what changes on the site, so it can keep its own data up to date.",
  },
  email: {
    label: "Sending email",
    allows: "Send email through the mail transport you configured.",
  },
  head_contributions: {
    label: "Page head and sitemap",
    allows: "Add metadata to the head of your pages and entries to the sitemap.",
  },
  url_slots: {
    label: "Page addresses",
    allows: "Change the shape of your public page addresses, for example with a language prefix.",
  },
  client_assets: {
    label: "Scripts and styles on your pages",
    allows: "Add JavaScript and CSS files to every public page.",
  },
  list_sources: {
    label: "List data",
    allows: "Provide data that modules show as lists.",
  },
  list_types: {
    label: "List types",
    allows: "Define its own kinds of lists.",
  },
  list_resolve: {
    label: "List rendering",
    allows: "Change which entries a list shows when a page renders.",
  },
  companion_skills: {
    label: "AI instructions",
    allows: "Ship instructions that change how the AI behaves in your chats.",
  },
  font_assets: {
    label: "Font library",
    allows: "Read the fonts in your font library.",
  },
  private_files: {
    label: "Private files",
    allows: "Store files of its own. Visitors cannot reach them.",
  },
  image_generation: {
    label: "Image generation",
    allows: "Generate images with your AI provider. These count towards your AI spend.",
  },
  site_media_read: {
    label: "Media library",
    allows: "Read the files in your media library.",
  },
  content_variants: {
    label: "Content variants",
    allows: "Replace what a page shows, for example with a translation.",
  },
  link_resolve: {
    label: "Internal links",
    allows: "Decide where the internal links on a page lead.",
  },
  consent_provider: {
    label: "Visitor consent",
    allows: "Read what every plugin needs consent for and decide how visitors are asked.",
  },
};
