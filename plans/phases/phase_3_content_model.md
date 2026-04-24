# Phase 3 — Module, Template & Page content model

**Status:** stub — detail to be filled when this phase is picked up.
**Dependencies:** P1, P2.
**Unblocks:** P4, P5, P6.

## Goal (from master plan)
Implement the three content primitives via Query API only: `modules` (HTML+CSS+JS, live-referenced), `templates` (named blocks), `pages` (ordered list of module references — no raw HTML field). Admin UI for CRUD. Enforce at the Validator layer that pages cannot contain raw HTML. Deliverable: manually create a module, a template, assemble a page from modules, render a preview.

## End-to-end verification
Create module + template + page composed of modules; preview renders; raw-HTML-on-page write rejected.

## To be detailed before execution
- Schemas: `modules`, `templates`, `pages`, `page_modules` (ordered junction), `template_blocks`.
- Live reference model: page stores `module_id` only, never a snapshot of module HTML.
- Template named blocks: how the schema enforces "structured blocks, not a blob".
- Admin UI: module editor (HTML/CSS/JS tabs, preview), page composer (drag modules into blocks).
- Zod validator rule: pages have no `html` field — Validator rejects any payload that tries to set one.
- Preview rendering: same Astro renderer as P6 or a simpler server-side render stub?
