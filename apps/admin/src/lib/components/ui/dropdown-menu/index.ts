// SPDX-License-Identifier: MPL-2.0
import { DropdownMenu as DropdownMenuPrimitive } from "bits-ui";
import Content from "./dropdown-menu-content.svelte";
import Item from "./dropdown-menu-item.svelte";
import Separator from "./dropdown-menu-separator.svelte";

const Root = DropdownMenuPrimitive.Root;
const Trigger = DropdownMenuPrimitive.Trigger;
const Group = DropdownMenuPrimitive.Group;

export {
  Content as DropdownMenuContent,
  Group as DropdownMenuGroup,
  Item as DropdownMenuItem,
  Root as DropdownMenu,
  Separator as DropdownMenuSeparator,
  Trigger as DropdownMenuTrigger,
};
