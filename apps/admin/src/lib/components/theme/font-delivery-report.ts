// SPDX-License-Identifier: MPL-2.0
import type { FontAxisPolicy } from "@caelo-cms/shared";

/** The `themes.font_delivery` result as the Font delivery panel renders it. */
export interface FontDeliveryReport {
  readonly weightUsage: { weights: number[] | null; uncertain: string[] };
  readonly faces: {
    fontId: string;
    sha256: string;
    family: string;
    roles: { role: string; fontWeight: unknown }[];
    sourceAxes: Record<string, { min: number; max: number; default: number }>;
    locked: boolean;
    override: FontAxisPolicy | null;
    effective: Record<
      string,
      { mode: "full" | "range"; min: number; max: number } | { mode: "pin"; value: number }
    >;
    origin: Record<string, "override" | "default">;
    fontWeightDescriptor: string;
    delivered: { slices: { subset: string; bytes: number }[]; totalBytes: number } | null;
    error: string | null;
  }[];
}
