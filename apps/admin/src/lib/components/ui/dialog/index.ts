// SPDX-License-Identifier: MPL-2.0
import { Dialog as DialogPrimitive } from "bits-ui";
import Content from "./dialog-content.svelte";
import Description from "./dialog-description.svelte";
import Footer from "./dialog-footer.svelte";
import Header from "./dialog-header.svelte";
import Overlay from "./dialog-overlay.svelte";
import Title from "./dialog-title.svelte";

const Root = DialogPrimitive.Root;
const Trigger = DialogPrimitive.Trigger;
const Close = DialogPrimitive.Close;

export {
  Close as DialogClose,
  Content as DialogContent,
  Description as DialogDescription,
  Footer as DialogFooter,
  Header as DialogHeader,
  Overlay as DialogOverlay,
  Root as Dialog,
  Title as DialogTitle,
  Trigger as DialogTrigger,
};
