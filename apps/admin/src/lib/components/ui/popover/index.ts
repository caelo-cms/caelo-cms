// SPDX-License-Identifier: MPL-2.0
import { Popover as PopoverPrimitive } from "bits-ui";
import Content from "./popover-content.svelte";

const Root = PopoverPrimitive.Root;
const Trigger = PopoverPrimitive.Trigger;

export { Content as PopoverContent, Root as Popover, Trigger as PopoverTrigger };
