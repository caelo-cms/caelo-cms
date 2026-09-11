// SPDX-License-Identifier: MPL-2.0

import { afterAll, expect, test } from "bun:test";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { providerEnvKey } from "../ai/provider-env.js";
import { configureProviderResolver, getImageProviderApiKey } from "../ai/provider-resolver.js";
import { _setKekForTests, encryptSecret } from "../security/secret-box.js";

const enabled = !!process.env.ADMIN_DATABASE_URL && !!process.env.PUBLIC_ADMIN_DATABASE_URL;
let adapter: DatabaseAdapter | undefined;
afterAll(async () => {
  _setKekForTests(null);
  await adapter?.close();
});

test.skipIf(!enabled)(
  "image dispatch decrypts the active Google key without putting it in public config",
  async () => {
    adapter = new DatabaseAdapter({
      adminDatabaseUrl: process.env.ADMIN_DATABASE_URL!,
      publicDatabaseUrl: process.env.PUBLIC_ADMIN_DATABASE_URL!,
    });
    configureProviderResolver({ adapter, registry: new OperationRegistry() });
    _setKekForTests(new Uint8Array(32).fill(17));
    const secret = await encryptSecret("test-encrypted-google-image-key");
    const sql = adapter.rawAdmin();
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO ai_providers(name, display_name, is_active, config, api_key_encrypted, api_key_iv, api_key_kek_fp, api_key_set_at)
      VALUES ('google', 'Google test', true, '{"model":"gemini-3.8-flash","imageModel":"gemini-3.1-flash-image"}'::jsonb,
        ${secret.ciphertext}, ${secret.iv}, ${secret.kekFingerprint}, now())
      ON CONFLICT(name) DO UPDATE SET is_active=true, api_key_encrypted=EXCLUDED.api_key_encrypted,
        api_key_iv=EXCLUDED.api_key_iv, api_key_kek_fp=EXCLUDED.api_key_kek_fp`;
    });
    expect(await getImageProviderApiKey("google")).toBe("test-encrypted-google-image-key");
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE ai_providers SET api_key_encrypted=NULL, api_key_iv=NULL, api_key_kek_fp=NULL, api_key_set_at=NULL WHERE name='google'`;
    });
    expect(await getImageProviderApiKey("google")).toBe(providerEnvKey("google") ?? null);
  },
);
