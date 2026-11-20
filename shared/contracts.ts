import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  diffSchema,
  documentSchema,
  jobStatusSchema,
  modelOptionSchema,
  sourceRequestSchema,
  stalenessSchema,
  workspaceSettingsSchema,
} from "./types";

export const diffRpc = defineRpc({
  name: "walkthrough.diff",
  input: sourceRequestSchema,
  output: z.object({
    diff: diffSchema.nullable(),
    error: z.string().nullable(),
    /** The base the branch source compared against, when it detected one. */
    base: z.string().nullable().default(null),
  }),
});

export const generateRpc = defineRpc({
  name: "walkthrough.generate",
  input: sourceRequestSchema.extend({
    model: z.string().nullable().default(null),
    language: z.string().default("en"),
  }),
  output: z.object({
    jobId: z.string(),
  }),
});

export const statusRpc = defineRpc({
  name: "walkthrough.status",
  input: z.object({
    workspaceId: z.string(),
    jobId: z.string().nullable().default(null),
  }),
  output: jobStatusSchema,
});

export const cancelRpc = defineRpc({
  name: "walkthrough.cancel",
  input: z.object({
    workspaceId: z.string(),
    jobId: z.string(),
  }),
  output: z.object({
    cancelled: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const modelsRpc = defineRpc({
  name: "walkthrough.models",
  input: z.object({
    workspaceId: z.string(),
  }),
  output: z.object({
    models: z.array(modelOptionSchema),
    error: z.string().nullable(),
  }),
});

export const settingsRpc = defineRpc({
  name: "walkthrough.settings",
  input: z.object({
    workspaceId: z.string(),
  }),
  output: z.object({
    settings: workspaceSettingsSchema,
  }),
});

export const saveSettingsRpc = defineRpc({
  name: "walkthrough.settings.save",
  input: z.object({
    workspaceId: z.string(),
    settings: workspaceSettingsSchema,
  }),
  output: z.object({
    settings: workspaceSettingsSchema,
  }),
});

export const documentRpc = defineRpc({
  name: "walkthrough.document",
  input: z.object({
    workspaceId: z.string(),
  }),
  output: z.object({
    document: documentSchema.nullable(),
    staleness: stalenessSchema.nullable(),
  }),
});
