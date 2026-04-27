// SPDX-License-Identifier: MPL-2.0

/**
 * The `cn()` helper used by every shadcn-svelte component to merge class
 * strings — clsx() handles conditional classes; twMerge() dedupes
 * conflicting Tailwind utilities (e.g. `p-2 p-4` → `p-4`).
 */

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
