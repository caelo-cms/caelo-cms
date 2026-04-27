// SPDX-License-Identifier: MPL-2.0
import { tv, type VariantProps } from "tailwind-variants";

export const alertVariants = tv({
  base: "relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg+div]:translate-y-[-3px] [&:has(svg)]:pl-11",
  variants: {
    variant: {
      default: "bg-background text-foreground",
      destructive:
        "border-destructive/50 text-destructive bg-destructive/5 [&>svg]:text-destructive",
    },
  },
  defaultVariants: { variant: "default" },
});

export type AlertVariant = VariantProps<typeof alertVariants>["variant"];
