import { InvalidWalkthroughError } from "./document";
import type { PaseoApi } from "./host-types";

export interface HiddenAgentRequest {
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

const OPENCODE_OUTPUT_REJECTION = /^(Invalid OpenCode structured output:|OpenCode finished without submitting the required structured output)/;

/** Creates the agent the model runs in. The reviewer never sees it: it is a background agent. */
export async function createHiddenAgent(paseo: PaseoApi, request: HiddenAgentRequest): Promise<HiddenAgent> {
  const config = { provider: request.provider, systemPrompt: request.systemPrompt };
  // Paseo replaces cwd with the workspace's directory when workspaceId is set.
  const handle = await paseo.agents.create({ config, cwd: request.cwd, background: true, ...request.initialTurn });

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
        if (request.initialTurn && OPENCODE_OUTPUT_REJECTION.test(problem)) throw new InvalidWalkthroughError([problem]);
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
