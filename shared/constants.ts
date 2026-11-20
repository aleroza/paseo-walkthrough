import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const WALKTHROUGH_SCOPE = ["all", "staged", "unstaged", "branch", "commit"] as const;
export type WalkthroughScope = (typeof WALKTHROUGH_SCOPE)[number];

export const PLUGIN_ID = "walkthrough";
export const PANEL_ID = "walkthrough";

export const CHAPTER_ICONS = ["bug", "wrench", "path", "flask", "doc", "gear"] as const;
export const STOP_IMPORTANCE = ["critical", "normal", "context"] as const;
export const OBSERVATION_KINDS = ["decision", "cost", "limitation", "asymmetry", "unproven"] as const;

export const LANGUAGES = [
  "en",
  "de",
  "fr",
  "nl",
  "zh-CN",
  "zh-TW",
  "uk",
  "es",
  "pt-BR",
  "ko",
  "pl",
  "ja",
  "tr",
  "ar",
  "he",
] as const;
export type WalkthroughLanguage = (typeof LANGUAGES)[number];

export const JOB_STATES = [
  "collecting",
  "asking",
  "retrying",
  "assembling",
  "done",
  "failed",
  "cancelled",
] as const;
export type WalkthroughJobState = (typeof JOB_STATES)[number];
