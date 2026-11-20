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
  ask(prompt: string, timeoutMs: number, signal: AbortSignal): Promise<string>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

const OPENCODE_OUTPUT_REJECTION = /^(Invalid OpenCode structured output:|OpenCode finished without submitting the required structured output)/;

/** Creates the agent the model runs in. The reviewer never sees it: it is a background agent. */
export async function createHiddenAgent(paseo: PaseoApi, request: HiddenAgentRequest): Promise<HiddenAgent> {
  const config = { provider: request.provider, systemPrompt: request.systemPrompt };
  // Paseo replaces cwd with the workspace's directory when workspaceId is set.
  const handle = await paseo.agents.create({ config, cwd: request.cwd, background: true, ...request.initialTurn });

  const dispose = async () => {
    try {
      await handle.archive();
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not archive walkthrough agent ${handle.id}: ${problem}`);
    }
  };

  return {
    async ask(prompt: string, timeoutMs: number, signal: AbortSignal) {
      signal.throwIfAborted();
      const turn = request.initialTurn ? handle.waitForFinish(timeoutMs) : handle.run(prompt, { timeoutMs });
      let abort = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      });
      const result = await Promise.race([turn, cancelled]).finally(() => signal.removeEventListener("abort", abort));
      if (result.status === "timeout") throw new Error("The model did not answer in time.");
      if (result.status === "permission") throw new Error("The model asked for a permission the walkthrough cannot give.");
      if (result.status === "error") {
        const problem = result.error ?? "The model failed.";
        if (request.initialTurn && OPENCODE_OUTPUT_REJECTION.test(problem)) throw new InvalidWalkthroughError([problem]);
        throw new Error(problem);
      }
      return result.lastMessage ?? "";
    },
    async stop() {
      // The SDK exposes no turn cancellation. Reload interrupts the session before archive closes it.
      try {
        await handle.reload();
      } catch {
        // Archive can still stop the turn if reload fails.
      }
      await dispose();
    },
    dispose,
  };
}
