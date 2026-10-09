// SPDX-License-Identifier: MPL-2.0
import { tv, type VariantProps } from "tailwind-variants";

export const badgeVariants = tv({
  base: "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors motion-reduce:transition-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      secondary: "border-transparent bg-secondary text-secondary-foreground",
      destructive: "border-transparent bg-destructive text-destructive-foreground",
      outline: "text-foreground",
      // White-on-color must clear WCAG AA (4.5:1) at text-xs: green-700
      // does (~5.0:1); amber-600 does not (~3.2:1, axe color-contrast on
      // /content/changes), so warning uses amber-700 (~5.0:1).
      success: "border-transparent bg-green-700 text-white",
      warning: "border-transparent bg-amber-700 text-white",
    },
  },
  defaultVariants: { variant: "default" },
});

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
