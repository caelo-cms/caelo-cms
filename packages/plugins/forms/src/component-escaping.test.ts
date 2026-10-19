// SPDX-License-Identifier: MPL-2.0

/**
 * #847 — `<caelo-form>` builds its markup from the `fields` attribute;
 * every field name, label and type is escaped so a crafted value cannot
 * break out of its attribute or inject elements into the shadow root.
 */

import { describe, expect, it } from "bun:test";
import plugin from "./index.js";

/** Mount the component on a minimal host and return the markup it wrote. */
async function mountWith(fields: unknown): Promise<string> {
  const listeners: string[] = [];
  const stub = { addEventListener: (ev: string) => listeners.push(ev), disabled: false };
  const root = { innerHTML: "", querySelector: () => stub };
  const host = {
    shadowRoot: null,
    attachShadow: () => root,
    getAttribute: (name: string) => (name === "fields" ? JSON.stringify(fields) : "contact"),
  };
  const mounted = plugin.component?.mounted;
  if (!mounted) throw new Error("caelo-form component missing");
  await mounted(host as unknown as HTMLElement, {} as never);
  return root.innerHTML;
}

describe("<caelo-form> escaping", () => {
  it("escapes malicious name, label and type", async () => {
    const html = await mountWith([
      {
        name: 'x" onfocus="alert(1)',
        label: "<img src=x onerror=alert(2)>",
        type: 'text" autofocus onfocus="alert(3)',
      },
    ]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('" onfocus="');
    expect(html).not.toContain('" autofocus');
    expect(html).toContain('name="x&quot; onfocus=&quot;alert(1)"');
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    expect(html).toContain('type="text&quot; autofocus onfocus=&quot;alert(3)"');
  });

  it("escapes the textarea variant's name too", async () => {
    const html = await mountWith([
      { name: 'm"><script>alert(4)</script>', label: "Msg", type: "textarea" },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain('name="m&quot;&gt;&lt;script&gt;alert(4)&lt;/script&gt;"');
  });
});
