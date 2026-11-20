import { InvalidWalkthroughError } from "./document";
import type { PaseoAgentCreateOptions, PaseoAgentHandle, PaseoApi } from "./host-types";

export interface HiddenAgentRequest {
  /** The workspace the reviewer is looking at. */
  workspaceId: string;
  /** A plugin-owned directory: the model never works in the repository. */
  cwd: string;
  /** The provider and model, "provider/model". */
  provider: string;
  systemPrompt: string;
  initialTurn?: { prompt: string; outputSchema: Record<string, unknown> };
}

export interface HiddenAgent {
  ask(prompt: string, timeoutMs: number): Promise<string>;
  /** Stops the running turn: the model stops working on the answer. */
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Daemon 0.15.4 refuses a background agent that names a workspace ("background is workspace
 * creation intent; configure the selected workspace at creation.") and creates a background
 * workspace for a background agent that names none. Daemon 0.16.2 and newer accept the
 * background agent inside the workspace. The plugin SDK exposes no daemon version, so the call
 * the daemon accepts is found by asking for the newer one and falling back when it is refused.
 */
const BACKGROUND_IN_WORKSPACE_REFUSAL = "background is workspace creation intent";
const OPEN_CODE_OUTPUT_REJECTION = /^(Invalid OpenCode structured output:|OpenCode finished without submitting the required structured output)/;

const refusesBackgroundInWorkspace = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(BACKGROUND_IN_WORKSPACE_REFUSAL);
};

/** Creates the agent the model runs in. The reviewer never sees it: it is a background agent. */
export async function createHiddenAgent(paseo: PaseoApi, request: HiddenAgentRequest): Promise<HiddenAgent> {
  const config = { provider: request.provider, systemPrompt: request.systemPrompt };
  const base: PaseoAgentCreateOptions = { config, cwd: request.cwd, background: true, ...request.initialTurn };
  const inWorkspace: PaseoAgentCreateOptions & { workspaceId: string } = { ...base, workspaceId: request.workspaceId };

  let handle: PaseoAgentHandle;
  try {
    handle = await paseo.agents.create(inWorkspace);
  } catch (error) {
    if (!refusesBackgroundInWorkspace(error)) throw error;
    handle = await paseo.agents.create(base);
  }

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await handle.archive().catch(() => undefined);
  };

  return {
    async ask(prompt: string, timeoutMs: number) {
      const result = request.initialTurn ? await handle.waitForFinish(timeoutMs) : await handle.run(prompt, { timeoutMs });
      if (result.status === "timeout") throw new Error("The model did not answer in time.");
      if (result.status === "permission") throw new Error("The model asked for a permission the walkthrough cannot give.");
      if (result.status === "error") {
        const problem = result.error ?? "The model failed.";
        if (request.initialTurn && OPEN_CODE_OUTPUT_REJECTION.test(problem)) throw new InvalidWalkthroughError([problem]);
        throw new Error(problem);
      }
      return result.lastMessage ?? "";
    },
    /**
     * Stops the model call that is running.
     *
     * The daemon gives a plugin no call that cancels a turn. The closest it comes is
     * reloading the agent, which the daemon answers by interrupting the running turn
     * before it reopens the session, and archiving the agent, which closes the provider
     * session and kills the call for good.
     */
    async stop() {
      try {
        await handle.reload();
      } catch {
        // The daemon may refuse the interrupt; archiving the agent still stops the call.
      }
      await dispose();
    },
    dispose,
  };
}
