// SPDX-License-Identifier: MPL-2.0
import { acquireFontInput, acquireGoogleFont, fontCatalog, fontMetadata, MAX_FONT_BYTES, } from "@caelo-cms/font-service";
import { execute } from "@caelo-cms/query-api";
import { error, fail } from "@sveltejs/kit";
import { assertCsrfToken } from "#lib/server/csrf.js";
import { requirePermission } from "#lib/server/guards.js";
import { getQueryContext } from "#lib/server/query.js";
export const load = async ({ locals, url }) => {
    requirePermission(locals, "roles.manage");
    const { registry, adapter } = getQueryContext();
    const query = (url.searchParams.get("q") ?? "").slice(0, 200);
    const [fonts, themes, catalog] = await Promise.all([
        execute(registry, adapter, locals.ctx, "fonts.find", { query, limit: 100 }),
        execute(registry, adapter, locals.ctx, "themes.list", {}),
        fontCatalog(query),
    ]);
    if (!fonts.ok || !themes.ok)
        throw error(500, "Could not load font library");
    return {
        hasMore: fonts.value.hasMore,
        fonts: fontMetadata.array().parse(fonts.value.fonts),
        themes: themes.value.themes,
        catalog,
        query,
    };
};
async function save(locals, input) {
    const { registry, adapter } = getQueryContext();
    const result = await execute(registry, adapter, locals.ctx, "fonts.import", input);
    if (!result.ok)
        return fail(400, { error: JSON.stringify(result.error) });
    const font = fontMetadata.parse(result.value);
    return { message: `${font.family} ${font.subfamily} imported.`, fontId: font.id };
}
export const actions = {
    import: async ({ locals, request }) => {
        requirePermission(locals, "roles.manage");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const file = form.get("file");
        if (!(file instanceof File) || file.size > MAX_FONT_BYTES || file.size < 48)
            return fail(400, { error: "Choose a TTF, OTF, WOFF or WOFF2 file (maximum 8 MiB)." });
        return save(locals, {
            dataBase64: Buffer.from(await file.arrayBuffer()).toString("base64"),
            source: `upload:${file.name}`,
            license: {
                name: String(form.get("licenseName") ?? ""),
                text: String(form.get("licenseText") ?? ""),
                webEmbedding: form.has("web"),
                documentEmbedding: form.has("document"),
            },
        });
    },
    acquire: async ({ locals, request }) => {
        requirePermission(locals, "roles.manage");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        try {
            const input = acquireFontInput.parse({
                family: form.get("family"),
                ...(form.get("filename") ? { filename: form.get("filename") } : {}),
            });
            return await save(locals, await acquireGoogleFont(input));
        }
        catch (e) {
            return fail(400, { error: e instanceof Error ? e.message : "Font acquisition failed" });
        }
    },
    bind: async ({ locals, request }) => {
        requirePermission(locals, "roles.manage");
        const form = await request.formData();
        await assertCsrfToken(form, locals);
        const { registry, adapter } = getQueryContext();
        const r = await execute(registry, adapter, locals.ctx, "themes.update_tokens", {
            themeSlug: form.get("themeSlug"),
            fontBindings: {
                [String(form.get("role"))]: { id: form.get("id"), sha256: form.get("sha256") },
            },
        });
        return r.ok
            ? { message: "Font revision assigned to theme. The change is recorded in theme history." }
            : fail(400, { error: JSON.stringify(r.error) });
    },
};
