-- SPDX-License-Identifier: MPL-2.0
-- v0.11.3 (issue #76) — populate the `site-default` theme with a
-- working shadcn-like palette so a fresh dogfood install lands on a
-- working theme out of the box (operator sees a real theme on first
-- visit to /design/themes, not an empty placeholder).
--
-- Idempotency guard (CLAUDE.md §2 no-fallbacks): the UPDATE only fires
-- when the row still has the empty tokens jsonb the v0.11.0 migration
-- left it at. A fresh install (tokens = '{}') gets seeded; an install
-- where an operator has already customised the theme (tokens has keys)
-- is untouched — overwriting customised tokens would be a silent data
-- loss.
--
-- jsonb literal mirrors packages/shared/src/theme-presets/shadcn-default.json
-- byte-for-byte (verified by integration test). If the preset evolves,
-- that's a NEW migration — migrations are frozen after landing.

UPDATE themes
SET
  tokens = '{
    "$description": "Caelo''s shadcn-svelte-aligned default. Neutral palette, system font stack, 0.5rem radius, standard spacing scale.",
    "color": {
      "background": { "$type": "color", "$value": "#ffffff" },
      "foreground": { "$type": "color", "$value": "#0a0a0a" },
      "primary": { "$type": "color", "$value": "#171717" },
      "primary-foreground": { "$type": "color", "$value": "#fafafa" },
      "secondary": { "$type": "color", "$value": "#f5f5f5" },
      "secondary-foreground": { "$type": "color", "$value": "#171717" },
      "accent": { "$type": "color", "$value": "#f5f5f5" },
      "accent-foreground": { "$type": "color", "$value": "#171717" },
      "muted": { "$type": "color", "$value": "#f5f5f5" },
      "muted-foreground": { "$type": "color", "$value": "#737373" },
      "card": { "$type": "color", "$value": "#ffffff" },
      "card-foreground": { "$type": "color", "$value": "#0a0a0a" },
      "border": { "$type": "color", "$value": "#e5e5e5" },
      "ring": { "$type": "color", "$value": "#a3a3a3" },
      "destructive": { "$type": "color", "$value": "#dc2626" },
      "destructive-foreground": { "$type": "color", "$value": "#fafafa" }
    },
    "typography": {
      "body": {
        "$type": "typography",
        "$value": {
          "fontFamily": "system-ui, -apple-system, ''Segoe UI'', Roboto, sans-serif",
          "fontSize": "1rem",
          "fontWeight": 400,
          "lineHeight": 1.5
        }
      },
      "heading": {
        "$type": "typography",
        "$value": {
          "fontFamily": "system-ui, -apple-system, ''Segoe UI'', Roboto, sans-serif",
          "fontSize": "1.875rem",
          "fontWeight": 700,
          "lineHeight": 1.2
        }
      },
      "mono": {
        "$type": "typography",
        "$value": {
          "fontFamily": "ui-monospace, SFMono-Regular, ''SF Mono'', Menlo, Consolas, monospace",
          "fontSize": "0.875rem",
          "fontWeight": 400,
          "lineHeight": 1.5
        }
      }
    },
    "spacing": {
      "xs": { "$type": "dimension", "$value": "0.25rem" },
      "sm": { "$type": "dimension", "$value": "0.5rem" },
      "md": { "$type": "dimension", "$value": "1rem" },
      "lg": { "$type": "dimension", "$value": "1.5rem" },
      "xl": { "$type": "dimension", "$value": "2rem" },
      "2xl": { "$type": "dimension", "$value": "3rem" }
    },
    "radius": {
      "sm": { "$type": "dimension", "$value": "0.25rem" },
      "md": { "$type": "dimension", "$value": "0.5rem" },
      "lg": { "$type": "dimension", "$value": "0.75rem" },
      "full": { "$type": "dimension", "$value": "9999px" }
    },
    "shadow": {
      "sm": {
        "$type": "shadow",
        "$value": {
          "color": "rgba(0, 0, 0, 0.05)",
          "offsetX": "0",
          "offsetY": "1px",
          "blur": "2px"
        }
      },
      "md": {
        "$type": "shadow",
        "$value": {
          "color": "rgba(0, 0, 0, 0.1)",
          "offsetX": "0",
          "offsetY": "4px",
          "blur": "6px",
          "spread": "-1px"
        }
      },
      "lg": {
        "$type": "shadow",
        "$value": {
          "color": "rgba(0, 0, 0, 0.1)",
          "offsetX": "0",
          "offsetY": "10px",
          "blur": "15px",
          "spread": "-3px"
        }
      }
    }
  }'::jsonb,
  updated_at = now()
WHERE slug = 'site-default'
  AND tokens = '{}'::jsonb;
