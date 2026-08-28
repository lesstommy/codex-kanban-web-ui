import { createHash } from "node:crypto";
import { ObjectId, type ClientSession, type MongoClient } from "mongodb";
import {
  CODEX_THREAD_PREFIX_LIMIT,
  CODEX_SYSTEM_PROMPT_LIMIT,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  PRESET_PROJECT_ID_LIMIT,
  PRESET_PROJECT_LIMIT,
  PRESET_PROJECT_NAME_LIMIT,
  type BoardDisplay,
  type BoardStage,
  type BatchCreateTaskThreadItemInput,
  type CreatePostInput,
  type CreateTaskThreadInput,
  DEFAULT_TASK_ROLE,
  type PostStatus,
  type ReplyType,
  type RoleInitialInstructions,
  type RunPhase,
  type RunStatus,
  type PresetProjectInput,
  type TaskRole,
  type ThreadStatus,
  type UpdateAppSettingsInput,
  type UpdateBacklogTaskInput
} from "../shared/schemas";
import type {
  AppSettingsDto,
  BoardAutomationDto,
  BulkImportBacklogRowDto,
  PresetProjectDto,
  TaskHeartbeatDto,
  TaskHeartbeatState,
  ThreadDetailDto,
  ThreadListItemDto
} from "../shared/types";
import type { Collections } from "./db";
import type {
  AppSettingsDoc,
  ArtifactDoc,
  BoardAutomationDoc,
  EventDoc,
  PostDoc,
  RunDoc,
  TaskDoc,
  TaskVersionDoc,
  ThreadDoc
} from "./models";
import { buildAckBody, normalizeTaskPost } from "./normalizer";
import { generatePublicTaskId, normalizePublicTaskId } from "./publicTaskId";
import {
  serializeArtifact,
  serializePost,
  serializeRun,
  serializeTask,
  serializeTaskVersion,
  serializeThread
} from "./serializers";

const TASK_LONG_RUNNING_MS = 30 * 60 * 1000;
const TASK_STALE_MS = 30 * 60 * 1000;
export const BOARD_AUTOMATION_ID = "board_automation";
export const BOARD_AUTOMATION_WIP_LIMIT = 5;
export const BOARD_AUTOMATION_INTERVAL_MS = 5 * 60 * 1000;
export const APP_SETTINGS_ID = "app_settings";
const BOARD_READY_AUTO_DISPLAY_LIMIT = 10;
const APP_SETTINGS_INTERVAL_MINUTES_DEFAULT = 5;
const APP_SETTINGS_MAX_CONCURRENT_TASKS_DEFAULT = 5;
const APP_SETTINGS_CODEX_THREAD_PREFIX_DEFAULT = "[Harness]";

export interface CreatedTaskBundle {
  thread: ThreadDoc;
  rootPost: PostDoc;
  task: TaskDoc;
  run: RunDoc;
  created: boolean;
}

export interface CreatedReplyRunBundle {
  thread: ThreadDoc;
  post: PostDoc;
  task: TaskDoc;
  run: RunDoc;
}

export interface ImportedBacklogTaskBundle {
  thread: ThreadDoc;
  rootPost: PostDoc;
  task: TaskDoc;
  run: RunDoc;
  created: boolean;
}

export interface CreateTaskThreadOptions extends CreateTaskThreadInput {
  boardDisplay?: BoardDisplay;
  externalTaskSource?: string;
  externalTaskKey?: string;
}

export interface AgentPostInput {
  threadId: ObjectId;
  taskId: ObjectId;
  runId: ObjectId;
  parentPostId?: ObjectId;
  replyType: ReplyType;
  body: string;
  artifactIds?: ObjectId[];
}

export class RepositoryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConflictError";
  }
}

export interface BoardStageTransitionResult {
  thread: ThreadDoc;
  task?: TaskDoc;
  run?: RunDoc;
  started: boolean;
}

export interface ReadyColumnStartCandidate {
  thread: ThreadDoc;
  task: TaskDoc;
  run: RunDoc;
}

export interface BoardAutomationSnapshot {
  readyColumnThreads: ThreadDoc[];
  startCandidates: ReadyColumnStartCandidate[];
  wipCount: number;
  availableSlots: number;
}

function defaultRoleInitialInstructions(): RoleInitialInstructions {
  return {
    se: "",
    art: "",
    design: "",
    music: "",
    general: ""
  };
}

function clampAutoRunIntervalMinutes(value: number | undefined): number {
  const rounded = Math.floor(value ?? APP_SETTINGS_INTERVAL_MINUTES_DEFAULT);
  return Math.max(1, Math.min(10, rounded || APP_SETTINGS_INTERVAL_MINUTES_DEFAULT));
}

function clampMaxConcurrentTasks(value: number | undefined): number {
  const rounded = Math.floor(value ?? APP_SETTINGS_MAX_CONCURRENT_TASKS_DEFAULT);
  return Math.max(1, Math.min(5, rounded || APP_SETTINGS_MAX_CONCURRENT_TASKS_DEFAULT));
}

function trimRoleInstruction(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRoleInitialInstructions(input?: Partial<Record<TaskRole, unknown>>): RoleInitialInstructions {
  const defaults = defaultRoleInitialInstructions();
  return {
    se: trimRoleInstruction(input?.se ?? defaults.se),
    art: trimRoleInstruction(input?.art ?? defaults.art),
    design: trimRoleInstruction(input?.design ?? defaults.design),
    music: trimRoleInstruction(input?.music ?? defaults.music),
    general: trimRoleInstruction(input?.general ?? defaults.general)
  };
}

function normalizeCodexThreadPrefix(value: unknown): string {
  if (typeof value !== "string") {
    return APP_SETTINGS_CODEX_THREAD_PREFIX_DEFAULT;
  }
  return value.trim().slice(0, CODEX_THREAD_PREFIX_LIMIT);
}

function normalizeSystemPrompt(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_CODEX_SYSTEM_PROMPT;
  }
  return value.trim().slice(0, CODEX_SYSTEM_PROMPT_LIMIT);
}

function normalizePresetProjects(input: unknown): PresetProjectDto[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();
  const projects: PresetProjectDto[] = [];
  for (const item of input.slice(0, PRESET_PROJECT_LIMIT)) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const project = item as Partial<PresetProjectInput>;
    const name = typeof project.name === "string" ? project.name.trim().slice(0, PRESET_PROJECT_NAME_LIMIT) : "";
    const folder = typeof project.folder === "string" ? project.folder.trim() : "";
    if (!name || !folder) {
      continue;
    }
    const pairKey = `${name}\0${folder}`;
    if (seenPairs.has(pairKey)) {
      continue;
    }
    seenPairs.add(pairKey);

    const rawId = typeof project.id === "string" ? project.id.trim() : "";
    const baseId = (rawId || stablePresetProjectId(name, folder)).slice(0, PRESET_PROJECT_ID_LIMIT);
    const id = uniquePresetProjectId(baseId, seenIds);
    seenIds.add(id);
    const roleInitialInstructions = normalizeRoleInitialInstructions(
      project.roleInitialInstructions as Partial<Record<TaskRole, unknown>> | undefined
    );
    projects.push({ id, name, folder, roleInitialInstructions });
  }
  return projects;
}

function stablePresetProjectId(name: string, folder: string): string {
  const digest = createHash("sha256").update(`${name}\0${folder}`).digest("hex").slice(0, 12);
  return `preset-${digest}`;
}

