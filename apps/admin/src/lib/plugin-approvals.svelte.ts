// SPDX-License-Identifier: MPL-2.0

/**
 * #1420 — what waits for an Owner's decision on a plugin, one state per tab.
 *
 * The strip, the dashboard, the Updates card, the Publish live button and the
 * approval dialog all read this, so they agree and clear together. It re-reads
 * like every live surface: on the `pending` topic, on focus and after an own
 * action, never on a timer (CLAUDE.md §11.B).
 */

import { coalescedRefresh } from "#lib/components/edit/coalesced-refresh.js";
import { liveFetch, liveHub } from "#lib/live/live-refresh.js";
import { invalidateAll } from "$app/navigation";

/** One permission a release asks for, in the Owner's words. */
export interface CapabilityRequest {
  id: string;
  label: string;
  allows: string;
  authorReason: string | null;
}

/** One area of the manifest that changed. */
export interface ManifestChange {
  area: string;
  added: string[];
  removed: string[];
  changed: string[];
}

/** A plugin stopped until its release is approved. */
export interface ReleaseApproval {
  slug: string;
  version: string;
  manifestDigest: string;
  capabilities: CapabilityRequest[];
  changes: ManifestChange[] | null;
}

/** An installed package waiting for review. */
export interface InstallationReview {
  slug: string;
  version: string;
  isUpdate: boolean;
}

class PluginApprovals {
  releases = $state<ReleaseApproval[]>([]);
  reviews = $state<InstallationReview[]>([]);
  canApprove = $state(false);
  dialogOpen = $state(false);

  /** One read on the wire at a time; a call meanwhile re-reads once after it. */
  refresh = coalescedRefresh(async () => {
    try {
      const r = await liveFetch("/api/plugin-approvals", {
        headers: { accept: "application/json" },
      });
      if (!r.ok) return;
      const body = (await r.json()) as {
        releases: ReleaseApproval[];
        reviews: InstallationReview[];
        canApprove: boolean;
      };
      this.releases = body.releases;
      this.reviews = body.reviews;
      this.canApprove = body.canApprove;
      if (body.releases.length + body.reviews.length === 0) this.dialogOpen = false;
    } catch {
      // A network failure leaves the last state up until the next topic or focus.
    }
  });

  /** Follow the live topic. @returns the stop, for a Svelte `$effect`. */
  connect(): () => void {
    return liveHub.register({ topics: ["pending"], refresh: () => void this.refresh() });
  }

  /**
   * Approve one release, bound to the digest on screen.
   *
   * @returns the outcome's text; a thrown Error carries the server's refusal.
   */
  async approve(release: ReleaseApproval, csrfToken: string): Promise<string> {
    const r = await fetch("/api/plugin-approvals", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
      body: JSON.stringify({ slug: release.slug, manifestDigest: release.manifestDigest }),
    });
    if (!r.ok) {
      const body = (await r.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? `Approving failed (${r.status}).`);
    }
    const { message } = (await r.json()) as { message: string };
    await this.refresh();
    liveHub.publish(["pending"]);
    await invalidateAll();
    return message;
  }
}

export const pluginApprovals = new PluginApprovals();
