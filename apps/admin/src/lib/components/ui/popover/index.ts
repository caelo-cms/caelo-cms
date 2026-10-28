// SPDX-License-Identifier: MPL-2.0
import { Popover as PopoverPrimitive } from "bits-ui";
import Content from "./popover-content.svelte";

const Root = PopoverPrimitive.Root;
const Trigger = PopoverPrimitive.Trigger;
const Close = PopoverPrimitive.Close;

export {
  Close as PopoverClose,
  Content as PopoverContent,
  Root as Popover,
  Trigger as PopoverTrigger,
};
