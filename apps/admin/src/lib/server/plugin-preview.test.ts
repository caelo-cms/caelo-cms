// SPDX-License-Identifier: MPL-2.0

import { expect, test } from "bun:test";
import { PLUGIN_PREVIEW_CSP, sanitizePluginPreview } from "./plugin-preview.js";

test("private preview removes active content, navigation and external image requests", () => {
  const result = sanitizePluginPreview(
    `<p onclick="steal()">Story &amp; text</p><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil.test"><a href="https://evil.test">secret</a><form action="https://evil.test"><input name="secret"></form><svg onload="steal()"></svg><img src="https://evil.test/secret" onerror="steal()"><img src="data:image/png;base64,aW1hZ2U=">`,
  );
  expect(result).toContain("Story &amp; text");
  expect(result).not.toContain("evil.test");
  expect(result).not.toContain("steal");
  expect(result).not.toContain("script");
  expect(result).not.toContain("secret");
  expect(result).toContain('src="data:image/png;base64,aW1hZ2U="');
  expect(PLUGIN_PREVIEW_CSP).toContain("sandbox;");
  expect(PLUGIN_PREVIEW_CSP).toContain("default-src 'none'");
});

test("blocked nested and malformed content cannot reopen active tags", () => {
  const html = sanitizePluginPreview(
    '<div><iframe><p>private</p></iframe></div><p>Visible</p><style>p{color:red}</style><p title="&quot; onmouseover=boom">Text</p>',
  );
  expect(html).not.toContain("private");
  expect(html).not.toContain("onmouseover");
  expect(html).toContain("Visible");
  expect(html).toContain("p{color:red}");
});
