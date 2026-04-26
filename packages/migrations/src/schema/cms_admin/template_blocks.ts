// SPDX-License-Identifier: MPL-2.0

import { integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { templates } from "./templates.js";

/**
 * Slot inventory per template. Each row matches a `<caelo-slot name="…">`
 * marker in the template's HTML. The composer UI lists blocks in `position`
 * order; the page composer references blocks by `name`.
 */
export const templateBlocks = pgTable(
  "template_blocks",
  {
    templateId: uuid("template_id")
      .notNull()
      .references(() => templates.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [primaryKey({ columns: [t.templateId, t.name] })],
);
