// SPDX-License-Identifier: MPL-2.0

/**
 * Measure the agents' think times for the scale gate from real model runs:
 * the chat transcripts the real-AI suite uploads (`e2e-livedit-transcripts-*`
 * artifacts of `.github/workflows/e2e-livedit.yml`, #47). A step's think
 * time is the gap from its last tool result to the next assistant message
 * of the same chat: the time the model took to write its next tool call.
 *
 *   gh run download <run> -p 'e2e-livedit-transcripts-*' -D transcripts/<run>
 *   bun scripts/scale-gate/measure-think-times.ts --source "<runs, date>" \
 *     --out scripts/scale-gate/think-times.json transcripts/**\/*.json
 *
 * The editors' pause is kept from the existing file: nothing measures it yet.
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { ThinkTimes } from "./think.ts";

interface TranscriptChat {
  readonly id: string;
  readonly messages: readonly { readonly createdAt: string; readonly role: string }[];
}

/** The think time of every step in `chats`, seconds, rounded to 0.1 s. */
export function stepThinkSeconds(chats: readonly TranscriptChat[]): number[] {
  const out: number[] = [];
  for (const chat of chats) {
    const m = [...chat.messages].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (let i = 1; i < m.length; i++) {
      const prev = m[i - 1] as TranscriptChat["messages"][number];
      const cur = m[i] as TranscriptChat["messages"][number];
      if (prev.role !== "tool" || cur.role !== "assistant") continue;
      const s = (Date.parse(cur.createdAt) - Date.parse(prev.createdAt)) / 1000;
      if (s >= 0) out.push(Math.round(s * 10) / 10);
    }
  }
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const take = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const out = take("--out") ?? "scripts/scale-gate/think-times.json";
  const source = take("--source");
  if (!source) throw new Error("--source names the runs measured (ids and date)");
  const seen = new Set<string>();
  const chats: TranscriptChat[] = [];
  for (const file of args) {
    for (const chat of JSON.parse(readFileSync(file, "utf8")) as TranscriptChat[]) {
      // A chat is dumped again before every reset of the same run.
      const key = `${chat.id}:${chat.messages.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chats.push(chat);
    }
  }
  const steps = stepThinkSeconds(chats);
  if (steps.length < 100) throw new Error(`only ${steps.length} steps: add more runs`);
  // Read, never check first: the file keeps the editors' pause.
  let previous: ThinkTimes;
  try {
    previous = JSON.parse(readFileSync(out, "utf8")) as ThinkTimes;
  } catch (e) {
    throw new Error(
      `${out} must exist and hold JSON: it keeps the editors' pause (${(e as Error).message})`,
    );
  }
  const times: ThinkTimes = {
    source,
    agentStepSeconds: steps.sort((a, b) => a - b),
    editorPauseSeconds: previous.editorPauseSeconds,
  };
  writeFileSync(out, `${JSON.stringify(times, null, 2)}\n`);
  console.log(`${steps.length} steps from ${chats.length} chats → ${out}`);
}

if (import.meta.main) main();
