// SPDX-License-Identifier: MPL-2.0
import { tv, type VariantProps } from "tailwind-variants";

export const sheetVariants = tv({
  base: "fixed z-50 gap-4 bg-background p-6 shadow-lg",
  variants: {
    side: {
      top: "inset-x-0 top-0 border-b",
      bottom: "inset-x-0 bottom-0 border-t",
      left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
      right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-md",
    },
  },
  defaultVariants: { side: "right" },
});

export type SheetSide = VariantProps<typeof sheetVariants>["side"];
