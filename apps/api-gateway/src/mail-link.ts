// SPDX-License-Identifier: MPL-2.0

/**
 * The confirmation page a mail link opens (issue #1337, epic #763 M7).
 *
 *   GET /api/_caelo/mail-link/<slug>/<operation>?token=…
 *
 * A plugin's mail template (`mailTemplates[…].link`, plugin SDK
 * mail-templates.ts) links here; the admin puts the environment's own host
 * in front (live: the site's base URL, staging: the staging host). The
 * page changes nothing by being opened: mail scanners and link previews
 * open links, and a double opt-in they could complete would prove nothing.
 * It shows one button (and the template's password fields); a click
 * solves the operation's proof-of-work like any component does and calls
 * `POST /api/plugin/<slug>/<operation>` with `{ token, …fields }` from the
 * same origin, so every rule of a visitor call applies (JSON only, the
 * Origin allowlist, the declared input schema, captcha, rate limits).
 *
 * The page is served only for a link a loaded plugin declares; any other
 * path is the same 404 as an unknown plugin path. The token is never
 * reflected into the document: the script reads it from the address bar,
 * and `Referrer-Policy: no-referrer` keeps it out of every request it
 * makes. Like the component kit, both requests carry the visitor's consent
 * decision (`x-caelo-consent`, read from the banner's cookie), so
 * confirming a mail never reads as a withdrawn consent to the gateway. The script and style are fixed; the CSP allows exactly their
 * hashes and requests to this origin.
 */

import { createHash } from "node:crypto";
import type { PluginMailTemplates } from "@caelo-cms/plugin-sdk";

const MAIL_LINK_PATH_RE =
  /^\/api\/_caelo\/mail-link\/([a-z][a-z0-9-]{0,54})\/([a-z_][a-z0-9_]{0,119})$/;

/** The plugin and operation of a confirmation-page path, or null. */
export function parseMailLinkPath(pathname: string): { slug: string; operation: string } | null {
  const m = MAIL_LINK_PATH_RE.exec(pathname);
  return m?.[1] && m[2] ? { slug: m[1], operation: m[2] } : null;
}

/** The link a template declares for `operation`, or undefined. */
export function declaredMailLink(
  templates: PluginMailTemplates | undefined,
  operation: string,
): NonNullable<PluginMailTemplates[string]["link"]> | undefined {
  for (const t of Object.values(templates ?? {})) {
    if (t.link?.operation === operation) return t.link;
  }
  return undefined;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;color:#111;background:#fff}
main{max-width:28rem;margin:0 auto}
label{display:block;margin:.75rem 0 .25rem}
input{width:100%;box-sizing:border-box;padding:.5rem;font:inherit}
button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;cursor:pointer}
[data-status]{margin-top:1rem}
@media (prefers-color-scheme:dark){body{color:#eee;background:#111}}`;

/**
 * Fixed. Mirrors the component kit's `attachCaptchaProof` + `postPluginJson`
 * (the proof is solved over `<challenge>|<slug>.<operation>|<nonce>`).
 */
const SCRIPT = `(function(){
var main=document.querySelector("main");var form=document.querySelector("form");var status=document.querySelector("[data-status]");
var slug=main.getAttribute("data-slug");var op=main.getAttribute("data-operation");
var token=new URLSearchParams(location.search).get("token")||"";
function consent(){var m=document.cookie.match(/(?:^|; )caelo_consent=([^;]*)/);if(!m)return {};try{var s=JSON.parse(decodeURIComponent(m[1]));if(!Array.isArray(s.granted)||typeof s.policyVersion!=="number")return {};return {"x-caelo-consent":"v="+s.policyVersion+"; granted="+s.granted.join(",")}}catch(e){return {}}}
history.replaceState(null,"",location.pathname);
function hex(b){return Array.prototype.map.call(new Uint8Array(b),function(x){return x.toString(16).padStart(2,"0")}).join("")}
async function proof(){var r=await fetch("/api/captcha/challenge",{credentials:"same-origin",headers:consent()});if(r.status===204)return null;if(!r.ok)throw new Error("challenge");
var env=await r.json();var c=env.data.challenge,t=env.data.target,enc=new TextEncoder();
for(var n=0;n<5000000;n++){var nonce=n.toString(16);var d=hex(await crypto.subtle.digest("SHA-256",enc.encode(c+"|"+slug+"."+op+"|"+nonce)));if(d.indexOf(t)===0)return{challenge:c,nonce:nonce}}
throw new Error("pow")}
form.addEventListener("submit",async function(ev){ev.preventDefault();var btn=form.querySelector("button");btn.disabled=true;status.textContent="…";
try{var body={token:token};Array.prototype.forEach.call(form.querySelectorAll("input"),function(i){body[i.name]=i.value});
var p=await proof();if(p)body._caelo_captcha=p;
var res=await fetch("/api/plugin/"+slug+"/"+op,{method:"POST",credentials:"same-origin",headers:Object.assign({"Content-Type":"application/json"},consent()),body:JSON.stringify(body)});
if(res.ok){status.textContent=main.getAttribute("data-done");form.querySelectorAll("input").forEach(function(i){i.value=""});return}
status.textContent=res.status===503?"Please try again in a moment.":"This link is invalid or has expired.";btn.disabled=false}
catch(e){status.textContent="Something went wrong. Please try again.";btn.disabled=false}});
})();`;

function cspHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

const CSP = [
  "default-src 'none'",
  `script-src ${cspHash(SCRIPT)}`,
  `style-src ${cspHash(STYLE)}`,
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * The confirmation page for one declared link. Every value interpolated
 * comes from the plugin's manifest or the validated path, escaped.
 */
export function mailLinkPage(
  route: { readonly slug: string; readonly operation: string },
  link: NonNullable<PluginMailTemplates[string]["link"]>,
  requestId: string,
): Response {
  const fields = (link.fields ?? [])
    .map(
      (f) =>
        `<label for="f-${escapeHtml(f.name)}">${escapeHtml(f.label)}</label><input id="f-${escapeHtml(f.name)}" name="${escapeHtml(f.name)}" type="password" autocomplete="new-password" required maxlength="1024">`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(link.label)}</title><style>${STYLE}</style></head><body><main data-slug="${escapeHtml(route.slug)}" data-operation="${escapeHtml(route.operation)}" data-done="${escapeHtml(link.done)}"><h1>${escapeHtml(link.label)}</h1><form>${fields}<button type="submit">${escapeHtml(link.label)}</button></form><p data-status aria-live="polite"></p></main><script>${SCRIPT}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Robots-Tag": "noindex",
      "X-Request-Id": requestId,
    },
  });
}
