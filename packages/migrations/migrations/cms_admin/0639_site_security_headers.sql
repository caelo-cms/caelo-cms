-- SPDX-License-Identifier: MPL-2.0
--
-- 0639 — the site's response-header policy (#1454).
--
-- A stored default, written here so every install has one and the build
-- finds a row to read (no fallback at read time). The full CSP starts
-- report-only: an update must not be able to take a site's scripts down, and
-- switching to enforcing is the Owner's decision. Keep this in step with
-- DEFAULT_SITE_SECURITY_POLICY (@caelo-cms/shared site-security-headers.ts);
-- site-security-headers-default.test.ts pins it.

ALTER TABLE site_settings
  ADD COLUMN IF NOT EXISTS security_headers jsonb NOT NULL DEFAULT '{
    "cspMode": "report_only",
    "frameAncestors": [],
    "referrerPolicy": "strict-origin-when-cross-origin",
    "allowedFeatures": [],
    "hsts": { "maxAgeSeconds": 31536000, "includeSubdomains": false, "preload": false },
    "extraSources": {}
  }'::jsonb;

-- One more action behind the owner-settings §11.A gate.
ALTER TABLE owner_settings_pending_actions
  DROP CONSTRAINT IF EXISTS owner_settings_pending_actions_kind_check;
ALTER TABLE owner_settings_pending_actions
  ADD CONSTRAINT owner_settings_pending_actions_kind_check
  CHECK (kind IN (
    'set_ai_budget',
    'set_ai_pricing',
    'set_gateway_settings',
    'set_translation_model',
    'set_plugin_ai_cost_cap',
    'rotate_gateway_cookie_secret',
    'set_staging_access',
    'rotate_staging_credentials',
    'set_staging_host',
    'set_mail_caps',
    'set_security_headers'
  ));
