import { z } from "zod";

const ValueAnchor = z.object({
  name: z.string().min(1, "value_anchor.name must be non-empty"),
  priority: z.number().int().positive("value_anchor.priority must be a positive integer"),
});

export const LearnedBlockSchema = z.object({
  pattern: z.string().min(1, "learned_block.pattern must be non-empty"),
  reason: z.string().min(1, "learned_block.reason must be non-empty"),
  source_session: z.string().min(1, "learned_block.source_session must be non-empty"),
});

const Metadata = z.object({
  created_at: z.string().datetime({ offset: true, message: "metadata.created_at must be ISO-8601 datetime" }),
  last_session_at: z
    .string()
    .datetime({ offset: true, message: "metadata.last_session_at must be ISO-8601 datetime" })
    .optional(),
  session_count: z.number().int().nonnegative("metadata.session_count must be a non-negative integer"),
});

export const ActiveProjectSchema = z
  .object({
    id: z.string().min(1, "active_project.id must be non-empty"),
    root: z.string().min(1, "active_project.root must be non-empty"),
    role: z.string().min(1, "active_project.role must be non-empty").optional(),
    current_focus: z.string().min(1, "active_project.current_focus must be non-empty").optional(),
    space: z.string().min(1, "active_project.space must be non-empty").optional(),
    view: z.string().min(1, "active_project.view must be non-empty").optional(),
    last_seen_at: z
      .string()
      .datetime({ offset: true, message: "active_project.last_seen_at must be ISO-8601 datetime" })
      .optional(),
  })
  .strict();

export const CredentialRefSchema = z
  .object({
    name: z.string().min(1, "credential_ref.name must be non-empty"),
    kind: z.enum(["env", "keychain", "onepassword", "file", "other"]),
    ref: z.string().min(1, "credential_ref.ref must be non-empty"),
    scope: z.string().min(1, "credential_ref.scope must be non-empty").optional(),
    expires_at: z
      .string()
      .datetime({ offset: true, message: "credential_ref.expires_at must be ISO-8601 datetime" })
      .nullable()
      .optional(),
  })
  .strict()
  .superRefine((credential, ctx) => {
    if (credential.kind === "env" && !credential.ref.startsWith("env:")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ref"],
        message: "env credential refs must start with env:",
      });
    }
  });

export const ContinuityStateSchema = z
  .object({
    current_focus: z.string().min(1, "continuity.current_focus must be non-empty").optional(),
    handoff: z.string().min(1, "continuity.handoff must be non-empty").optional(),
    next_actions: z.array(z.string().min(1, "continuity.next_actions entries must be non-empty")).default([]),
    open_threads: z.array(z.string().min(1, "continuity.open_threads entries must be non-empty")).default([]),
    updated_at: z
      .string()
      .datetime({ offset: true, message: "continuity.updated_at must be ISO-8601 datetime" })
      .optional(),
  })
  .strict();

export const PassportSchemaV1 = z
  .object({
    version: z.literal("1.0"),
    agent_id: z.string().min(1, "agent_id must be non-empty"),
    name: z.string().min(1, "name must be non-empty"),
    purpose: z.string().min(1, "purpose must be non-empty"),
    issued_by: z
      .string()
      .min(1, "issued_by must be non-empty when present")
      .optional(),
    autonomous: z.boolean().optional(),
    core_commitments: z.array(z.string().min(1, "core_commitments entries must be non-empty")),
    value_anchors: z.array(ValueAnchor),
    competencies: z.array(z.string().min(1, "competencies entries must be non-empty")),
    limits: z.array(z.string().min(1, "limits entries must be non-empty")),
    learned_blocks: z.array(LearnedBlockSchema),
    active_projects: z.array(ActiveProjectSchema).optional(),
    credential_refs: z.array(CredentialRefSchema).optional(),
    continuity: ContinuityStateSchema.optional(),
    metadata: Metadata,
  })
  .strict()
  .superRefine((p, ctx) => {
    const priorities = p.value_anchors.map((a) => a.priority);
    if (new Set(priorities).size !== priorities.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value_anchors"],
        message: "value_anchors priorities must be unique",
      });
    }
    const names = p.value_anchors.map((a) => a.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["value_anchors"],
        message: "value_anchors names must be unique",
      });
    }
    const projectIds = (p.active_projects ?? []).map((project) => project.id);
    if (new Set(projectIds).size !== projectIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["active_projects"],
        message: "active_projects ids must be unique",
      });
    }
    const credentialNames = (p.credential_refs ?? []).map((credential) => credential.name);
    if (new Set(credentialNames).size !== credentialNames.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credential_refs"],
        message: "credential_refs names must be unique",
      });
    }
    if (p.issued_by === p.agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issued_by"],
        message: "issued_by must not equal agent_id (use omitting issued_by to indicate a root principal)",
      });
    }
  });

export const PassportSchema = PassportSchemaV1;

export type Passport = z.infer<typeof PassportSchema>;
export type LearnedBlock = z.infer<typeof LearnedBlockSchema>;
export type ActiveProject = z.infer<typeof ActiveProjectSchema>;
export type CredentialRef = z.infer<typeof CredentialRefSchema>;
export type ContinuityState = z.infer<typeof ContinuityStateSchema>;
