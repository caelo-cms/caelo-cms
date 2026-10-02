// SPDX-License-Identifier: MPL-2.0
import { acquireFontInput, googleFontFiles } from "@caelo-cms/font-service";
import { json } from "@sveltejs/kit";
import { requirePermission } from "$lib/server/guards.js";
import type { RequestHandler } from "./$types";
export const GET: RequestHandler = async ({ locals, url }) => {
  requirePermission(locals, "roles.manage");
  const input = acquireFontInput.safeParse({ family: url.searchParams.get("family") });
  if (!input.success) return json({ error: "Enter a font family" }, { status: 400 });
  try {
    const result = await googleFontFiles(input.data.family);
    return json({
      variants: result.filenames.map((filename) => ({
        filename,
        label: filename
          .replace(/\.ttf$/, "")
          .replaceAll("-", " · ")
          .replace(/\[([^\]]+)\]/, " (variable: $1)"),
      })),
    });
  } catch {
    return json(
      {
        error:
          "This family is unavailable from the Open Font License catalog. You can upload a licensed font file instead.",
      },
      { status: 422 },
    );
  }
};
