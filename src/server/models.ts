import type { ObjectId } from "mongodb";
import type { AuthorType, PostType, PresetProjectDto } from "../shared/types";
import type { BoardDisplay, BoardStage, PostStatus, ReplyType, RoleInitialInstructions, RunPhase, RunStatus, TaskRole, ThreadStatus } from "../shared/schemas";

export interface AccountDoc {
  _id: ObjectId;
  username: string;
  passwordHash: string;
  role: "admin";
  status: "active" | "disabled";
  lastLoginAt?: Date;
  passwordUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceAccountDoc {
  _id: ObjectId;
  name: string;
  tokenFingerprint: string;
  tokenHash: string;
  scopes: string[];
  status: "active" | "disabled";
  lastUsedAt?: Date;
  tokenUpdatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface BoardAutomationDoc {
  _id: "board_automation";
  enabled: boolean;
  wipLimit: number;
  intervalMs: number;
  lastCheckedAt?: Date;
  lastStartedAt?: Date;
  lastStartedCount: number;
  lastStartedThreadIds: string[];
  lastMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppSettingsDoc {
  _id: "app_settings";
  autoRunIntervalMinutes: number;
  maxConcurrentTasks: number;
  codexThreadPrefix: string;
  systemPrompt: string;
  presetProjects: PresetProjectDto[];
  roleInitialInstructions?: RoleInitialInstructions;
  createdAt: Date;
  updatedAt: Date;
}

export interface ThreadDoc {
  _id: ObjectId;
  publicTaskId: string;
  name?: string;
  role?: TaskRole;
  folder?: string;
  presetProjectId?: string;
  externalTaskSource?: string;
  externalTaskKey?: string;
  title: string;
  status: ThreadStatus;
  boardStage?: BoardStage;
  boardDisplay?: BoardDisplay;
  currentTaskId?: ObjectId;
  currentVersionText: string;
  latestAgentPostId?: ObjectId;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PostDoc {
  _id: ObjectId;
  threadId: ObjectId;
  parentPostId?: ObjectId;
  authorType: AuthorType;
  authorId: string;
  postType: PostType;
  replyType?: ReplyType;
  status?: PostStatus;
  runId?: ObjectId;
  body: string;
  bodyMarkdown?: string;
  refs: ObjectId[];
  artifactIds: ObjectId[];
  visibility: "public";
  createdAt: Date;
}

export interface TaskDoc {
  _id: ObjectId;
  threadId: ObjectId;
  rootPostId: ObjectId;
  intent: string;
  role?: TaskRole;
  taskSpec: Record<string, unknown>;
  constraints: Record<string, unknown>;
  status: ThreadStatus;
  priority: "normal";
  deadlineAt?: Date;
  assignedAgent: string;
  currentRunId: ObjectId;
  currentVersionId: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskVersionDoc {
  _id: ObjectId;
  taskId: ObjectId;
  sourcePostId: ObjectId;
  versionNumber: number;
  summaryText: string;
  spec: Record<string, unknown>;
  createdAt: Date;
}

export interface RunDoc {
  _id: ObjectId;
  taskId: ObjectId;
  triggerPostId?: ObjectId;
  agentName: string;
  status: RunStatus;
  phase: RunPhase;
  startedAt?: Date;
  endedAt?: Date;
  lastEventAt?: Date;
  lastHeartbeatAt?: Date;
  exitReason?: string;
  codexSessionRef?: string;
  metadata: Record<string, unknown>;
}

export interface EventDoc {
  _id: ObjectId;
  runId: ObjectId;
  threadId: ObjectId;
  taskId: ObjectId;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ArtifactDoc {
  _id: ObjectId;
  taskId: ObjectId;
  runId: ObjectId;
  artifactType: "markdown" | "file" | "text";
  title: string;
  storagePath: string;
  mimeType: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ContextRefDoc {
  _id: ObjectId;
  threadId: ObjectId;
  postId?: ObjectId;
  taskId?: ObjectId;
  refType: "file" | "url" | "thread" | "tag" | "workspace";
  refValue: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}
