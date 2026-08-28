import type { BoardDisplay, BoardStage, PostStatus, ReplyType, RunPhase, RunStatus, TaskRole, ThreadStatus } from "./schemas";

export type AuthorType = "user" | "agent" | "system";
export type PostType = "root" | "reply";

export interface ContextRefDto {
  id: string;
  threadId: string;
  postId?: string;
  taskId?: string;
  refType: "file" | "url" | "thread" | "tag" | "workspace";
  refValue: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadDto {
  id: string;
  publicTaskId: string;
  name: string;
  role: TaskRole;
  folder: string;
  presetProjectId?: string;
  externalTaskSource?: string;
  externalTaskKey?: string;
  title: string;
  status: ThreadStatus;
  boardStage: BoardStage;
  boardDisplay: BoardDisplay;
  currentTaskId?: string;
  currentVersionText: string;
  latestAgentPostId?: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PostDto {
  id: string;
  threadId: string;
  parentPostId?: string;
  authorType: AuthorType;
  authorId: string;
  postType: PostType;
  replyType?: ReplyType;
  status?: PostStatus;
  runId?: string;
  body: string;
  bodyMarkdown?: string;
  refs: string[];
  artifactIds: string[];
  visibility: "public";
  createdAt: string;
}

export interface TaskDto {
  id: string;
  threadId: string;
  rootPostId: string;
  intent: string;
  role: TaskRole;
  taskSpec: Record<string, unknown>;
  constraints: Record<string, unknown>;
  status: ThreadStatus;
  priority: "normal";
  deadlineAt?: string;
  assignedAgent: string;
  currentRunId: string;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskVersionDto {
  id: string;
  taskId: string;
  sourcePostId: string;
  versionNumber: number;
  summaryText: string;
  spec: Record<string, unknown>;
  createdAt: string;
}

export interface RunDto {
  id: string;
  taskId: string;
  agentName: string;
  status: RunStatus;
  phase: RunPhase;
  startedAt?: string;
  endedAt?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  exitReason?: string;
  codexSessionRef?: string;
  metadata: Record<string, unknown>;
}

export type TaskHeartbeatState =
  | "queued"
  | "working"
  | "long_running"
  | "stale"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface TaskHeartbeatDto {
  taskId: string;
  publicTaskId?: string;
  threadId: string;
  runId?: string;
  state: TaskHeartbeatState;
  label: string;
  message: string;
  isTerminal: boolean;
  taskStatus: ThreadStatus;
  runStatus?: RunStatus;
  runPhase?: RunPhase;
  checkedAt: string;
  startedAt?: string;
  endedAt?: string;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  activeForMs?: number;
  inactiveForMs?: number;
  run?: RunDto;
}

export interface ArtifactDto {
  id: string;
  taskId: string;
  runId: string;
  artifactType: "markdown" | "file" | "text";
  title: string;
  storagePath: string;
  mimeType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ThreadDetailDto {
  thread: ThreadDto;
  posts: PostDto[];
  task?: TaskDto;
  run?: RunDto;
  versions: TaskVersionDto[];
  artifacts: ArtifactDto[];
}

export interface ThreadListItemDto extends ThreadDto {
  latestPost?: PostDto;
  postCount: number;
}

export interface BoardStageUpdateDto {
  thread: ThreadDto;
  run?: RunDto;
  started: boolean;
}

export interface BoardDisplayUpdateDto {
  thread: ThreadDto;
}

export interface BoardAutomationDto {
  enabled: boolean;
  wipLimit: number;
  intervalMs: number;
  readyColumnCount: number;
  wipCount: number;
  lastCheckedAt?: string;
  lastStartedAt?: string;
  lastStartedCount: number;
  lastStartedThreadIds: string[];
  lastMessage?: string;
  nextCheckAt?: string;
  updatedAt: string;
}

export interface BoardAutomationUpdateDto {
  automation: BoardAutomationDto;
}

export interface BoardAutomationRunDto {
  automation: BoardAutomationDto;
  startedThreadIds: string[];
  startedCount: number;
}

export interface PresetProjectDto {
  id: string;
  name: string;
  folder: string;
  roleInitialInstructions: Record<TaskRole, string>;
}

export interface AppSettingsDto {
  autoRunIntervalMinutes: number;
  maxConcurrentTasks: number;
  codexThreadPrefix: string;
  systemPrompt: string;
  presetProjects: PresetProjectDto[];
  createdAt: string;
  updatedAt: string;
}

export interface AppSettingsUpdateDto {
  settings: AppSettingsDto;
  automation: BoardAutomationDto;
}

export interface BacklogTaskUpdateDto {
  thread: ThreadDto;
}

export interface BacklogTaskDeleteDto {
  threadId: string;
  publicTaskId: string;
  deleted: true;
}

export interface CreateThreadResultDto {
  threadId: string;
  publicTaskId: string;
  postId: string;
  taskId: string;
  runId: string;
  created: boolean;
}

export interface BatchCreateThreadResultItemDto extends CreateThreadResultDto {
  name: string;
  role: TaskRole;
  externalTaskKey?: string;
}

export interface BatchCreateThreadsDto {
  createdCount: number;
  existingCount: number;
  items: BatchCreateThreadResultItemDto[];
}

export interface BulkImportBacklogRowDto {
  rowNumber: number;
  clientKey?: string;
  name: string;
  role: TaskRole;
  body: string;
}

export interface BulkImportBacklogRowErrorDto {
  rowNumber: number;
  clientKey?: string;
  name?: string;
  message: string;
}

export interface BulkImportBacklogPreviewDto {
  totalRows: number;
  validRows: number;
  rows: BulkImportBacklogRowDto[];
  errors: BulkImportBacklogRowErrorDto[];
}

export interface BulkImportBacklogDto extends BulkImportBacklogPreviewDto {
  importedCount: number;
  threads: ThreadDto[];
}

export interface HealthDto {
  ok: boolean;
  mongo: {
    ok: boolean;
    message: string;
  };
  codex: {
    ok: boolean;
    bin: string;
    mode: "app-server";
    version?: string;
    login?: string;
    message: string;
  };
}

export interface LocalDirectoryDto {
  path: string;
  parentPath?: string;
  entries: Array<{
    name: string;
    path: string;
  }>;
}

export interface AuthStateDto {
  enabled: boolean;
  authenticated: boolean;
  user?: {
    id: string;
    name: string;
  };
  expiresAt?: string;
}

export type StreamEvent =
  | { type: "ready"; threadId: string }
  | { type: "post.created"; threadId: string; post: PostDto }
  | { type: "thread.updated"; threadId: string; thread: ThreadDto }
  | { type: "run.updated"; threadId: string; run: RunDto }
  | { type: "artifact.created"; threadId: string; artifact: ArtifactDto }
  | { type: "health"; threadId: string; ok: boolean };
