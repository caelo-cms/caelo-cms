// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the matrix of the core-parity test (`template-core-parity.test.ts`):
 * 32 template fragments, paired into 1,024 templates, rendered with core
 * values only. A `.test.ts` file so it never ships in `dist`; it declares
 * no tests of its own. `test-fixtures/template-core-parity.golden.json`
 * holds what main's engine rendered for each template before #1732; the
 * script that wrote it is `scripts/template-core-parity-golden.ts`.
 */

import type { TemplateField } from "./template-engine.js";

/** The module's fields: every kind a core value can take in the matrix. */
export const CORE_PARITY_FIELDS: TemplateField[] = [
  { name: "title", kind: "text" },
  { name: "body", kind: "richtext" },
  { name: "cta", kind: "link" },
  { name: "flag", kind: "boolean" },
  { name: "n", kind: "number" },
  { name: "img", kind: "image" },
  { name: "child", kind: "module" },
  { name: "pv", kind: "text" },
  { name: "empty", kind: "text" },
  { name: "deflt", kind: "text", default: "D<b>" },
  { name: "mods", kind: "module-list" },
] as TemplateField[];

/** Core values; `pv` is the field a plugin fills in the second pass. */
export const CORE_PARITY_VALUES: Record<string, unknown> = {
  title: `A "b" <c> & 'd' {{x}}`,
  body: "<p>x</p><!-- c -->",
  cta: { href: "/a?b=1&c=2", target: "_blank" },
  flag: true,
  n: 0,
  img: "caelo:media/00000000-0000-4000-8000-000000000001",
  child: null,
  empty: "",
  mods: [],
};

const FRAGMENTS = [
  "{{title}}",
  "{{{title}}}",
  "{{&title}}",
  "{{body}}",
  "{{{body}}}",
  "{{cta}}",
  "{{cta.href}}",
  "{{{cta}}}",
  "{{CTA}}",
  "{{Title}}",
  "{{#flag}}on{{/flag}}",
  "{{^flag}}off{{/flag}}",
  "{{#title}}[{{.}}]{{/title}}",
  "{{#title}}<i>{{item}}</i>{{/title}}",
  "{{n}}",
  "{{#n}}N{{.}}{{/n}}",
  "{{img}}",
  "{{unknown}}",
  "{{Page URL}}",
  "{{! c }}",
  "{{>child}}",
  "{{empty}}",
  "{{#empty}}E{{/empty}}",
  "{{deflt}}",
  "{{#mods}}x{{/mods}}",
  "{{theme_logo_url}}",
  "{{ title }}",
  '{{#cta}}<a href="{{cta.href}}">go</a>{{/cta}}',
  '<li{{#flag}} class="on"{{/flag}}>{{title}}</li>',
  "<p title={{title}}>x</p>",
  "{{#flag}}{{&title}}{{/flag}}",
  "{{#Flag}}F{{/Flag}}",
];

/** The 1,024 templates, in the golden file's order. */
export function coreParityTemplates(): string[] {
  const out: string[] = [];
  for (const a of FRAGMENTS) for (const b of FRAGMENTS) out.push(`<div>${a}</div>${b}`);
  return out;
}

/** A template `fieldPathProblems` judged before #1732: `{{&…}}` paths were saved. */
export const CORE_PARITY_FIELD_PATHS = "<a>{{&cta.label}}</a><b>{{&title.x}}</b>";
