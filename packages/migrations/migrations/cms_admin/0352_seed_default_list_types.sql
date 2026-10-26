-- SPDX-License-Identifier: MPL-2.0
--
-- 0352 — epic #1107 part B: the list types every install starts with
-- (docs/lists.md §3): texts, links, menu, categories, tags. Seeded as
-- STORED data and edited like any other type afterwards; nothing reads
-- `DEFAULT_LIST_TYPES` at render time (CLAUDE.md §2).
--
-- The JSON between the markers is exactly `DEFAULT_LIST_TYPES`
-- (packages/shared/src/lists/default-types.ts);
-- packages/migrations/src/default-list-types-seed.test.ts fails when the two
-- drift. A type an install already has under the slug is left alone.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

INSERT INTO list_types (slug, definition)
SELECT t->>'slug', t
  FROM jsonb_array_elements(
-- caelo:seed-json-begin
$seed$
[
  {
    "slug": "texts",
    "name": "Texts",
    "purpose": "A flat list of short texts inside one module: feature bullets, chips, steps.",
    "role": "content",
    "root": {
      "allow": [
        "text"
      ]
    },
    "nodes": {
      "text": {
        "label": "Text",
        "fields": [
          {
            "name": "text",
            "label": "Text",
            "type": "text",
            "required": true
          }
        ]
      }
    }
  },
  {
    "slug": "links",
    "name": "Links",
    "purpose": "A flat group of links: legal links, social links, a footer column.",
    "role": "content",
    "root": {
      "allow": [
        "link"
      ]
    },
    "nodes": {
      "link": {
        "label": "Link",
        "fields": [
          {
            "name": "label",
            "label": "Label",
            "type": "text",
            "required": true
          },
          {
            "name": "link",
            "label": "Link",
            "type": "link",
            "required": true
          }
        ],
        "current_from": "link"
      }
    }
  },
  {
    "slug": "menu",
    "name": "Menu",
    "purpose": "Site navigation with up to three levels: header menu, footer menu, mobile menu. Use a custom type for mega menus with columns or teasers.",
    "role": "navigation",
    "root": {
      "allow": [
        "entry"
      ]
    },
    "nodes": {
      "entry": {
        "label": "Menu entry",
        "fields": [
          {
            "name": "label",
            "label": "Label",
            "type": "text",
            "required": true
          },
          {
            "name": "link",
            "label": "Link",
            "type": "link"
          }
        ],
        "children": {
          "name": "children",
          "allow": [
            "entry"
          ]
        },
        "current_from": "link"
      }
    },
    "max_depth": 3
  },
  {
    "slug": "categories",
    "name": "Categories",
    "purpose": "A category tree pages are assigned to: blog sections, product groups, doc areas.",
    "role": "vocabulary",
    "root": {
      "allow": [
        "category"
      ]
    },
    "nodes": {
      "category": {
        "label": "Category",
        "fields": [
          {
            "name": "name",
            "label": "Name",
            "type": "text",
            "required": true
          },
          {
            "name": "slug",
            "label": "Slug",
            "type": "text",
            "required": true
          },
          {
            "name": "description",
            "label": "Description",
            "type": "richtext"
          },
          {
            "name": "landing_page",
            "label": "Landing page",
            "type": "link"
          }
        ],
        "children": {
          "name": "children",
          "allow": [
            "category"
          ]
        },
        "current_from": "landing_page"
      }
    },
    "max_depth": 6
  },
  {
    "slug": "tags",
    "name": "Tags",
    "purpose": "Flat keywords pages are tagged with, for filters, tag clouds and related content.",
    "role": "vocabulary",
    "root": {
      "allow": [
        "tag"
      ]
    },
    "nodes": {
      "tag": {
        "label": "Tag",
        "fields": [
          {
            "name": "name",
            "label": "Name",
            "type": "text",
            "required": true
          },
          {
            "name": "slug",
            "label": "Slug",
            "type": "text",
            "required": true
          },
          {
            "name": "color",
            "label": "Color",
            "type": "text",
            "maxLength": 9
          }
        ]
      }
    }
  }
]
$seed$
-- caelo:seed-json-end
  ::jsonb) AS t
 WHERE NOT EXISTS (
   SELECT 1 FROM list_types lt
    WHERE lt.slug = t->>'slug' AND lt.chat_branch_id IS NULL AND lt.deleted_at IS NULL
 );

COMMIT;
