import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createDiffPanel } from "./client/diff-panel";
import { PANEL_ID } from "./shared/constants";

export default function contribute(client: PluginClientContext) {
  return client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Walkthrough",
    icon: "GitCompare",
    Component: createDiffPanel(client),
  });
}
