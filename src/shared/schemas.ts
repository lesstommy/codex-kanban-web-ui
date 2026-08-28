import { z } from "zod";

export const USER_POST_LIMIT = 500;
export const THREAD_NAME_LIMIT = 80;
export const THREAD_FOLDER_LIMIT = 4096;
export const BULK_IMPORT_MAX_ROWS = 100;
export const BULK_IMPORT_CSV_LIMIT = 200_000;
export const DEFAULT_THREAD_FOLDER = "默认";
export const ROLE_INIT_INSTRUCTION_LIMIT = 2000;
export const CODEX_THREAD_PREFIX_LIMIT = 40;
export const CODEX_SYSTEM_PROMPT_LIMIT = 4000;
export const EXTERNAL_TASK_KEY_LIMIT = 120;
export const PRESET_PROJECT_ID_LIMIT = 80;
export const PRESET_PROJECT_NAME_LIMIT = 60;
export const PRESET_PROJECT_LIMIT = 30;
export const TASK_ROLE_VALUES = ["se", "art", "design", "music", "general"] as const;
export const DEFAULT_CODEX_SYSTEM_PROMPT = [
  "你是 Tweet-Native AI Harness 后台拉起的本地 Codex Agent。",
  "请在当前工作区内执行用户任务。优先完成已经明确的部分；如果信息不足但仍可推进，请说明你的假设。",
  "最终回复要面向用户，简洁说明做了什么、结果是什么、是否有未完成事项。"
].join("\n");

const emptyRoleInitialInstructions = {
  se: "",
  art: "",
  design: "",
  music: "",
  general: ""
};

export const threadStatusSchema = z.enum([
  "queued",
  "accepted",
  "researching",
  "running",
  "waiting_for_input",
  "delivered",
  "failed",
  "cancelled"
]);

export const boardStageSchema = z.enum(["ready", "wip", "review", "done"]);

export const boardDisplaySchema = z.enum(["auto", "shown", "hidden"]);

export const taskRoleSchema = z.enum(TASK_ROLE_VALUES);

export const runStatusSchema = z.enum(["queued", "running", "completed", "failed", "cancelled"]);

export const postStatusSchema = z.enum([
  "submitted",
  "queued",
  "accepted",
  "working",
  "long_running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled"
]);

export const runPhaseSchema = z.enum([
  "normalize",
  "ack",
  "execute",
  "question",
  "deliver",
  "complete",
  "failed"
]);

export const replyTypeSchema = z.enum(["ack", "progress", "question", "result", "failure"]);

const trimmedText = (limit: number, emptyMessage: string) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      return value.trim();
    },
    z.string().min(1, emptyMessage).max(limit)
  );

