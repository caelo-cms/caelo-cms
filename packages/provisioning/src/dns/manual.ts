// SPDX-License-Identifier: MPL-2.0

/**
 * Manual DNS adapter — fallback for registrars without an API
 * integration (Namecheap, GoDaddy, Porkbun, etc.). Prints the records,
 * waits for the operator to paste them at the registrar, polls public
 * DNS until resolution succeeds.
 *
 * Per CLAUDE.md §11.C: this IS one of the few human-required steps
 * the wizard can't skip. The polling makes it close to zero-friction —
 * the operator pastes records, presses Enter, the wizard waits.
 */

import { promises as dns } from "node:dns";
import { setTimeout as sleep } from "node:timers/promises";
import { confirm, isCancel, log, note, spinner } from "@clack/prompts";
import { bold, cyan, dim, green, red } from "kleur/colors";
import type { DnsAdapter, DnsRecord } from "./types.js";

const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — managed certs need ~15 min to issue after DNS

export function makeManualAdapter(opts: { domain: string }): DnsAdapter {
  return {
    name: `Manual (paste at your registrar for ${opts.domain})`,
    async applyRecords(records: DnsRecord[]): Promise<void> {
      note(
        [
          bold("Paste these DNS records at your registrar:"),
          "",
          ...records.map(
            (r) =>
              `  ${dim(r.type.padEnd(6))} ${r.hostname.padEnd(35)} → ${bold(r.value)}`,
          ),
          "",
          dim("After pasting, press Enter to verify resolution."),
        ].join("\n"),
        "DNS records",
      );

      const ack = await confirm({
        message: "Records pasted at your registrar?",
        initialValue: true,
      });
      if (isCancel(ack) || !ack) {
        log.error(red("Aborted at DNS step."));
        throw new Error("DNS records not pasted; aborted by operator.");
      }

      const s = spinner();
      s.start(`Polling DNS — up to 30 min while propagation + records settle...`);
      const start = Date.now();
      const remaining = new Set(records.map((r) => recordKey(r)));

      while (remaining.size > 0) {
        if (Date.now() - start > POLL_TIMEOUT_MS) {
          s.stop(red("DNS verify timeout (30 min)."));
          throw new Error(
            `Records still unresolved after 30 min: ${[...remaining].join(", ")}. Re-run after fixing.`,
          );
        }
        for (const key of [...remaining]) {
          const record = records.find((r) => recordKey(r) === key);
          if (!record) {
            remaining.delete(key);
            continue;
          }
          if (await checkRecord(record)) {
            remaining.delete(key);
            log.success(
              green(`✓ ${record.type} ${record.hostname} resolves to expected ${record.value}`),
            );
          }
        }
        if (remaining.size > 0) await sleep(POLL_INTERVAL_MS);
      }
      s.stop(green("All DNS records resolve."));
      void cyan;
    },
  };
}

function recordKey(r: DnsRecord): string {
  return `${r.type}:${r.hostname}`;
}

async function checkRecord(record: DnsRecord): Promise<boolean> {
  try {
    if (record.type === "A") {
      const result = await dns.resolve4(record.hostname);
      return result.includes(record.value);
    }
    if (record.type === "AAAA") {
      const result = await dns.resolve6(record.hostname);
      return result.includes(record.value);
    }
    if (record.type === "CNAME") {
      const result = await dns.resolveCname(record.hostname);
      // CNAME values often have a trailing dot; normalize
      const expected = record.value.replace(/\.$/, "");
      return result.some((v) => v.replace(/\.$/, "") === expected);
    }
    if (record.type === "TXT") {
      const result = await dns.resolveTxt(record.hostname);
      const expected = record.value.replace(/^"|"$/g, "");
      return result.some((arr) => arr.join("") === expected);
    }
    return false;
  } catch {
    // ENOTFOUND / SERVFAIL — record not propagated yet
    return false;
  }
}
