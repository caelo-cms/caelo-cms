-- SPDX-License-Identifier: MPL-2.0
--
-- 0500 — gateway hardening P1 + P8 (issues #1326, #1338; epic #763).
--
-- 1. published_gateway_settings.live_origins: the origins of the live site
--    (the base URL and every public domain, never the staging host), as the
--    admin publishes them (public-projection.ts `liveSiteOrigins`). The
--    gateway accepts a POST to /api/plugin/* only with an `Origin` from this
--    list. NULL = the admin that published the row predates this column; the
--    gateway then refuses plugin requests with a 503 naming the fix instead
--    of guessing (CLAUDE.md §2 no fallbacks). The migration run republishes
--    the settings, and the admin rolls before the gateway.
--
-- 2. gateway_ip_hash_keys: the keys of the gateway's keyed client-address
--    hashes (#763 L3). An unkeyed SHA-256 of an IPv4 address is reversed by
--    hashing all 2^32 addresses; an HMAC under a key is not. One key per
--    UTC day (`epoch` = days since 1970-01-01), minted by the first gateway
--    instance that needs it (32 random bytes from the gateway, INSERT … ON
--    CONFLICT DO NOTHING, so every instance uses the same key and their
--    rate-limit buckets agree). The gateway's GC deletes a key two days
--    after its day ended: from then on, the hashes stored under it (the
--    rate-limit bucket keys, themselves deleted an hour after they expire)
--    name nobody, whoever reads them. The admin has no use for the keys and
--    gets no policy on the table.
--
-- 3. Batched GC (#763 L4): the gateway deletes its expired rows in batches
--    of a bounded size, each its own short transaction, picked by primary
--    key (`DELETE … WHERE id IN (SELECT id … LIMIT n)`). For the two
--    append-only logs that needs public_role to see the ids of exactly the
--    rows it may already delete; it still reads no payload and no younger
--    row.
--
-- Not a contract migration: both additions are new and nullable; the
-- previous gateway reads neither, the previous admin publishes without the
-- column (NULL).

ALTER TABLE published_gateway_settings ADD COLUMN IF NOT EXISTS live_origins text[] NULL;

CREATE TABLE IF NOT EXISTS gateway_ip_hash_keys (
  epoch      int         PRIMARY KEY CHECK (epoch > 0),
  key        bytea       NOT NULL CHECK (octet_length(key) = 32),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE gateway_ip_hash_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_ip_hash_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gateway_ip_hash_keys_read ON gateway_ip_hash_keys;
CREATE POLICY gateway_ip_hash_keys_read ON gateway_ip_hash_keys
  FOR SELECT TO public_role USING (true);
-- A key may be minted only for the database's today or tomorrow (an
-- instance whose clock runs ahead at midnight), never back-dated: a planted
-- key for a past day would keep that day's hashes reversible. An instance
-- whose clock lags mints for the database's today instead (ip-hash-key.ts).
DROP POLICY IF EXISTS gateway_ip_hash_keys_mint ON gateway_ip_hash_keys;
CREATE POLICY gateway_ip_hash_keys_mint ON gateway_ip_hash_keys
  FOR INSERT TO public_role
  WITH CHECK (epoch BETWEEN floor(extract(epoch FROM now()) / 86400)::int
                        AND floor(extract(epoch FROM now()) / 86400)::int + 1);
-- Only a key whose day ended at least two days ago may be deleted.
DROP POLICY IF EXISTS gateway_ip_hash_keys_gc ON gateway_ip_hash_keys;
CREATE POLICY gateway_ip_hash_keys_gc ON gateway_ip_hash_keys
  FOR DELETE TO public_role
  USING (epoch < floor(extract(epoch FROM now()) / 86400)::int - 2);

GRANT SELECT, INSERT, DELETE ON gateway_ip_hash_keys TO public_role;

DROP POLICY IF EXISTS gateway_request_log_gc_select ON gateway_request_log;
CREATE POLICY gateway_request_log_gc_select ON gateway_request_log
  FOR SELECT TO public_role USING (created_at < now() - interval '90 days');
DROP POLICY IF EXISTS gateway_plugin_op_events_gc_select ON gateway_plugin_op_events;
CREATE POLICY gateway_plugin_op_events_gc_select ON gateway_plugin_op_events
  FOR SELECT TO public_role USING (created_at < now() - interval '30 days');
GRANT SELECT (id) ON gateway_request_log, gateway_plugin_op_events TO public_role;
