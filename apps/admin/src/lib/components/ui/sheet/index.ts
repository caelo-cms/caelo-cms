// SPDX-License-Identifier: MPL-2.0
import { Dialog as DialogPrimitive } from "bits-ui";
import Description from "../dialog/dialog-description.svelte";
import Footer from "../dialog/dialog-footer.svelte";
import Header from "../dialog/dialog-header.svelte";
import Title from "../dialog/dialog-title.svelte";
import Content from "./sheet-content.svelte";

const Root = DialogPrimitive.Root;
const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;

export { type SheetSide, sheetVariants } from "./sheet-variants.js";
export {
  Close as SheetClose,
  Content as SheetContent,
  Description as SheetDescription,
  Footer as SheetFooter,
  Header as SheetHeader,
  Root as Sheet,
  Title as SheetTitle,
  Trigger as SheetTrigger,
};
