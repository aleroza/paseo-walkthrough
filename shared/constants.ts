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

// The limits the model is asked to respect and the normalizer enforces.
export const MAX_CHAPTERS = 6;
export const MAX_STOPS = 16;
export const MAX_HUNKS_PER_STOP = 14;
export const MAX_CHAPTER_TITLE_CHARS = 24;
export const MAX_OBSERVATIONS = 6;
export const MAX_OBSERVATIONS_PER_STOP = 2;
export const MAX_ROUTINE_NOTES = 200;

/** How many times the model is asked: the first answer and two retries. */
export const MAX_MODEL_ATTEMPTS = 3;

export const DEFAULT_LANGUAGE = "en";

export const LANGUAGE_NAMES: Record<WalkthroughLanguage, string> = {
  en: "English",
  de: "German",
  fr: "French",
  nl: "Dutch",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  uk: "Ukrainian",
  es: "Spanish",
  "pt-BR": "Brazilian Portuguese",
  ko: "Korean",
  pl: "Polish",
  ja: "Japanese",
  tr: "Turkish",
  ar: "Arabic",
  he: "Hebrew",
};