const optionalTrimmedText = (limit: number) =>
  z.preprocess(
    (value) => {
      if (typeof value !== "string") {
        return value;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
    z.string().min(1).max(limit).optional()
  );

export const createThreadInputSchema = z.object({
  name: trimmedText(THREAD_NAME_LIMIT, "请输入线程名称"),
  folder: trimmedText(THREAD_FOLDER_LIMIT, "请选择线程文件夹"),
  role: taskRoleSchema.default("general"),
  presetProjectId: optionalTrimmedText(PRESET_PROJECT_ID_LIMIT)
});

export const createPostInputSchema = z.object({
  body: z.string().trim().min(1, "请输入任务内容").max(USER_POST_LIMIT, "任务帖子不能超过 500 字"),
  refs: z
    .array(
      z.object({
        refType: z.enum(["file", "url", "thread", "tag", "workspace"]),
        refValue: z.string().trim().min(1),
        metadata: z.record(z.string(), z.unknown()).optional()
      })
    )
    .default([])
});

export const createTaskThreadInputSchema = createThreadInputSchema.merge(createPostInputSchema);

export const createTaskThreadApiInputSchema = createTaskThreadInputSchema.extend({
  boardDisplay: boardDisplaySchema.optional(),
  externalTaskKey: optionalTrimmedText(EXTERNAL_TASK_KEY_LIMIT)
});

export const batchCreateTaskThreadItemInputSchema = z.object({
  name: trimmedText(THREAD_NAME_LIMIT, "请输入线程名称"),
  role: taskRoleSchema.default("general"),
  body: z.string().trim().min(1, "请输入任务内容").max(USER_POST_LIMIT, "任务帖子不能超过 500 字"),
  externalTaskKey: optionalTrimmedText(EXTERNAL_TASK_KEY_LIMIT)
});

export const batchCreateTaskThreadsInputSchema = z.object({
  folder: trimmedText(THREAD_FOLDER_LIMIT, "请选择线程文件夹"),
  presetProjectId: optionalTrimmedText(PRESET_PROJECT_ID_LIMIT),
  boardDisplay: boardDisplaySchema.optional(),
  tasks: z.array(batchCreateTaskThreadItemInputSchema).min(1, "至少提供一个任务").max(BULK_IMPORT_MAX_ROWS)
});

export const updateBoardStageInputSchema = z.object({
  boardStage: boardStageSchema
});

export const updateBoardDisplayInputSchema = z.object({
  boardDisplay: boardDisplaySchema
});

export const updateBacklogTaskInputSchema = z.object({
  name: trimmedText(THREAD_NAME_LIMIT, "请输入线程名称"),
  role: taskRoleSchema.default("general"),
  body: z.string().trim().min(1, "请输入任务内容").max(USER_POST_LIMIT, "任务帖子不能超过 500 字")
});

export const bulkImportBacklogInputSchema = z.object({
  folder: trimmedText(THREAD_FOLDER_LIMIT, "请选择导入文件夹"),
  presetProjectId: optionalTrimmedText(PRESET_PROJECT_ID_LIMIT),
  csv: z.string().trim().min(1, "请提供 CSV 内容").max(BULK_IMPORT_CSV_LIMIT, "CSV 内容过长")
});

export const updateBoardAutomationInputSchema = z.object({
  enabled: z.boolean()
});

export const roleInitialInstructionsSchema = z.object({
  se: z.string().trim().max(ROLE_INIT_INSTRUCTION_LIMIT).default(""),
  art: z.string().trim().max(ROLE_INIT_INSTRUCTION_LIMIT).default(""),
  design: z.string().trim().max(ROLE_INIT_INSTRUCTION_LIMIT).default(""),
  music: z.string().trim().max(ROLE_INIT_INSTRUCTION_LIMIT).default(""),
  general: z.string().trim().max(ROLE_INIT_INSTRUCTION_LIMIT).default("")
});

export const presetProjectInputSchema = z.object({
  id: optionalTrimmedText(PRESET_PROJECT_ID_LIMIT),
  name: trimmedText(PRESET_PROJECT_NAME_LIMIT, "请输入预设项目名称"),
  folder: trimmedText(THREAD_FOLDER_LIMIT, "请选择预设项目目录"),
  roleInitialInstructions: roleInitialInstructionsSchema.default(emptyRoleInitialInstructions)
});

export const updateAppSettingsInputSchema = z.object({
  autoRunIntervalMinutes: z.number().int().min(1).max(10),
  maxConcurrentTasks: z.number().int().min(1).max(5),
  codexThreadPrefix: z.string().trim().max(CODEX_THREAD_PREFIX_LIMIT),
  systemPrompt: z.string().trim().max(CODEX_SYSTEM_PROMPT_LIMIT).default(DEFAULT_CODEX_SYSTEM_PROMPT),
  presetProjects: z.array(presetProjectInputSchema).max(PRESET_PROJECT_LIMIT).default([])
});

export const loginInputSchema = z.object({
  username: z.string().trim().min(1, "请输入账户").max(80, "账户过长"),
  password: z.string().min(1, "请输入访问密码").max(512, "访问密码过长")
});

export type CreateThreadInput = z.infer<typeof createThreadInputSchema>;
export type CreateThreadRequest = z.input<typeof createThreadInputSchema>;
export type CreateTaskThreadInput = z.infer<typeof createTaskThreadInputSchema>;
export type CreateTaskThreadRequest = z.input<typeof createTaskThreadInputSchema>;
export type CreateTaskThreadApiInput = z.infer<typeof createTaskThreadApiInputSchema>;
export type CreateTaskThreadApiRequest = z.input<typeof createTaskThreadApiInputSchema>;
export type CreatePostInput = z.infer<typeof createPostInputSchema>;
export type CreatePostRequest = z.input<typeof createPostInputSchema>;
export type LoginInput = z.infer<typeof loginInputSchema>;
export type LoginRequest = z.input<typeof loginInputSchema>;
export type ThreadStatus = z.infer<typeof threadStatusSchema>;
export type BoardStage = z.infer<typeof boardStageSchema>;
export type BoardDisplay = z.infer<typeof boardDisplaySchema>;
export type TaskRole = z.infer<typeof taskRoleSchema>;
export const DEFAULT_TASK_ROLE: TaskRole = "general";
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunPhase = z.infer<typeof runPhaseSchema>;
export type ReplyType = z.infer<typeof replyTypeSchema>;
export type PostStatus = z.infer<typeof postStatusSchema>;
export type UpdateBoardStageInput = z.infer<typeof updateBoardStageInputSchema>;
export type UpdateBoardStageRequest = z.input<typeof updateBoardStageInputSchema>;
export type UpdateBoardDisplayInput = z.infer<typeof updateBoardDisplayInputSchema>;
export type UpdateBoardDisplayRequest = z.input<typeof updateBoardDisplayInputSchema>;
export type UpdateBacklogTaskInput = z.infer<typeof updateBacklogTaskInputSchema>;
export type UpdateBacklogTaskRequest = z.input<typeof updateBacklogTaskInputSchema>;
export type BulkImportBacklogInput = z.infer<typeof bulkImportBacklogInputSchema>;
export type BulkImportBacklogRequest = z.input<typeof bulkImportBacklogInputSchema>;
export type BatchCreateTaskThreadItemInput = z.infer<typeof batchCreateTaskThreadItemInputSchema>;
export type BatchCreateTaskThreadsInput = z.infer<typeof batchCreateTaskThreadsInputSchema>;
export type BatchCreateTaskThreadsRequest = z.input<typeof batchCreateTaskThreadsInputSchema>;
export type UpdateBoardAutomationInput = z.infer<typeof updateBoardAutomationInputSchema>;
export type UpdateBoardAutomationRequest = z.input<typeof updateBoardAutomationInputSchema>;
export type PresetProjectInput = z.infer<typeof presetProjectInputSchema>;
export type RoleInitialInstructions = z.infer<typeof roleInitialInstructionsSchema>;
export type UpdateAppSettingsInput = z.infer<typeof updateAppSettingsInputSchema>;
export type UpdateAppSettingsRequest = z.input<typeof updateAppSettingsInputSchema>;

export const codexJsonLineSchema = z.record(z.string(), z.unknown());
