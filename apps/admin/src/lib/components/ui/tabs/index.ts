// SPDX-License-Identifier: MPL-2.0
import { Tabs as TabsPrimitive } from "bits-ui";
import Content from "./tabs-content.svelte";
import List from "./tabs-list.svelte";
import Trigger from "./tabs-trigger.svelte";

const Root = TabsPrimitive.Root;

export { Content as TabsContent, List as TabsList, Root as Tabs, Trigger as TabsTrigger };
