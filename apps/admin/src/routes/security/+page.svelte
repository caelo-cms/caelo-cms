<script lang="ts">
  // SPDX-License-Identifier: MPL-2.0
</script>

<nav>
  <a href="/">← Dashboard</a>
</nav>

<h1>Security control panel</h1>

<p>
  Admin-only settings. These sections are fully separate from the AI layer — AI
  cannot read or modify the security control panel.
</p>

<ul>
  <li><a href="/security/users">Users</a> — create, update, delete admin users; assign roles</li>
  <li><a href="/security/roles">Roles</a> — built-in roles + Owner-defined custom roles</li>
  <li><a href="/security/ai">AI provider</a></li>
  <li><a href="/security/domains">Domains</a> <em>(populated in P9 / P14)</em></li>
  <li><a href="/security/costs">AI cost controls</a></li>
  <li><a href="/security/deployments">Deployments</a> — Ops view: dev / staging / production + promote</li>
</ul>
