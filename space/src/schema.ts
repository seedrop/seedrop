import { z } from "zod";

const IsoDateTime = z.string().datetime({ offset: true });
const NonEmptyString = z.string().min(1);
const RelativePath = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "path must be relative and may not contain '..'",
  });

export const FileKindSchema = z.enum(["source", "test", "doc", "config", "data", "asset", "other"]);

export const ManifestFileSchema = z
  .object({
    path: RelativePath,
    kind: FileKindSchema,
    size_bytes: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    purpose: z.string().min(1).optional(),
    owner: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const PathPurposeSchema = z
  .object({
    path: RelativePath,
    purpose: z.string().min(1),
    owner: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  })
  .strict();

export const PolicyPathPurposeSchema = z
  .object({
    purpose: z.string().min(1),
    owner: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    recommended_read_reason: z.string().min(1).optional(),
    recommended_read_priority: z.number().int().positive().optional(),
  })
  .strict();

export const RecommendedReadSchema = z
  .object({
    path: RelativePath,
    reason: z.string().min(1),
    priority: z.number().int().positive(),
  })
  .strict();

export const WorkspaceManifestSchema = z
  .object({
    schema_version: z.literal("1.0"),
    workspace_id: z.string().min(1),
    root: z.literal("."),
    updated_at: IsoDateTime,
    files: z.array(ManifestFileSchema),
    path_purposes: z.array(PathPurposeSchema).optional(),
    recommended_reads: z.array(RecommendedReadSchema),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const paths = manifest.files.map((file) => file.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["files"],
        message: "manifest file paths must be unique",
      });
    }
  });

export const ContinuityValidationSchema = z
  .object({
    status: z.enum(["passed", "failed", "skipped", "unknown"]),
    commands: z.array(z.string().min(1)),
    notes: z.string().min(1).optional(),
  })
  .strict();

export const PacketGitStatusSchema = z
  .object({
    is_repo: z.boolean(),
    is_dirty: z.boolean(),
    uncommitted_count: z.number().int().nonnegative(),
    uncommitted_paths: z.array(z.string().min(1)).max(50).optional(),
  })
  .strict();

export const ContinuityPacketSchema = z
  .object({
    id: z.string().uuid(),
    created_at: IsoDateTime,
    agent: z.string().min(1),
    mission: z.string().min(1),
    summary: z.string().min(1),
    decisions: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
    open_threads: z.array(z.string().min(1)),
    validation: ContinuityValidationSchema,
    changed_paths: z.array(RelativePath),
    git_status: PacketGitStatusSchema.optional(),
  })
  .strict();

export const SignalSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(["claim", "lock"]),
    target: RelativePath,
    owner: z.string().min(1),
    created_at: IsoDateTime,
    expires_at: IsoDateTime,
    intent: z.string().min(1),
    recovery: z.string().min(1).optional(),
    details: z.record(z.unknown()).optional(),
  })
  .strict();

export const NextActionSchema = z
  .object({
    kind: z.enum(["command", "read", "write", "verify", "handoff", "decide"]),
    command: z.string().min(1).optional(),
    path: RelativePath.optional(),
    risk: z.enum(["low", "medium", "high"]),
    requires_human: z.boolean(),
    reason: z.string().min(1),
  })
  .strict();

export const RunValidationEntrySchema = z
  .object({
    command: z.string().min(1),
    status: z.enum(["passed", "failed", "skipped"]),
    recorded_at: IsoDateTime,
    notes: z.string().min(1).optional(),
  })
  .strict();

export const RunStepSchema = z
  .object({
    summary: z.string().min(1),
    recorded_at: IsoDateTime,
    changed_paths: z.array(RelativePath),
  })
  .strict();

export const RunJournalSchema = z
  .object({
    schema_version: z.literal("1.0"),
    run_id: z.string().uuid(),
    agent_id: z.string().min(1),
    goal: z.string().min(1),
    status: z.enum(["in_progress", "completed", "blocked", "failed"]),
    started_at: IsoDateTime,
    updated_at: IsoDateTime,
    finished_at: IsoDateTime.optional(),
    steps: z.array(RunStepSchema),
    decisions: z.array(z.string().min(1)),
    assumptions: z.array(z.string().min(1)),
    open_threads: z.array(z.string().min(1)),
    changed_paths: z.array(RelativePath),
    validation: z.array(RunValidationEntrySchema),
    next_actions: z.array(NextActionSchema),
  })
  .strict();

export const TaskStatusSchema = z.enum([
  "open",
  "claimed",
  "in_progress",
  "blocked",
  "done",
  "dropped",
]);

