import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  commitOptionSchema,
  diffSchema,
  jobStatusSchema,
  modelOptionSchema,
  sourceRequestSchema,
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

export const commitsRpc = defineRpc({
  name: "walkthrough.commits",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    commits: z.array(commitOptionSchema),
    repository: z.boolean().nullable().default(null),
    error: z.string().nullable(),
  }),
});

export const generateRpc = defineRpc({
  name: "walkthrough.generate",
  input: sourceRequestSchema.extend({
    scope: sourceRequestSchema.shape.scope.unwrap().optional(),
    model: z.string().nullable().optional(),
    language: z.string().nullable().default(null),
    force: z.boolean().optional(),
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