function uniquePresetProjectId(baseId: string, seenIds: Set<string>): string {
  const fallback = baseId || "preset";
  if (!seenIds.has(fallback)) {
    return fallback;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${fallback.slice(0, Math.max(1, PRESET_PROJECT_ID_LIMIT - suffix.length))}${suffix}`;
    if (!seenIds.has(candidate)) {
      return candidate;
    }
  }
  return `${fallback.slice(0, Math.max(1, PRESET_PROJECT_ID_LIMIT - 13))}-${Date.now().toString(36)}`;
}

function presetProjectsEqual(left: PresetProjectDto[] | undefined, right: PresetProjectDto[]): boolean {
  if (!left || left.length !== right.length) {
    return false;
  }
  return right.every((project, index) => {
    const current = left[index];
    return (
      current?.id === project.id &&
      current.name === project.name &&
      current.folder === project.folder &&
      Object.entries(project.roleInitialInstructions).every(
        ([role, value]) => current.roleInitialInstructions?.[role as TaskRole] === value
      )
    );
  });
}

function isDuplicateExternalTaskKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 11000;
}

export class HarnessRepository {
  constructor(
    private readonly client: MongoClient,
    readonly collections: Collections
  ) {}

  async createTaskThread(input: CreateTaskThreadOptions): Promise<CreatedTaskBundle> {
    return this.createTaskThreadInternal(input);
  }

  async createTaskThreadsBatch(input: {
    folder: string;
    presetProjectId?: string;
    boardDisplay?: BoardDisplay;
    externalTaskSource?: string;
    tasks: BatchCreateTaskThreadItemInput[];
  }): Promise<CreatedTaskBundle[]> {
    const items: CreatedTaskBundle[] = [];
    for (const task of input.tasks) {
      items.push(
        await this.createTaskThreadInternal({
          folder: input.folder,
          presetProjectId: input.presetProjectId,
          boardDisplay: input.boardDisplay,
          externalTaskSource: input.externalTaskSource,
          externalTaskKey: task.externalTaskKey,
          name: task.name,
          role: task.role,
          body: task.body,
          refs: []
        })
      );
    }
    return items;
  }

  private async createTaskThreadInternal(input: CreateTaskThreadOptions): Promise<CreatedTaskBundle> {
    if (input.externalTaskSource && input.externalTaskKey) {
      const existing = await this.findExistingTaskBundleByExternalRef(input.externalTaskSource, input.externalTaskKey);
      if (existing) {
        return {
          ...existing,
          created: false
        };
      }
    }

    const normalized = normalizeTaskPost(input.body);
    const now = new Date();
    const threadId = new ObjectId();
    const rootPostId = new ObjectId();
    const taskId = new ObjectId();
    const versionId = new ObjectId();
    const runId = new ObjectId();
    const refIds = input.refs.map(() => new ObjectId());
    const publicTaskId = await this.nextPublicTaskId(now);
    const taskSpec = { ...normalized.spec, role: input.role };

    const thread: ThreadDoc = {
      _id: threadId,
      publicTaskId,
      name: input.name,
      role: input.role,
      folder: input.folder,
      presetProjectId: input.presetProjectId,
      externalTaskSource: input.externalTaskSource,
      externalTaskKey: input.externalTaskKey,
      title: input.name,
      status: "queued",
      boardStage: "ready",
      boardDisplay: input.boardDisplay ?? "auto",
      currentTaskId: taskId,
      currentVersionText: normalized.summaryText,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now
    };

    const rootPost: PostDoc = {
      _id: rootPostId,
      threadId,
      authorType: "user",
      authorId: "local-user",
      postType: "root",
      status: "queued",
      runId,
      body: input.body,
      refs: refIds,
      artifactIds: [],
      visibility: "public",
      createdAt: now
    };

    const task: TaskDoc = {
      _id: taskId,
      threadId,
      rootPostId,
      intent: "work_request",
      role: input.role,
      taskSpec,
      constraints: { maxUserPostChars: 500 },
      status: "queued",
      priority: "normal",
      assignedAgent: "codex-local",
      currentRunId: runId,
      currentVersionId: versionId,
      createdAt: now,
      updatedAt: now
    };

    const run: RunDoc = {
      _id: runId,
      taskId,
      triggerPostId: rootPostId,
      agentName: "codex-local",
      status: "queued",
      phase: "normalize",
      lastEventAt: now,
      metadata: {
        source: "api.threads.create",
        role: input.role,
        ...(input.presetProjectId ? { presetProjectId: input.presetProjectId } : {}),
        ...(input.externalTaskKey ? { externalTaskKey: input.externalTaskKey } : {})
      }
    };

    const event: EventDoc = {
      _id: new ObjectId(),
      runId,
      threadId,
      taskId,
      eventType: "task_thread_created",
      payload: {
        rootPostId: rootPostId.toHexString(),
        versionId: versionId.toHexString(),
        role: input.role,
        presetProjectId: input.presetProjectId,
        externalTaskSource: input.externalTaskSource,
        externalTaskKey: input.externalTaskKey
      },
      createdAt: now
    };

    try {
      await this.client.withSession(async (session) => {
        await session.withTransaction(async () => {
          await this.collections.threads.insertOne(thread, { session });
          await this.collections.posts.insertOne(rootPost, { session });
          await this.collections.tasks.insertOne(task, { session });
          await this.collections.taskVersions.insertOne(
            {
              _id: versionId,
              taskId,
              sourcePostId: rootPostId,
              versionNumber: 1,
              summaryText: normalized.summaryText,
              spec: taskSpec,
              createdAt: now
            },
            { session }
          );
          await this.collections.runs.insertOne(run, { session });
          await this.collections.events.insertOne(event, { session });

          if (input.refs.length > 0) {
            await this.collections.contextRefs.insertMany(
              input.refs.map((ref, index) => ({
                _id: refIds[index],
                threadId,
                postId: rootPostId,
                taskId,
                refType: ref.refType,
                refValue: ref.refValue,
                metadata: ref.metadata,
                createdAt: now
              })),
              { session }
            );
          }
        });
      });
    } catch (error) {
      if (isDuplicateExternalTaskKeyError(error) && input.externalTaskSource && input.externalTaskKey) {
        const existing = await this.findExistingTaskBundleByExternalRef(input.externalTaskSource, input.externalTaskKey);
        if (existing) {
          return {
            ...existing,
            created: false
          };
        }
      }
      throw error;
    }

    return { thread, rootPost, task, run, created: true };
  }

  private async findExistingTaskBundleByExternalRef(
    externalTaskSource: string,
    externalTaskKey: string
  ): Promise<Omit<CreatedTaskBundle, "created"> | null> {
    const thread = await this.collections.threads.findOne({
      externalTaskSource,
      externalTaskKey
    });
    if (!thread?.currentTaskId) {
      return null;
    }
    const task = await this.collections.tasks.findOne({ _id: thread.currentTaskId });
    if (!task) {
      return null;
    }
    const [rootPost, run] = await Promise.all([
      this.collections.posts.findOne({ _id: task.rootPostId }),
      this.collections.runs.findOne({ _id: task.currentRunId })
    ]);
    if (!rootPost || !run) {
      return null;
    }
    return { thread, rootPost, task, run };
  }

  async createReplyRunInThread(threadId: ObjectId, input: CreatePostInput): Promise<CreatedReplyRunBundle> {
    const existingThread = await this.collections.threads.findOne({ _id: threadId });
    if (!existingThread) {
      throw new Error(`Thread not found: ${threadId.toHexString()}`);
    }
    if (!existingThread.currentTaskId) {
      throw new RepositoryConflictError("当前任务数据不完整，无法回复。");
    }

    const task = await this.collections.tasks.findOne({ _id: existingThread.currentTaskId });
    if (!task) {
      throw new Error(`Task not found for thread: ${threadId.toHexString()}`);
    }
    const currentRun = await this.collections.runs.findOne({ _id: task.currentRunId });
    if (currentRun?.status === "running") {
      throw new RepositoryConflictError("当前任务正在运行，请等待完成后再回复。");
    }

    const latestVersion = await this.collections.taskVersions
      .find({ taskId: task._id })
      .sort({ versionNumber: -1 })
      .limit(1)
      .next();
    const combinedRequest = [
      `当前任务版本：${latestVersion?.summaryText ?? existingThread.currentVersionText}`,
      `用户最新回复：${input.body}`
    ].join("\n\n");
    const normalized = normalizeTaskPost(combinedRequest);
    const taskRole = task.role ?? existingThread.role ?? DEFAULT_TASK_ROLE;
    const taskSpec = { ...normalized.spec, role: taskRole };
    const now = new Date();
    const postId = new ObjectId();
    const versionId = new ObjectId();
    const runId = new ObjectId();
    const refIds = input.refs.map(() => new ObjectId());

    const post: PostDoc = {
      _id: postId,
      threadId,
      parentPostId: task.rootPostId,
      authorType: "user",
      authorId: "local-user",
      postType: "reply",
      status: "queued",
      runId,
      body: input.body,
      refs: refIds,
      artifactIds: [],
      visibility: "public",
      createdAt: now
    };

    const updatedTask: TaskDoc = {
      ...task,
      role: taskRole,
      taskSpec,
      status: "queued",
      currentRunId: runId,
      currentVersionId: versionId,
      updatedAt: now
    };

    const run: RunDoc = {
      _id: runId,
      taskId: task._id,
      triggerPostId: postId,
      agentName: "codex-local",
      status: "queued",
      phase: "normalize",
      lastEventAt: now,
      metadata: {
        source: "api.threads.replies.create",
        role: taskRole
      }
    };

    const thread: ThreadDoc = {
      ...existingThread,
      status: "queued",
      boardStage: "ready",
      boardDisplay: "auto",
      currentTaskId: task._id,
      currentVersionText: normalized.summaryText,
      lastActivityAt: now,
      updatedAt: now
    };

    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collections.posts.insertOne(post, { session });
        await this.collections.tasks.updateOne(
          { _id: task._id },
          {
            $set: {
              role: taskRole,
              taskSpec,
              status: "queued",
              currentRunId: runId,
              currentVersionId: versionId,
              updatedAt: now
            }
          },
          { session }
        );
        await this.collections.taskVersions.insertOne(
          {
            _id: versionId,
            taskId: task._id,
            sourcePostId: postId,
            versionNumber: (latestVersion?.versionNumber ?? 0) + 1,
            summaryText: normalized.summaryText,
            spec: taskSpec,
            createdAt: now
          },
          { session }
        );
        await this.collections.runs.insertOne(run, { session });
        await this.collections.threads.updateOne(
          { _id: threadId },
          {
            $set: {
              role: taskRole,
              status: "queued",
              boardStage: "ready",
              boardDisplay: "auto",
              currentTaskId: task._id,
              currentVersionText: normalized.summaryText,
              lastActivityAt: now,
              updatedAt: now
            }
          },
          { session }
        );
        await this.collections.events.insertOne(
          {
            _id: new ObjectId(),
            runId,
            threadId,
            taskId: task._id,
            eventType: "reply_created",
            payload: {
              postId: postId.toHexString(),
              versionId: versionId.toHexString(),
              role: taskRole
            },
            createdAt: now
          },
          { session }
        );

        if (input.refs.length > 0) {
          await this.collections.contextRefs.insertMany(
            input.refs.map((ref, index) => ({
              _id: refIds[index],
              threadId,
              postId,
              taskId: task._id,
              refType: ref.refType,
              refValue: ref.refValue,
              metadata: ref.metadata,
              createdAt: now
            })),
            { session }
          );
        }
      });
    });

    return { thread, post, task: updatedTask, run };
  }

  async createBacklogImport(input: {
    folder: string;
    presetProjectId?: string;
    rows: BulkImportBacklogRowDto[];
  }): Promise<ImportedBacklogTaskBundle[]> {
    if (input.rows.length === 0) {
      return [];
    }

    const now = new Date();
    const reservedPublicTaskIds = new Set<string>();
    const bundles: ImportedBacklogTaskBundle[] = [];
    const threadDocs: ThreadDoc[] = [];
    const postDocs: PostDoc[] = [];
    const taskDocs: TaskDoc[] = [];
    const versionDocs: TaskVersionDoc[] = [];
    const runDocs: RunDoc[] = [];
    const eventDocs: EventDoc[] = [];

    for (const row of input.rows) {
      const normalized = normalizeTaskPost(row.body);
      const taskSpec = { ...normalized.spec, role: row.role };
      const threadId = new ObjectId();
      const rootPostId = new ObjectId();
      const taskId = new ObjectId();
      const versionId = new ObjectId();
      const runId = new ObjectId();
      const publicTaskId = await this.nextPublicTaskId(now, reservedPublicTaskIds);

      const thread: ThreadDoc = {
        _id: threadId,
        publicTaskId,
        name: row.name,
        role: row.role,
        folder: input.folder,
        presetProjectId: input.presetProjectId,
        title: row.name,
        status: "queued",
        boardStage: "ready",
        boardDisplay: "hidden",
        currentTaskId: taskId,
        currentVersionText: normalized.summaryText,
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now
      };

      const rootPost: PostDoc = {
        _id: rootPostId,
        threadId,
        authorType: "user",
        authorId: "local-user",
        postType: "root",
        status: "queued",
        runId,
        body: row.body,
        refs: [],
        artifactIds: [],
        visibility: "public",
        createdAt: now
      };

      const task: TaskDoc = {
        _id: taskId,
        threadId,
        rootPostId,
        intent: "work_request",
        role: row.role,
        taskSpec,
        constraints: { maxUserPostChars: 500 },
        status: "queued",
        priority: "normal",
        assignedAgent: "codex-local",
        currentRunId: runId,
        currentVersionId: versionId,
        createdAt: now,
        updatedAt: now
      };

      const run: RunDoc = {
        _id: runId,
        taskId,
        triggerPostId: rootPostId,
        agentName: "codex-local",
        status: "queued",
        phase: "normalize",
        lastEventAt: now,
        metadata: {
          source: "api.backlog.import",
          ...(row.clientKey ? { importClientKey: row.clientKey } : {}),
          role: row.role,
          ...(input.presetProjectId ? { presetProjectId: input.presetProjectId } : {}),
          importRowNumber: row.rowNumber
        }
      };

      threadDocs.push(thread);
      postDocs.push(rootPost);
      taskDocs.push(task);
      versionDocs.push({
        _id: versionId,
        taskId,
        sourcePostId: rootPostId,
        versionNumber: 1,
        summaryText: normalized.summaryText,
        spec: taskSpec,
        createdAt: now
      });
      runDocs.push(run);
      eventDocs.push({
        _id: new ObjectId(),
        runId,
        threadId,
        taskId,
        eventType: "backlog_task_imported",
        payload: {
          rootPostId: rootPostId.toHexString(),
          versionId: versionId.toHexString(),
          clientKey: row.clientKey,
          role: row.role,
          presetProjectId: input.presetProjectId,
          rowNumber: row.rowNumber
        },
        createdAt: now
      });
      bundles.push({ thread, rootPost, task, run, created: true });
    }

    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collections.threads.insertMany(threadDocs, { session });
        await this.collections.posts.insertMany(postDocs, { session });
        await this.collections.tasks.insertMany(taskDocs, { session });
        await this.collections.taskVersions.insertMany(versionDocs, { session });
        await this.collections.runs.insertMany(runDocs, { session });
        await this.collections.events.insertMany(eventDocs, { session });
      });
    });

    return bundles;
  }

  async createAckPost(threadId: ObjectId, taskId: ObjectId, runId: ObjectId): Promise<PostDoc> {
    const task = await this.collections.tasks.findOne({ _id: taskId });
    if (!task) {
      throw new Error(`Task not found: ${taskId.toHexString()}`);
    }
    return this.createAgentPost({
      threadId,
      taskId,
      runId,
      parentPostId: task.rootPostId,
      replyType: "ack",
      body: buildAckBody(String(task.taskSpec.objective ?? task.taskSpec.rawRequest ?? ""))
    });
  }

  async createAgentPost(input: AgentPostInput, session?: ClientSession): Promise<PostDoc> {
    const now = new Date();
    const post: PostDoc = {
      _id: new ObjectId(),
      threadId: input.threadId,
      parentPostId: input.parentPostId,
      authorType: "agent",
      authorId: "codex-local",
      postType: "reply",
      replyType: input.replyType,
      status: replyTypeToPostStatus(input.replyType),
      runId: input.runId,
      body: input.body,
      refs: [],
      artifactIds: input.artifactIds ?? [],
      visibility: "public",
      createdAt: now
    };

    await this.collections.posts.insertOne(post, { session });
    await this.collections.threads.updateOne(
      { _id: input.threadId },
      {
        $set: {
          latestAgentPostId: post._id,
          lastActivityAt: now,
          updatedAt: now,
          status: replyTypeToThreadStatus(input.replyType)
        }
      },
      { session }
    );
    await this.collections.events.insertOne(
      {
        _id: new ObjectId(),
        runId: input.runId,
        threadId: input.threadId,
        taskId: input.taskId,
        eventType: `post_${input.replyType}`,
        payload: { postId: post._id.toHexString() },
        createdAt: now
      },
      { session }
    );

    return post;
  }

  async updateTaskAndRunStatus(input: {
    threadId: ObjectId;
    taskId: ObjectId;
    runId: ObjectId;
    taskStatus: ThreadStatus;
    runStatus: RunStatus;
    phase: RunPhase;
    exitReason?: string;
    startedAt?: Date;
    endedAt?: Date;
    codexSessionRef?: string;
    metadata?: Record<string, unknown>;
    boardStage?: BoardStage;
  }): Promise<{ thread: ThreadDoc; run: RunDoc }> {
    const now = new Date();
    const runSet: Record<string, unknown> = {
      status: input.runStatus,
      phase: input.phase,
      lastEventAt: now,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
      ...(input.endedAt ? { endedAt: input.endedAt } : {}),
      ...(input.exitReason ? { exitReason: input.exitReason } : {}),
      ...(input.codexSessionRef ? { codexSessionRef: input.codexSessionRef } : {})
    };
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
      if (value !== undefined) {
        runSet[`metadata.${key}`] = value;
      }
    }

    await this.collections.tasks.updateOne(
      { _id: input.taskId },
      { $set: { status: input.taskStatus, updatedAt: now } }
    );
    await this.collections.runs.updateOne(
      { _id: input.runId },
      { $set: runSet }
    );
    const run = await this.collections.runs.findOne({ _id: input.runId });
    if (run?.triggerPostId) {
      await this.collections.posts.updateOne(
        { _id: run.triggerPostId },
        { $set: { status: taskStatusToPostStatus(input.taskStatus) } }
      );
    }
    await this.collections.threads.updateOne(
      { _id: input.threadId },
      {
        $set: {
          status: input.taskStatus,
          ...(input.boardStage ? { boardStage: input.boardStage } : {}),
          updatedAt: now,
          lastActivityAt: now
        }
      }
    );
    await this.collections.events.insertOne({
      _id: new ObjectId(),
      runId: input.runId,
      threadId: input.threadId,
      taskId: input.taskId,
      eventType: "status_changed",
      payload: {
        taskStatus: input.taskStatus,
        runStatus: input.runStatus,
        phase: input.phase,
        exitReason: input.exitReason,
        codexSessionRef: input.codexSessionRef,
        metadata: input.metadata,
        boardStage: input.boardStage
      },
      createdAt: now
    });

    const [thread, updatedRun] = await Promise.all([
      this.collections.threads.findOne({ _id: input.threadId }),
      this.collections.runs.findOne({ _id: input.runId })
    ]);
    if (!thread || !updatedRun) {
      throw new Error("Updated thread or run not found");
    }
    return { thread, run: updatedRun };
  }

  async appendEvent(input: {
    threadId: ObjectId;
    taskId: ObjectId;
    runId: ObjectId;
    eventType: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const now = new Date();
    await Promise.all([
      this.collections.events.insertOne({
        _id: new ObjectId(),
        runId: input.runId,
        threadId: input.threadId,
        taskId: input.taskId,
        eventType: input.eventType,
        payload: input.payload,
        createdAt: now
      }),
      this.collections.runs.updateOne({ _id: input.runId }, { $set: { lastEventAt: now } })
    ]);
  }

  async getTaskHeartbeat(taskId: ObjectId, now = new Date()): Promise<TaskHeartbeatDto | null> {
    const task = await this.collections.tasks.findOne({ _id: taskId });
    if (!task) {
      return null;
    }
    const thread = await this.collections.threads.findOne({ _id: task.threadId }, { projection: { publicTaskId: 1 } });

    const run = await this.collections.runs.findOne({ _id: task.currentRunId });
    if (!run) {
      return {
        taskId: task._id.toHexString(),
        publicTaskId: thread?.publicTaskId,
        threadId: task.threadId.toHexString(),
        state: "unknown",
        label: "状态未知",
        message: "没有找到当前任务对应的 run。",
        isTerminal: false,
        taskStatus: task.status,
        checkedAt: now.toISOString()
      };
    }

    const lastHeartbeatAt = now;
    await this.collections.runs.updateOne({ _id: run._id }, { $set: { lastHeartbeatAt } });
    return buildTaskHeartbeat(task, { ...run, lastHeartbeatAt }, now, thread?.publicTaskId);
  }

  async getTaskHeartbeatByReference(reference: string, now = new Date()): Promise<TaskHeartbeatDto | null> {
    if (ObjectId.isValid(reference)) {
      const heartbeat = await this.getTaskHeartbeat(new ObjectId(reference), now);
      if (heartbeat) {
        return heartbeat;
      }
    }

    const thread = await this.findThreadByReference(reference);
    if (!thread?.currentTaskId) {
      return null;
    }
    return this.getTaskHeartbeat(thread.currentTaskId, now);
  }

  async moveThreadBoardStage(threadId: ObjectId, boardStage: BoardStage): Promise<BoardStageTransitionResult> {
    const thread = await this.collections.threads.findOne({ _id: threadId });
    if (!thread) {
      throw new RepositoryNotFoundError(`Thread not found: ${threadId.toHexString()}`);
    }
    const currentStage = effectiveBoardStage(thread);

    if (!thread.currentTaskId) {
      throw new RepositoryConflictError("当前任务数据不完整，不能流转阶段。");
    }

    const task = await this.collections.tasks.findOne({ _id: thread.currentTaskId });
    if (!task) {
      throw new RepositoryNotFoundError(`Task not found for thread: ${threadId.toHexString()}`);
    }
    const run = await this.collections.runs.findOne({ _id: task.currentRunId });
    if (!run) {
      throw new RepositoryConflictError("当前任务没有可流转的 run。");
    }

    if (boardStage === "wip") {
      if (run.status === "running" && currentStage === "wip") {
        return { thread, task, run, started: false };
      }
      if (run.status !== "queued") {
        throw new RepositoryConflictError("请先在卡片内回复修改意见，再拖回 WIP 启动下一轮工作。");
      }
      const updated = await this.setThreadBoardStage(thread, "wip", task._id, run._id);
      return { ...updated, task, run, started: true };
    }

    if (boardStage === "ready") {
      if (run.status === "running") {
        throw new RepositoryConflictError("当前任务正在运行，不能移回 Ready。");
      }
      if (run.status !== "queued" && currentStage !== "ready") {
        throw new RepositoryConflictError("只有待启动的任务可以进入 Ready。");
      }
      return this.setThreadBoardStage(thread, "ready", task._id, run._id, task, run);
    }

    if (boardStage === "review") {
      if (run.status !== "completed") {
        throw new RepositoryConflictError("只有已完成的 Codex run 可以进入 Review。");
      }
      return this.setThreadBoardStage(thread, "review", task._id, run._id, task, run);
    }

    if (run.status !== "completed") {
      throw new RepositoryConflictError("只有 Review 中且已完成的任务可以进入 Done。");
    }
    if (currentStage !== "review" && currentStage !== "done") {
      throw new RepositoryConflictError("请先让任务进入 Review，再移动到 Done。");
    }
    return this.setThreadBoardStage(thread, "done", task._id, run._id, task, run);
  }

  private async setThreadBoardStage(
    thread: ThreadDoc,
    boardStage: BoardStage,
    taskId?: ObjectId,
    runId?: ObjectId,
    task?: TaskDoc,
    run?: RunDoc
  ): Promise<BoardStageTransitionResult> {
    const now = new Date();
    await this.collections.threads.updateOne(
      { _id: thread._id },
      { $set: { boardStage, boardDisplay: "auto", updatedAt: now, lastActivityAt: now } }
    );
    if (taskId && runId) {
      await this.collections.events.insertOne({
        _id: new ObjectId(),
        runId,
        threadId: thread._id,
        taskId,
        eventType: "board_stage_changed",
        payload: {
          from: effectiveBoardStage(thread),
          to: boardStage
        },
        createdAt: now
      });
    }

    const updatedThread = await this.collections.threads.findOne({ _id: thread._id });
    if (!updatedThread) {
      throw new RepositoryNotFoundError(`Thread not found: ${thread._id.toHexString()}`);
    }
    return { thread: updatedThread, task, run, started: false };
  }

  async updateThreadBoardDisplay(threadId: ObjectId, boardDisplay: "auto" | "shown" | "hidden"): Promise<ThreadDoc> {
    const thread = await this.collections.threads.findOne({ _id: threadId });
    if (!thread) {
      throw new RepositoryNotFoundError(`Thread not found: ${threadId.toHexString()}`);
    }

    const boardStage = effectiveBoardStage(thread);
    if (boardStage !== "ready" && boardStage !== "done") {
      throw new RepositoryConflictError("只有 Ready 或 Done 状态的任务可以设置看板显示。");
    }

    const now = new Date();
    await this.collections.threads.updateOne(
      { _id: threadId },
      { $set: { boardDisplay, updatedAt: now } }
    );

    const updatedThread = await this.collections.threads.findOne({ _id: threadId });
    if (!updatedThread) {
      throw new RepositoryNotFoundError(`Thread not found: ${threadId.toHexString()}`);
    }
    return updatedThread;
  }

  async updateBacklogTask(threadId: ObjectId, input: UpdateBacklogTaskInput): Promise<ThreadDoc> {
    const thread = await this.collections.threads.findOne({ _id: threadId });
    if (!thread) {
      throw new RepositoryNotFoundError(`Thread not found: ${threadId.toHexString()}`);
    }
    if (effectiveBoardStage(thread) !== "ready") {
      throw new RepositoryConflictError("只有 Backlog/Ready 中未启动的任务可以修改。");
    }
    if (!thread.currentTaskId) {
      throw new RepositoryConflictError("当前任务数据不完整，无法修改。");
    }

    const task = await this.collections.tasks.findOne({ _id: thread.currentTaskId });
    if (!task) {
      throw new RepositoryNotFoundError(`Task not found for thread: ${threadId.toHexString()}`);
    }
    const run = await this.collections.runs.findOne({ _id: task.currentRunId });
    if (!run) {
      throw new RepositoryConflictError("当前任务没有可修改的 run。");
    }
    if (run.status !== "queued") {
      throw new RepositoryConflictError("只有尚未启动的 Backlog 任务可以修改。");
    }

    const triggerPostId = run.triggerPostId ?? task.rootPostId;
    const triggerPost = await this.collections.posts.findOne({ _id: triggerPostId, threadId });
    if (!triggerPost || triggerPost.authorType !== "user") {
      throw new RepositoryConflictError("没有找到当前待启动任务对应的用户帖子。");
    }

    const latestVersion = await this.collections.taskVersions
      .find({ taskId: task._id })
      .sort({ versionNumber: -1 })
      .limit(1)
      .next();
    if (!latestVersion) {
      throw new RepositoryConflictError("当前任务没有可修改的版本。");
    }

    const normalizedInput = triggerPostId.equals(task.rootPostId)
      ? input.body
      : [
          `当前任务版本：${await this.previousVersionSummary(task._id, latestVersion.versionNumber, thread.currentVersionText)}`,
          `用户最新回复：${input.body}`
        ].join("\n\n");
    const normalized = normalizeTaskPost(normalizedInput);
    const taskSpec = { ...normalized.spec, role: input.role };
    const now = new Date();

    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collections.threads.updateOne(
          { _id: threadId },
          {
            $set: {
              name: input.name,
              role: input.role,
              title: input.name,
              status: "queued",
              boardStage: "ready",
              currentVersionText: normalized.summaryText,
              lastActivityAt: now,
              updatedAt: now
            }
          },
          { session }
        );
        await this.collections.posts.updateOne(
          { _id: triggerPostId },
          { $set: { body: input.body, status: "queued" } },
          { session }
        );
        await this.collections.tasks.updateOne(
          { _id: task._id },
          { $set: { role: input.role, taskSpec, status: "queued", updatedAt: now } },
          { session }
        );
        await this.collections.taskVersions.updateOne(
          { _id: latestVersion._id },
          { $set: { summaryText: normalized.summaryText, spec: taskSpec } },
          { session }
        );
        await this.collections.runs.updateOne(
          { _id: run._id },
          { $set: { lastEventAt: now } },
          { session }
        );
        await this.collections.events.insertOne(
          {
            _id: new ObjectId(),
            runId: run._id,
            threadId,
            taskId: task._id,
            eventType: "backlog_task_updated",
            payload: {
              postId: triggerPostId.toHexString(),
              versionId: latestVersion._id.toHexString(),
              role: input.role
            },
            createdAt: now
          },
          { session }
        );
      });
    });

    const updatedThread = await this.collections.threads.findOne({ _id: threadId });
    if (!updatedThread) {
      throw new RepositoryNotFoundError(`Thread not found: ${threadId.toHexString()}`);
    }
    return updatedThread;
  }

  async deleteBacklogTask(threadId: ObjectId): Promise<ThreadDoc> {
    const thread = await this.collections.threads.findOne({ _id: threadId });
    if (!thread) {
      throw new RepositoryNotFoundError(`Thread not found: ${threadId.toHexString()}`);
    }
    if (effectiveBoardStage(thread) !== "ready") {
      throw new RepositoryConflictError("只有 Backlog/Ready 中未启动的任务可以删除。");
    }

    if (!thread.currentTaskId) {
      throw new RepositoryConflictError("当前任务数据不完整，无法删除。");
    }

    const task = await this.collections.tasks.findOne({ _id: thread.currentTaskId });
    if (!task) {
      throw new RepositoryNotFoundError(`Task not found for thread: ${threadId.toHexString()}`);
    }
    const run = await this.collections.runs.findOne({ _id: task.currentRunId });
    if (!run) {
      throw new RepositoryConflictError("当前任务没有可删除的 run。");
    }
    if (run.status !== "queued") {
      throw new RepositoryConflictError("只有尚未启动的 Backlog 任务可以删除。");
    }

    const taskIds = (await this.collections.tasks.find({ threadId }).project<{ _id: ObjectId }>({ _id: 1 }).toArray()).map(
      (task) => task._id
    );

    await this.client.withSession(async (session) => {
      await session.withTransaction(async () => {
        await this.collections.contextRefs.deleteMany({ threadId }, { session });
        await this.collections.events.deleteMany({ threadId }, { session });
        await this.collections.artifacts.deleteMany({ taskId: { $in: taskIds } }, { session });
        await this.collections.taskVersions.deleteMany({ taskId: { $in: taskIds } }, { session });
        await this.collections.runs.deleteMany({ taskId: { $in: taskIds } }, { session });
        await this.collections.tasks.deleteMany({ threadId }, { session });
        await this.collections.posts.deleteMany({ threadId }, { session });
        await this.collections.threads.deleteOne({ _id: threadId }, { session });
      });
    });

    return thread;
  }

  private async previousVersionSummary(taskId: ObjectId, currentVersionNumber: number, fallback: string): Promise<string> {
    const previousVersion = await this.collections.taskVersions
      .find({ taskId, versionNumber: { $lt: currentVersionNumber } })
      .sort({ versionNumber: -1 })
      .limit(1)
      .next();
    return previousVersion?.summaryText ?? fallback;
  }

  async createArtifact(input: {
    taskId: ObjectId;
    runId: ObjectId;
    title: string;
    storagePath: string;
    mimeType: string;
    metadata?: Record<string, unknown>;
  }): Promise<ArtifactDoc> {
    const artifact: ArtifactDoc = {
      _id: new ObjectId(),
      taskId: input.taskId,
      runId: input.runId,
      artifactType: "markdown",
      title: input.title,
      storagePath: input.storagePath,
      mimeType: input.mimeType,
      metadata: input.metadata ?? {},
      createdAt: new Date()
    };
    await this.collections.artifacts.insertOne(artifact);
    return artifact;
  }

  async getThreadDetail(threadId: ObjectId): Promise<ThreadDetailDto | null> {
    const thread = await this.collections.threads.findOne({ _id: threadId });
    if (!thread) {
      return null;
    }

    const posts = await this.collections.posts.find({ threadId }).sort({ createdAt: 1 }).toArray();
    if (!thread.currentTaskId) {
      return null;
    }

    const [task, versions, artifacts] = await Promise.all([
      this.collections.tasks.findOne({ _id: thread.currentTaskId }),
      this.collections.taskVersions.find({ taskId: thread.currentTaskId }).sort({ versionNumber: -1 }).toArray(),
      this.collections.artifacts.find({ taskId: thread.currentTaskId }).sort({ createdAt: -1 }).toArray()
    ]);

    if (!task) {
      return null;
    }

    const run = await this.collections.runs.findOne({ _id: task.currentRunId });

    return {
      thread: serializeThread(thread),
      posts: posts.map(serializePost),
      task: serializeTask(task),
      run: run ? serializeRun(run) : undefined,
      versions: versions.map(serializeTaskVersion),
      artifacts: artifacts.map(serializeArtifact)
    };
  }

  async getThreadDetailByReference(reference: string): Promise<ThreadDetailDto | null> {
    const thread = await this.findThreadByReference(reference);
    return thread ? this.getThreadDetail(thread._id) : null;
  }

  async listThreads(): Promise<ThreadListItemDto[]> {
    const threads = await this.collections.threads.find({}).sort({ lastActivityAt: -1 }).limit(500).toArray();
    const items = await Promise.all(
      threads.map(async (thread) => {
        const [latestPost, postCount] = await Promise.all([
          this.collections.posts.find({ threadId: thread._id, postType: "reply" }).sort({ createdAt: -1 }).limit(1).next(),
          this.collections.posts.countDocuments({ threadId: thread._id, postType: "reply" })
        ]);

        return {
          ...serializeThread(thread),
          latestPost: latestPost ? serializePost(latestPost) : undefined,
          postCount
        };
      })
    );

    return items;
  }

  async findThread(threadId: ObjectId): Promise<ThreadDoc | null> {
    return this.collections.threads.findOne({ _id: threadId });
  }

  async findThreadByReference(reference: string): Promise<ThreadDoc | null> {
    if (ObjectId.isValid(reference)) {
      const thread = await this.findThread(new ObjectId(reference));
      if (thread) {
        return thread;
      }
    }
    return this.collections.threads.findOne({ publicTaskId: normalizePublicTaskId(reference) });
  }

  async findRun(runId: ObjectId): Promise<RunDoc | null> {
    return this.collections.runs.findOne({ _id: runId });
  }

  async getAppSettings(): Promise<AppSettingsDoc> {
    const existing = await this.collections.appSettings.findOne({ _id: APP_SETTINGS_ID });
    if (!existing) {
      const now = new Date();
      const defaults: AppSettingsDoc = {
        _id: APP_SETTINGS_ID,
        autoRunIntervalMinutes: APP_SETTINGS_INTERVAL_MINUTES_DEFAULT,
        maxConcurrentTasks: APP_SETTINGS_MAX_CONCURRENT_TASKS_DEFAULT,
        codexThreadPrefix: APP_SETTINGS_CODEX_THREAD_PREFIX_DEFAULT,
        systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
        presetProjects: [],
        createdAt: now,
        updatedAt: now
      };
      await this.collections.appSettings.updateOne({ _id: APP_SETTINGS_ID }, { $setOnInsert: defaults }, { upsert: true });
      return (await this.collections.appSettings.findOne({ _id: APP_SETTINGS_ID })) ?? defaults;
    }

    const normalizedInterval = clampAutoRunIntervalMinutes(existing.autoRunIntervalMinutes);
    const normalizedMaxConcurrent = clampMaxConcurrentTasks(existing.maxConcurrentTasks);
    const normalizedCodexThreadPrefix = normalizeCodexThreadPrefix(existing.codexThreadPrefix);
    const normalizedSystemPrompt = normalizeSystemPrompt(existing.systemPrompt);
    const normalizedPresetProjects = normalizePresetProjects(existing.presetProjects);
    const needsNormalization =
      existing.autoRunIntervalMinutes !== normalizedInterval ||
      existing.maxConcurrentTasks !== normalizedMaxConcurrent ||
      existing.codexThreadPrefix !== normalizedCodexThreadPrefix ||
      existing.systemPrompt !== normalizedSystemPrompt ||
      !presetProjectsEqual(existing.presetProjects, normalizedPresetProjects) ||
      Boolean(existing.roleInitialInstructions);

    if (!needsNormalization) {
      return existing;
    }

    const now = new Date();
    await this.collections.appSettings.updateOne(
      { _id: APP_SETTINGS_ID },
      {
        $set: {
          autoRunIntervalMinutes: normalizedInterval,
          maxConcurrentTasks: normalizedMaxConcurrent,
          codexThreadPrefix: normalizedCodexThreadPrefix,
          systemPrompt: normalizedSystemPrompt,
          presetProjects: normalizedPresetProjects,
          updatedAt: now
        },
        $unset: {
          roleInitialInstructions: ""
        },
        $setOnInsert: {
          createdAt: existing.createdAt ?? now
        }
      },
      { upsert: true }
    );
    const updated = await this.collections.appSettings.findOne({ _id: APP_SETTINGS_ID });
    return (
      updated ?? {
        ...existing,
        autoRunIntervalMinutes: normalizedInterval,
        maxConcurrentTasks: normalizedMaxConcurrent,
        codexThreadPrefix: normalizedCodexThreadPrefix,
        systemPrompt: normalizedSystemPrompt,
        presetProjects: normalizedPresetProjects,
        updatedAt: now
      }
    );
  }

  async updateAppSettings(input: UpdateAppSettingsInput): Promise<AppSettingsDoc> {
    const now = new Date();
    const nextSettings = {
      autoRunIntervalMinutes: clampAutoRunIntervalMinutes(input.autoRunIntervalMinutes),
      maxConcurrentTasks: clampMaxConcurrentTasks(input.maxConcurrentTasks),
      codexThreadPrefix: normalizeCodexThreadPrefix(input.codexThreadPrefix),
      systemPrompt: normalizeSystemPrompt(input.systemPrompt),
      presetProjects: normalizePresetProjects(input.presetProjects)
    };
    await this.collections.appSettings.updateOne(
      { _id: APP_SETTINGS_ID },
      {
        $set: {
          ...nextSettings,
          updatedAt: now
        },
        $unset: {
          roleInitialInstructions: ""
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
    const updated = await this.collections.appSettings.findOne({ _id: APP_SETTINGS_ID });
    if (!updated) {
      throw new RepositoryNotFoundError("App settings not found");
    }
    await this.syncBoardAutomationConfigFromAppSettings(updated);
    return updated;
  }

  async syncBoardAutomationConfigFromAppSettings(settings?: AppSettingsDoc): Promise<BoardAutomationDoc> {
    const effective = settings ?? (await this.getAppSettings());
    const now = new Date();
    await this.collections.boardAutomation.updateOne(
      { _id: BOARD_AUTOMATION_ID },
      {
        $set: {
          wipLimit: effective.maxConcurrentTasks,
          intervalMs: effective.autoRunIntervalMinutes * 60 * 1000,
          updatedAt: now
        },
        $setOnInsert: {
          enabled: false,
          lastStartedCount: 0,
          lastStartedThreadIds: [],
          lastMessage: "自动模式未开启。",
          createdAt: now
        }
      },
      { upsert: true }
    );
    const updated = await this.collections.boardAutomation.findOne({ _id: BOARD_AUTOMATION_ID });
    if (!updated) {
      throw new RepositoryNotFoundError("Board automation settings not found");
    }
    return updated;
  }

  toAppSettingsDto(settings: AppSettingsDoc): AppSettingsDto {
    return {
      autoRunIntervalMinutes: settings.autoRunIntervalMinutes,
      maxConcurrentTasks: settings.maxConcurrentTasks,
      codexThreadPrefix: settings.codexThreadPrefix,
      systemPrompt: normalizeSystemPrompt(settings.systemPrompt),
      presetProjects: normalizePresetProjects(settings.presetProjects),
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString()
    };
  }

  async getBoardAutomationSettings(): Promise<BoardAutomationDoc> {
    const existing = await this.collections.boardAutomation.findOne({ _id: BOARD_AUTOMATION_ID });
    if (existing) {
      return existing;
    }

    const now = new Date();
    const defaults: BoardAutomationDoc = {
      _id: BOARD_AUTOMATION_ID,
      enabled: false,
      wipLimit: BOARD_AUTOMATION_WIP_LIMIT,
      intervalMs: BOARD_AUTOMATION_INTERVAL_MS,
      lastStartedCount: 0,
      lastStartedThreadIds: [],
      lastMessage: "自动模式未开启。",
      createdAt: now,
      updatedAt: now
    };
    await this.collections.boardAutomation.updateOne(
      { _id: BOARD_AUTOMATION_ID },
      { $setOnInsert: defaults },
      { upsert: true }
    );
    return (await this.collections.boardAutomation.findOne({ _id: BOARD_AUTOMATION_ID })) ?? defaults;
  }

  async updateBoardAutomationSettings(input: { enabled: boolean }): Promise<BoardAutomationDoc> {
    const now = new Date();
    const current = await this.getBoardAutomationSettings();
    await this.collections.boardAutomation.updateOne(
      { _id: BOARD_AUTOMATION_ID },
      {
        $set: {
          enabled: input.enabled,
          wipLimit: current.wipLimit,
          intervalMs: current.intervalMs,
          lastMessage: input.enabled ? "自动模式已开启。" : "自动模式已关闭。",
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now,
          lastStartedCount: 0,
          lastStartedThreadIds: []
        }
      },
      { upsert: true }
    );
    const updated = await this.collections.boardAutomation.findOne({ _id: BOARD_AUTOMATION_ID });
    if (!updated) {
      throw new RepositoryNotFoundError("Board automation settings not found");
    }
    return updated;
  }

  async recordBoardAutomationCheck(input: {
    startedThreadIds: string[];
    message: string;
    checkedAt?: Date;
  }): Promise<BoardAutomationDoc> {
    const checkedAt = input.checkedAt ?? new Date();
    const updateSet: Partial<BoardAutomationDoc> = {
      lastCheckedAt: checkedAt,
      lastStartedCount: input.startedThreadIds.length,
      lastStartedThreadIds: input.startedThreadIds,
      lastMessage: input.message,
      updatedAt: checkedAt
    };
    if (input.startedThreadIds.length > 0) {
      updateSet.lastStartedAt = checkedAt;
    }
    await this.collections.boardAutomation.updateOne(
      { _id: BOARD_AUTOMATION_ID },
      {
        $set: updateSet,
        $setOnInsert: {
          enabled: false,
          wipLimit: BOARD_AUTOMATION_WIP_LIMIT,
          intervalMs: BOARD_AUTOMATION_INTERVAL_MS,
          createdAt: checkedAt
        }
      },
      { upsert: true }
    );
    const updated = await this.collections.boardAutomation.findOne({ _id: BOARD_AUTOMATION_ID });
    if (!updated) {
      throw new RepositoryNotFoundError("Board automation settings not found");
    }
    return updated;
  }

  async getBoardAutomationSnapshot(wipLimit = BOARD_AUTOMATION_WIP_LIMIT): Promise<BoardAutomationSnapshot> {
    const [readyColumnThreads, wipCount] = await Promise.all([
      this.listReadyColumnThreads(),
      this.collections.threads.countDocuments({ boardStage: "wip" })
    ]);
    const availableSlots = Math.max(0, wipLimit - wipCount);
    const startCandidates = availableSlots > 0 ? await this.listStartableReadyColumnThreads(readyColumnThreads, availableSlots) : [];
    return {
      readyColumnThreads,
      startCandidates,
      wipCount,
      availableSlots
    };
  }

  async toBoardAutomationDto(settings: BoardAutomationDoc): Promise<BoardAutomationDto> {
    const snapshot = await this.getBoardAutomationSnapshot(settings.wipLimit);
    const lastCheckedAt = settings.lastCheckedAt?.toISOString();
    const nextCheckAt =
      settings.enabled && settings.lastCheckedAt
        ? new Date(settings.lastCheckedAt.getTime() + settings.intervalMs).toISOString()
        : undefined;
    return {
      enabled: settings.enabled,
      wipLimit: settings.wipLimit,
      intervalMs: settings.intervalMs,
      readyColumnCount: snapshot.readyColumnThreads.length,
      wipCount: snapshot.wipCount,
      lastCheckedAt,
      lastStartedAt: settings.lastStartedAt?.toISOString(),
      lastStartedCount: settings.lastStartedCount,
      lastStartedThreadIds: settings.lastStartedThreadIds,
      lastMessage: settings.lastMessage,
      nextCheckAt,
      updatedAt: settings.updatedAt.toISOString()
    };
  }

  async listReadyColumnThreads(): Promise<ThreadDoc[]> {
    const readyThreads = await this.collections.threads
      .find({ boardStage: "ready" })
      .sort({ lastActivityAt: -1 })
      .limit(500)
      .toArray();
    return selectDisplayedReadyThreads(readyThreads);
  }

  private async listStartableReadyColumnThreads(readyThreads: ThreadDoc[], limit: number): Promise<ReadyColumnStartCandidate[]> {
    const candidates: ReadyColumnStartCandidate[] = [];
    for (const thread of readyThreads) {
      if (candidates.length >= limit) {
        break;
      }
      if (!thread.currentTaskId) {
        continue;
      }
      const task = await this.collections.tasks.findOne({ _id: thread.currentTaskId });
      if (!task) {
        continue;
      }
      const run = await this.collections.runs.findOne({ _id: task.currentRunId });
      if (!run || run.status !== "queued") {
        continue;
      }
      candidates.push({ thread, task, run });
    }
    return candidates;
  }

  private async nextPublicTaskId(now: Date, reserved = new Set<string>()): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const publicTaskId = generatePublicTaskId(now);
      if (reserved.has(publicTaskId)) {
        continue;
      }
      const existing = await this.collections.threads.findOne({ publicTaskId }, { projection: { _id: 1 } });
      if (!existing) {
        reserved.add(publicTaskId);
        return publicTaskId;
      }
    }
    throw new Error("Cannot allocate a unique public task id");
  }
}

function buildTaskHeartbeat(task: TaskDoc, run: RunDoc, now: Date, publicTaskId?: string): TaskHeartbeatDto {
  const startedAt = run.startedAt ?? task.createdAt;
  const lastEventAt = run.lastEventAt ?? run.startedAt ?? task.updatedAt ?? task.createdAt;
  const activeForMs = Math.max(0, now.getTime() - startedAt.getTime());
  const inactiveForMs = Math.max(0, now.getTime() - lastEventAt.getTime());
  const state = getHeartbeatState(run.status, activeForMs, inactiveForMs);
  const isTerminal = run.status === "completed" || run.status === "failed" || run.status === "cancelled";

  return {
    taskId: task._id.toHexString(),
    publicTaskId,
    threadId: task.threadId.toHexString(),
    runId: run._id.toHexString(),
    state,
    label: heartbeatLabel(state),
    message: heartbeatMessage(state, inactiveForMs),
    isTerminal,
    taskStatus: task.status,
    runStatus: run.status,
    runPhase: run.phase,
    checkedAt: now.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    endedAt: run.endedAt?.toISOString(),
    lastEventAt: lastEventAt.toISOString(),
    lastHeartbeatAt: run.lastHeartbeatAt?.toISOString(),
    activeForMs,
    inactiveForMs,
    run: serializeRun(run)
  };
}

function selectDisplayedReadyThreads(threads: ThreadDoc[]): ThreadDoc[] {
  const selected = new Set<string>();
  for (const thread of threads) {
    if (effectiveBoardDisplay(thread) === "shown") {
      selected.add(thread._id.toHexString());
    }
  }

  let autoCount = 0;
  for (const thread of threads) {
    const threadId = thread._id.toHexString();
    if (effectiveBoardDisplay(thread) === "hidden" || selected.has(threadId)) {
      continue;
    }
    selected.add(threadId);
    autoCount += 1;
    if (autoCount >= BOARD_READY_AUTO_DISPLAY_LIMIT) {
      break;
    }
  }

  return threads.filter((thread) => selected.has(thread._id.toHexString()));
}

function effectiveBoardDisplay(thread: ThreadDoc): BoardDisplay {
  return thread.boardDisplay ?? "auto";
}

function getHeartbeatState(runStatus: RunStatus, activeForMs: number, inactiveForMs: number): TaskHeartbeatState {
  if (runStatus === "completed") {
    return "completed";
  }
  if (runStatus === "failed") {
    return "failed";
  }
  if (runStatus === "cancelled") {
    return "cancelled";
  }
  if (runStatus === "queued") {
    return "queued";
  }
  if (inactiveForMs >= TASK_STALE_MS) {
    return "stale";
  }
  if (activeForMs >= TASK_LONG_RUNNING_MS) {
    return "long_running";
  }
  if (runStatus === "running") {
    return "working";
  }
  return "unknown";
}

function heartbeatLabel(state: TaskHeartbeatState): string {
  const labels: Record<TaskHeartbeatState, string> = {
    queued: "排队中",
    working: "工作中",
    long_running: "长时间运行",
    stale: "长时间无进展",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消",
    unknown: "状态未知"
  };
  return labels[state];
}

function heartbeatMessage(state: TaskHeartbeatState, inactiveForMs: number): string {
  if (state === "stale") {
    return `超过 ${formatDuration(inactiveForMs)} 没有收到 Codex 事件，任务未被自动终止。`;
  }
  if (state === "long_running") {
    return "任务仍在运行，已经超过常规观察窗口。";
  }
  if (state === "working") {
    return "最近收到过 Codex 事件，任务仍在进行。";
  }
  if (state === "queued") {
    return "任务已创建，等待 worker 启动。";
  }
  if (state === "completed") {
    return "任务已经完成。";
  }
  if (state === "failed") {
    return "任务已经失败。";
  }
  if (state === "cancelled") {
    return "任务已经取消。";
  }
  return "无法确认任务运行状态。";
}

function formatDuration(valueMs: number): string {
  const minutes = Math.max(1, Math.round(valueMs / 60000));
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function replyTypeToThreadStatus(replyType: ReplyType): ThreadStatus {
  if (replyType === "result") {
    return "delivered";
  }
  if (replyType === "failure") {
    return "failed";
  }
  if (replyType === "question") {
    return "waiting_for_input";
  }
  if (replyType === "ack") {
    return "accepted";
  }
  return "running";
}

function replyTypeToPostStatus(replyType: ReplyType): PostStatus {
  if (replyType === "result") {
    return "completed";
  }
  if (replyType === "failure") {
    return "failed";
  }
  if (replyType === "question") {
    return "waiting_for_input";
  }
  if (replyType === "ack") {
    return "accepted";
  }
  return "working";
}

function taskStatusToPostStatus(status: ThreadStatus): PostStatus {
  if (status === "delivered") {
    return "completed";
  }
  if (status === "running" || status === "researching" || status === "accepted") {
    return "working";
  }
  if (status === "waiting_for_input") {
    return "waiting_for_input";
  }
  if (status === "failed") {
    return "failed";
  }
  if (status === "cancelled") {
    return "cancelled";
  }
  return "queued";
}

function effectiveBoardStage(thread: ThreadDoc): BoardStage {
  if (thread.boardStage) {
    return thread.boardStage;
  }
  if (thread.status === "delivered") {
    return "review";
  }
  if (thread.status === "accepted" || thread.status === "researching" || thread.status === "running" || thread.status === "failed") {
    return "wip";
  }
  if (thread.status === "cancelled") {
    return "done";
  }
  return "ready";
}
