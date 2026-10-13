<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0

  /**
   * #696 Phase 4c — on a self-hosted install, "Install update" is carried
   * out by the update agent on the server. This card shows the Owner why the
   * button is not offered (agent never set up, silent, or reporting a
   * problem) and the one command that sets it up.
   */

  import type { PlatformUpdateAgentStatus } from "@caelo-cms/shared";
  import { Server } from "lucide-svelte";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "#lib/components/ui/card/index.js";
  import CopyLine from "./CopyLine.svelte";

  let {
    agent,
    problem,
    installCommand,
  }: {
    agent: PlatformUpdateAgentStatus | null;
    problem: { error: string; nextStep: string } | null;
    installCommand: string;
  } = $props();

  function when(iso: string): string {
    return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
</script>

<Card data-testid="agent-setup">
  <CardHeader>
    <CardTitle class="flex items-center gap-2 text-base">
      <Server class="size-4" aria-hidden="true" />
      Install updates from here
    </CardTitle>
    <CardDescription>
      On your own server, updates are installed by Caelo's update agent: a small background task on
      the server that checks every minute whether you asked for an update here, verifies the release,
      backs up your database and switches over — going back automatically if the new version fails
      its test.
    </CardDescription>
  </CardHeader>
  <CardContent class="space-y-3 text-sm">
    <p data-testid="agent-state">
      {#if agent === null}
        The update agent is not set up on this server yet.
      {:else if !agent.checkedInRecently}
        The update agent on <strong>{agent.host}</strong> last checked in {when(agent.lastSeenAt)} — it
        is not running now.
      {:else if agent.problem}
        The update agent on <strong>{agent.host}</strong> is running, but it cannot install updates:
        {agent.problem}
      {/if}
    </p>
    {#if agent === null || !agent.checkedInRecently}
      <div class="space-y-1">
        <p>
          To set it up, run this on the server, in the folder that holds <code>.caelo/</code>, as the
          user that runs your Caelo install:
        </p>
        <CopyLine value={installCommand} label="Agent install command" testid="agent-install-command" />
        <p class="text-xs text-muted-foreground">
          It needs a Linux server with systemd. Nothing else on the server changes, and the agent
          never runs as root. Until it runs, use the upgrade command below.
        </p>
      </div>
    {:else if problem}
      <p class="text-muted-foreground">{problem.nextStep}</p>
    {/if}
  </CardContent>
</Card>
