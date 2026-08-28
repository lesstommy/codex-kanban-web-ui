import type {
  ArtifactDto,
  PostDto,
  RunDto,
  TaskDto,
  TaskVersionDto,
  ThreadDto
} from "../shared/types";
import {
  DEFAULT_TASK_ROLE,
  DEFAULT_THREAD_FOLDER,
  taskRoleSchema,
  type BoardDisplay,
  type BoardStage,
  type TaskRole,
  type ThreadStatus
} from "../shared/schemas";
import type { ArtifactDoc, PostDoc, RunDoc, TaskDoc, TaskVersionDoc, ThreadDoc } from "./models";

function id(value: { toHexString(): string }): string {
  return value.toHexString();
}

function iso(value: Date | undefined): string | undefined {
  return value?.toISOString();
}

export function serializeThread(thread: ThreadDoc): ThreadDto {
  const name = thread.name ?? thread.title;
  const boardStage = normalizeBoardStage(thread);
  return {
    id: id(thread._id),
    publicTaskId: thread.publicTaskId,
    name,
    role: normalizeTaskRole(thread.role),
    folder: thread.folder ?? DEFAULT_THREAD_FOLDER,
    presetProjectId: thread.presetProjectId,
    externalTaskSource: thread.externalTaskSource,
    externalTaskKey: thread.externalTaskKey,
    title: thread.title,
    status: thread.status,
    boardStage,
    boardDisplay: normalizeBoardDisplay(thread),
    currentTaskId: thread.currentTaskId ? id(thread.currentTaskId) : undefined,
    currentVersionText: thread.currentVersionText,
    latestAgentPostId: thread.latestAgentPostId ? id(thread.latestAgentPostId) : undefined,
    lastActivityAt: thread.lastActivityAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString()
  };
}

function normalizeBoardStage(thread: ThreadDoc): BoardStage {
  return thread.boardStage ?? boardStageFromStatus(thread.status);
}

function normalizeBoardDisplay(thread: ThreadDoc): BoardDisplay {
  if (thread.boardDisplay) {
    return thread.boardDisplay;
  }
  return "auto";
}

function boardStageFromStatus(status: ThreadStatus): BoardStage {
  if (status === "delivered") {
    return "review";
  }
  if (status === "accepted" || status === "researching" || status === "running" || status === "failed") {
    return "wip";
  }
  if (status === "cancelled") {
    return "done";
  }
  return "ready";
}

export function serializePost(post: PostDoc): PostDto {
  return {
    id: id(post._id),
    threadId: id(post.threadId),
    parentPostId: post.parentPostId ? id(post.parentPostId) : undefined,
    authorType: post.authorType,
    authorId: post.authorId,
    postType: post.postType,
    replyType: post.replyType,
    status: post.status,
    runId: post.runId ? id(post.runId) : undefined,
    body: post.body,
    bodyMarkdown: post.bodyMarkdown,
    refs: post.refs.map(id),
    artifactIds: post.artifactIds.map(id),
    visibility: post.visibility,
    createdAt: post.createdAt.toISOString()
  };
}

export function serializeTask(task: TaskDoc): TaskDto {
  return {
    id: id(task._id),
    threadId: id(task.threadId),
    rootPostId: id(task.rootPostId),
    intent: task.intent,
    role: normalizeTaskRole(task.role),
    taskSpec: task.taskSpec,
    constraints: task.constraints,
    status: task.status,
    priority: task.priority,
    deadlineAt: iso(task.deadlineAt),
    assignedAgent: task.assignedAgent,
    currentRunId: id(task.currentRunId),
    currentVersionId: id(task.currentVersionId),
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString()
  };
}

function normalizeTaskRole(role: unknown): TaskRole {
  const parsed = taskRoleSchema.safeParse(role);
  return parsed.success ? parsed.data : DEFAULT_TASK_ROLE;
}

export function serializeTaskVersion(version: TaskVersionDoc): TaskVersionDto {
  return {
    id: id(version._id),
    taskId: id(version.taskId),
    sourcePostId: id(version.sourcePostId),
    versionNumber: version.versionNumber,
    summaryText: version.summaryText,
    spec: version.spec,
    createdAt: version.createdAt.toISOString()
  };
}

export function serializeRun(run: RunDoc): RunDto {
  return {
    id: id(run._id),
    taskId: id(run.taskId),
    agentName: run.agentName,
    status: run.status,
    phase: run.phase,
    startedAt: iso(run.startedAt),
    endedAt: iso(run.endedAt),
    lastEventAt: iso(run.lastEventAt),
    lastHeartbeatAt: iso(run.lastHeartbeatAt),
    exitReason: run.exitReason,
    codexSessionRef: run.codexSessionRef,
    metadata: run.metadata
  };
}

export function serializeArtifact(artifact: ArtifactDoc): ArtifactDto {
  return {
    id: id(artifact._id),
    taskId: id(artifact.taskId),
    runId: id(artifact.runId),
    artifactType: artifact.artifactType,
    title: artifact.title,
    storagePath: artifact.storagePath,
    mimeType: artifact.mimeType,
    metadata: artifact.metadata,
    createdAt: artifact.createdAt.toISOString()
  };
}
