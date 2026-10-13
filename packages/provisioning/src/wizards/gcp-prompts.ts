// SPDX-License-Identifier: MPL-2.0

import { cancel, isCancel, text } from "@clack/prompts";

/** Ask for the GCP project id (created if absent), validated like GCP does. */
export async function promptProjectId(guess: string): Promise<string> {
  const value = await text({
    message: "GCP project id (will be created if absent)",
    placeholder: guess,
    defaultValue: guess,
    validate: (v) => {
      if (!v || v.length < 6 || v.length > 30) {
        return "GCP project id must be 6–30 chars";
      }
      if (!/^[a-z][a-z0-9-]*[a-z0-9]$/.test(v)) {
        return "GCP project id: lowercase letters, digits, hyphens; start with letter; no trailing hyphen";
      }
      return undefined;
    },
  });
  if (isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value as string;
}
