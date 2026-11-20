import type { PluginHandlerContext } from "@getpaseo/plugin/server";

// Host types come from the SDK specifiers only: Paseo's compiler fails on a type-only import it cannot resolve.
export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgentHandle = Awaited<ReturnType<PaseoApi["agents"]["create"]>>;
export type PaseoAgentCreateOptions = Parameters<PaseoApi["agents"]["create"]>[0];
