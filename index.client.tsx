import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { CommandJobListener } from "./client/diff-panel";
import { createWalkthroughViews, WALKTHROUGH_SCREEN_ID } from "./client/diff-panel";
import { PANEL_ID } from "./shared/constants";
import { generateRpc, settingsRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const commandJobListeners = new Set<CommandJobListener>();
  const { WorkspacePanel, ExpandedScreen } = createWalkthroughViews(client, commandJobListeners);
  const removeScreen = client.addScreen({
    id: WALKTHROUGH_SCREEN_ID,
    title: "Walkthrough",
    Component: ExpandedScreen,
  });
  const removePanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Walkthrough",
    icon: "GitCompare",
    locations: ["explorer"],
    Component: WorkspacePanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "generate-walkthrough",
    title: "Generate walkthrough",
    icon: "GitCompare",
    context: "workspace",
    async onSelect({ workspace, rpc, openPanel }) {
      // Paseo 0.15.4 exposes workspace context here but has no visibility or disabled predicate.
      if (workspace.projectKind !== "git") return;

      openPanel(PANEL_ID, { location: "explorer" });
      const { settings } = await rpc(settingsRpc, { workspaceId: workspace.id });
      if (!settings.model?.trim()) return;
      const { jobId } = await rpc(generateRpc, { workspaceId: workspace.id });
      for (const selectJob of commandJobListeners) selectJob(workspace.id, jobId);
    },
  });

  return async () => {
    await Promise.all([removeCommand(), removePanel(), removeScreen()]);
  };
}
