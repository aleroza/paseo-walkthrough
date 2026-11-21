import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { CommandJobListener } from "./client/diff-panel";
import { createDiffPanel } from "./client/diff-panel";
import { PANEL_ID } from "./shared/constants";
import { generateRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const commandJobListeners = new Set<CommandJobListener>();
  const removePanel = client.addWorkspacePanel({
    id: PANEL_ID,
    title: "Walkthrough",
    icon: "GitCompare",
    locations: ["explorer"],
    Component: createDiffPanel(client, commandJobListeners),
  });
  const removeCommand = client.addCommandCenterItem({
    id: "generate-walkthrough",
    title: "Generate walkthrough",
    icon: "GitCompare",
    context: "workspace",
    async onSelect({ workspace, rpc, openPanel }) {
      // Paseo 0.15.4 exposes workspace context here but has no visibility or disabled predicate.
      if (workspace.projectKind !== "git") return;

      const { jobId } = await rpc(generateRpc, { workspaceId: workspace.id });
      for (const selectJob of commandJobListeners) selectJob(workspace.id, jobId);
      openPanel(PANEL_ID, { location: "explorer" });
    },
  });

  return async () => {
    await Promise.all([removeCommand(), removePanel()]);
  };
}
