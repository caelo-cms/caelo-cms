-- SPDX-License-Identifier: MPL-2.0
--
-- 0337 — issue #971: a credential an approved proposal produces never
-- reaches the AI.
--
-- Before, `users.execute_proposal` returned the new user's temporary
-- password and `mcp_tokens.execute_proposal` the new bearer token. The
-- in-chat approval gate hands an executor's output to the model as the
-- tool result, so the AI read the credential and offered to repeat it;
-- over remote MCP that is a third-party AI provider.
--
-- Now the executor creates the user / token WITHOUT a usable credential
-- (its random password / token is hashed and discarded) and records a
-- handoff row here, addressed to the human who approved. That human
-- issues the credential later from the admin (Live Edit chat strip,
-- Settings -> Users, Settings -> MCP): `credentials.issue` generates it
-- then, returns it once to that browser, and stamps `issued_at`.
--
-- The row holds NO secret: nothing to leak from a backup or a DB read,
-- no plaintext at rest, no key to manage. A handoff that is never issued
-- simply expires; the Owner can still reset the password / mint a token.
--
-- RLS: the recipient human reads and stamps their own rows; the system
-- context writes them (the approving executor). An `ai` actor matches no
-- policy and sees nothing.

BEGIN;
SET LOCAL caelo.actor_kind = 'system';

CREATE TABLE IF NOT EXISTS credential_handoffs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What gets generated on issue; credential_handoffs.ts holds the issuer.
  kind               text NOT NULL CHECK (kind IN ('user_temporary_password', 'mcp_token')),
  -- users.id or mcp_tokens.id, by kind.
  subject_id         uuid NOT NULL,
  -- Operator-facing line ("Temporary password for ana@example.com").
  label              text NOT NULL,
  -- The human who approved, the only one who may issue it.
  recipient_actor_id uuid NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  -- The proposal that produced it, for the audit trail.
  proposal_id        uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL DEFAULT now() + interval '7 days',
  issued_at          timestamptz,
  -- 'reveal' (shown once in the admin) or 'email' (a set-password link).
  issued_via         text CHECK (issued_via IN ('reveal', 'email'))
);

CREATE INDEX IF NOT EXISTS credential_handoffs_open_idx
  ON credential_handoffs (recipient_actor_id, created_at DESC)
  WHERE issued_at IS NULL;

ALTER TABLE credential_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE credential_handoffs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS credential_handoffs_recipient_or_system ON credential_handoffs;
CREATE POLICY credential_handoffs_recipient_or_system ON credential_handoffs
  USING (
    current_setting('caelo.actor_kind', true) = 'system'
    OR (current_setting('caelo.actor_kind', true) = 'human'
        AND recipient_actor_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid)
  )
  WITH CHECK (
    current_setting('caelo.actor_kind', true) = 'system'
    OR (current_setting('caelo.actor_kind', true) = 'human'
        AND recipient_actor_id = NULLIF(current_setting('caelo.actor_id', true), '')::uuid)
  );

-- Credentials the old executors already handed to the AI are still in the
-- chat history, which is replayed to the model on every later turn of that
-- chat (and reaches an MCP client through caelo_chat). Withhold them in
-- place. The tool results carried them under these two keys — plain JSON,
-- or JSON inside a string (escaped quotes) — and a bearer token is
-- recognisable anywhere by its shape. The canonical history
-- (`response_messages`) is only touched key-anchored: its reasoning parts
-- are signed, and rewriting their text would break the replay. The leaked
-- values themselves stay valid until the Owner resets that user's password
-- or revokes the token.
CREATE FUNCTION pg_temp.caelo_withhold_credentials(t text, anywhere boolean)
RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN anywhere
           THEN regexp_replace(s, 'mcp_[0-9a-f]{64}', '[withheld MCP token]', 'g')
           ELSE s END
  FROM (SELECT regexp_replace(
                 regexp_replace(t,
                   '("(temporaryPassword|plaintextToken)"\s*:\s*)"[^"\\]+"',
                   '\1"[withheld]"', 'g'),
                 '(\\"(temporaryPassword|plaintextToken)\\"\s*:\s*)\\"[^"\\]+\\"',
                 '\1\\"[withheld]\\"', 'g') AS s) x
$f$;

UPDATE chat_messages
   SET response_messages = pg_temp.caelo_withhold_credentials(response_messages::text, false)::jsonb
 WHERE response_messages::text ~ '(temporaryPassword|plaintextToken)\\?"\s*:\s*\\?"[^"\\]';

UPDATE chat_messages
   SET content = pg_temp.caelo_withhold_credentials(content, true),
       tool_calls = CASE WHEN tool_calls IS NULL THEN NULL
                         ELSE pg_temp.caelo_withhold_credentials(tool_calls::text, true)::jsonb END
 WHERE content ~ '(temporaryPassword|plaintextToken)\\?"\s*:\s*\\?"[^"\\]|mcp_[0-9a-f]{64}'
    OR tool_calls::text ~ '(temporaryPassword|plaintextToken)\\?"\s*:\s*\\?"[^"\\]|mcp_[0-9a-f]{64}';

COMMIT;
