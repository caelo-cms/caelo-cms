// SPDX-License-Identifier: MPL-2.0

import type { PluginPanelIcon } from "@caelo-cms/plugin-sdk";
import {
  Activity,
  Bot,
  Bug,
  Coins,
  Gauge,
  Globe,
  Image as ImageIcon,
  Inbox,
  Link2,
  Mail,
  MessageSquare,
  Package,
  Puzzle,
  Radio,
  Receipt,
  Search,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Star,
  Users,
  Workflow,
} from "lucide-svelte";

/**
 * The lucide component of each icon a plugin panel may declare (the
 * SDK's `pluginPanelIcon`, a subset of the admin's settings icons). Typed
 * as a full record so a new SDK icon fails the typecheck until it is mapped.
 */
// biome-ignore lint/suspicious/noExplicitAny: lucide-svelte icon type
export const PANEL_ICONS: Record<PluginPanelIcon, any> = {
  activity: Activity,
  bot: Bot,
  bug: Bug,
  coins: Coins,
  gauge: Gauge,
  globe: Globe,
  image: ImageIcon,
  inbox: Inbox,
  link: Link2,
  mail: Mail,
  "message-square": MessageSquare,
  package: Package,
  puzzle: Puzzle,
  radio: Radio,
  receipt: Receipt,
  search: Search,
  shield: Shield,
  "shield-check": ShieldCheck,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,
  star: Star,
  users: Users,
  workflow: Workflow,
};
