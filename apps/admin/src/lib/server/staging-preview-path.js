// SPDX-License-Identifier: MPL-2.0
export function stagingPreviewPath(slug, locale) {
    const trimmed = slug.replace(/^\/+|\/+$/g, "");
    const isHome = trimmed === "" || trimmed === "home" || trimmed === "index";
    // Generator emits the home page as just `index.html`. The proxy
    // serves `<runId>/` by appending `index.html`, so the cleanest
    // URL for home is the empty suffix.
    const dirPath = isHome ? "" : `${trimmed}/`;
    if (!locale)
        return dirPath;
    switch (locale.urlStrategy) {
        case "none":
            return dirPath;
        case "subdirectory":
            return `${locale.code}/${dirPath}`;
        case "subdomain":
        case "domain":
            // Hosted-locale strategies emit under `_hosts/<host>/`. The
            // preview proxy can serve that path verbatim — operator sees
            // the canonical path the live CDN would route.
            return locale.urlHost ? `_hosts/${locale.urlHost}/${dirPath}` : dirPath;
        default:
            return dirPath;
    }
}