export const TaskSchema = z
  .object({
    schema_version: z.literal("1.0"),
    task_id: z.string().uuid(),
    title: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    status: TaskStatusSchema,
    owner: z.string().min(1).optional(),
    assigned_by: z.string().min(1).optional(),
    assigned_note: z.string().min(1).max(500).optional(),
    from_knowledge: z.string().min(1).optional(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    blocked_by: z.array(z.string().uuid()).optional(),
    related_runs: z.array(z.string().uuid()),
    related_handoffs: z.array(z.string().uuid()).optional(),
    decline_reason: z.string().min(1).max(500).optional(),
    drop_reason: z.string().min(1).max(500).optional(),
  })
  .strict();

export const HandoffSchema = z
  .object({
    schema_version: z.literal("1.0"),
    handoff_id: z.string().uuid(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    source_agent: z.string().min(1),
    recipient: z.string().min(1),
    related_run_id: z.string().uuid().optional(),
    summary: z.string().min(1),
    status: z.enum(["pending", "accepted"]),
    accepted_at: IsoDateTime.optional(),
    accepted_by: z.string().min(1).optional(),
    files_changed: z.array(RelativePath),
    validation: z.array(RunValidationEntrySchema),
    blockers: z.array(z.string().min(1)),
    risks: z.array(z.string().min(1)),
    open_threads: z.array(z.string().min(1)),
    next_actions: z.array(NextActionSchema),
  })
  .strict();

export const ViewPolicySchema = z
  .object({
    schema_version: z.literal("1.0").optional(),
    purpose: z.string().min(1).optional(),
    current_focus: z.string().min(1).optional(),
    ignore: z.array(RelativePath).optional(),
    path_purposes: z.record(PolicyPathPurposeSchema).optional(),
    freshness_ttl_hours: z.number().positive().optional(),
    required_success_level: z.enum(["L0", "L1", "L2", "L3", "L4"]).optional(),
    sensitive_paths: z.array(RelativePath).optional(),
    danger_zones: z.array(z.string().min(1)).optional(),
    preferred_verification_commands: z.array(z.string().min(1)).optional(),
    edit_policy: z.string().min(1).optional(),
    test_policy: z.string().min(1).optional(),
    handoff_policy: z.string().min(1).optional(),
    claim_policy: z.string().min(1).optional(),
    commit_policy: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((policy, ctx) => {
    for (const key of Object.keys(policy.path_purposes ?? {})) {
      const result = RelativePath.safeParse(key);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["path_purposes", key],
          message: "path purpose keys must be relative paths and may not contain '..'",
        });
      }
    }
  });

export const SpaceLifecycleSchema = z.enum(["open", "active", "ended", "archived"]);

export const SpaceMemberSchema = z
  .object({
    passport_id: NonEmptyString,
    joined_at: IsoDateTime,
    left_at: IsoDateTime.optional(),
  })
  .strict();

export const SpaceMetaSchema = z
  .object({
    schema_version: z.literal("1.0"),
    id: NonEmptyString,
    name: NonEmptyString,
    lifecycle: SpaceLifecycleSchema,
    members: z.array(SpaceMemberSchema),
    created_at: IsoDateTime,
    ended_at: IsoDateTime.nullable(),
    archived_at: IsoDateTime.nullable(),
  })
  .strict()
  .superRefine((space, ctx) => {
    if ((space.lifecycle === "ended" || space.lifecycle === "archived") && space.ended_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ended_at"],
        message: "ended_at is required when lifecycle is ended or archived",
      });
    }
    if (space.lifecycle === "archived" && space.archived_at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archived_at"],
        message: "archived_at is required when lifecycle is archived",
      });
    }
  });

export const MessageRoleSchema = z.enum(["agent", "human", "system"]);

export const MessageSchema = z
  .object({
    schema_version: z.literal("1.0"),
    id: NonEmptyString,
    space_id: NonEmptyString,
    author_passport_id: NonEmptyString,
    /**
     * Chain of principals from the immediate author back to the root operator.
     * Index 0 is the author; the last entry is the root principal (or autonomous).
     * Optional for backward compat with messages written before the field existed.
     */
    principal_chain: z.array(NonEmptyString).optional(),
    author_autonomous: z.boolean().optional(),
    role: MessageRoleSchema,
    created_at: IsoDateTime,
    content: NonEmptyString,
    replaces: NonEmptyString.optional(),
    tombstone: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const NotificationPointerSchema = z
  .object({
    kind: NonEmptyString,
    ref: NonEmptyString,
  })
  .strict();

export const NotificationSchema = z
  .object({
    schema_version: z.literal("1.0"),
    id: NonEmptyString,
    recipient_passport_id: NonEmptyString,
    sender_passport_id: NonEmptyString,
    created_at: IsoDateTime,
    expires_at: IsoDateTime,
    pointer: NotificationPointerSchema,
    acked_at: IsoDateTime.nullable(),
  })
  .strict();

export const SessionSchema = z
  .object({
    schema_version: z.literal("1.0"),
    id: NonEmptyString,
    passport_id: NonEmptyString,
    space_id: NonEmptyString.optional(),
    created_at: IsoDateTime,
    last_seen_at: IsoDateTime,
    working_on: NonEmptyString.optional(),
  })
  .strict();

export const PresenceRecordSchema = SessionSchema.extend({
  online: z.boolean(),
});

export type FileKind = z.infer<typeof FileKindSchema>;
export type ManifestFile = z.infer<typeof ManifestFileSchema>;
export type PathPurpose = z.infer<typeof PathPurposeSchema>;
export type PolicyPathPurpose = z.infer<typeof PolicyPathPurposeSchema>;
export type RecommendedRead = z.infer<typeof RecommendedReadSchema>;
export type WorkspaceManifest = z.infer<typeof WorkspaceManifestSchema>;
export type ContinuityValidation = z.infer<typeof ContinuityValidationSchema>;
export type ContinuityPacket = z.infer<typeof ContinuityPacketSchema>;
export type Signal = z.infer<typeof SignalSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
export type RunValidationEntry = z.infer<typeof RunValidationEntrySchema>;
export type RunStep = z.infer<typeof RunStepSchema>;
export type RunJournal = z.infer<typeof RunJournalSchema>;
export type Handoff = z.infer<typeof HandoffSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type ViewPolicy = z.infer<typeof ViewPolicySchema>;
export type SpaceLifecycle = z.infer<typeof SpaceLifecycleSchema>;
export type SpaceMember = z.infer<typeof SpaceMemberSchema>;
export type SpaceMeta = z.infer<typeof SpaceMetaSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type NotificationPointer = z.infer<typeof NotificationPointerSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type PresenceRecord = z.infer<typeof PresenceRecordSchema>;
