# Caelo CMS

AI-first, open-source CMS. **MPL 2.0** licensed.

Product specification: [`CMS_REQUIREMENTS.md`](./CMS_REQUIREMENTS.md)
Implementation plan: [`plans/MASTER_PLAN.md`](./plans/MASTER_PLAN.md)
Engineering principles for contributors: [`CLAUDE.md`](./CLAUDE.md)

## Quickstart (development)

Prerequisites: [Bun](https://bun.sh/) ≥ 1.3.13, Docker, Docker Compose.

```bash
# Install Bun if you do not have it
curl -fsSL https://bun.sh/install | bash

# Install workspace dependencies
bun install

# Start PostgreSQL
docker compose up -d

# Run tests
bun test

# Typecheck all packages
bun run typecheck

# Lint
bun run lint
```

## Workspaces

```
apps/
  admin/              # SvelteKit + svelte-adapter-bun admin panel (P2+)
  api-gateway/        # Bun HTTP gateway fronting the Query API (P1+)
  static-generator/   # Astro static site generator (P6+)
packages/
  shared/             # Zod schemas, shared types
  query-api/          # Typed named operations, Validator, Database Adapter (P1)
  plugin-sdk/         # Plugin SDK surface (P11)
  provisioning/       # Pulumi provisioning (P14+)
  migrations/         # cms_admin + cms_public migrations (P1)
```

## Licence

[Mozilla Public License 2.0](./LICENSE). Every source file carries `SPDX-License-Identifier: MPL-2.0`.
