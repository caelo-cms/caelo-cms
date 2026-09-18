// SPDX-License-Identifier: MPL-2.0
/** Only authenticated local plugin-preview endpoints can become editor surfaces. */
export function localPluginPreview(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value, origin);
    if (
      url.origin !== origin ||
      url.username ||
      url.password ||
      !/^\/plugins\/[a-z0-9]+(?:-[a-z0-9]+)*\/preview$/.test(url.pathname)
    )
      return null;
    const args = url.searchParams.get("args") ?? "{}";
    if (args.length > 2048) return null;
    const parsed = JSON.parse(args);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const params = new URLSearchParams({ args });
    const view = url.searchParams.get("view");
    if (view) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(view)) return null;
      params.set("view", view);
    }
    return `${url.pathname}?${params.toString()}`;
  } catch {
    return null;
  }
}
export function previewFromResult(content: string, origin: string): string | null {
  try {
    return localPluginPreview(JSON.parse(content)?.previewUrl, origin);
  } catch {
    return null;
  }
}
