import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { researchConfigurationSchema, researchModeSchema, researchSettingsPatchSchema, researchSettingsSchema } from "./research/research";
import { modelRoleSchema, roleSchema } from "./core/roles";
import { managedThreadSchema, modelConfigurationSchema, modelSelectionSchema } from "./types";

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({ sectionId: z.string().nullable(), threads: z.array(managedThreadSchema) }),
  },
  start: {
    input: z.object({ projectId: z.string().trim().min(1).nullable() }).strict(),
    output: z.object({ threadId: z.string(), created: z.boolean() }).strict(),
  },
  create: {
    input: z.object({ projectId: z.string().trim().min(1) }).strict(),
    output: z.object({ threadId: z.string(), created: z.literal(true) }).strict(),
  },
  modelConfiguration: {
    input: z.null(),
    output: modelConfigurationSchema,
  },
  researchConfiguration: {
    input: z.null(),
    output: researchConfigurationSchema,
  },
  setResearchModel: {
    input: z.object({
      hostId: z.string().trim().min(1),
      mode: researchModeSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  setResearchSettings: {
    input: researchSettingsPatchSchema,
    output: researchSettingsSchema,
  },
  setRoleModel: {
    input: z.object({
      hostId: z.string().trim().min(1),
      role: modelRoleSchema,
      selection: modelSelectionSchema.nullable(),
    }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  role: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({ role: roleSchema.nullable() }).strict(),
  },
});
