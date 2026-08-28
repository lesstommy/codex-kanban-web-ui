import { ObjectId } from "mongodb";
import type { AppSettingsDto, PostDto, RunDto, ThreadDto } from "../shared/types";
import type { AppConfig } from "./config";
import type { CodexRunner } from "./codexRunner";
import type { ThreadEventBus } from "./eventBus";
import type { RunDoc, TaskDoc } from "./models";
import { buildCodexPrompt } from "./normalizer";
import type { HarnessRepository } from "./repository";
import { serializePost, serializeRun, serializeThread } from "./serializers";
import type { TaskRole } from "../shared/schemas";

export interface WorkerJob {
  threadId: ObjectId;
  taskId: ObjectId;
  runId: ObjectId;
}

export function shouldApplyRoleInitialInstruction(run: Pick<RunDoc, "triggerPostId">, task: Pick<TaskDoc, "rootPostId">): boolean {
  return Boolean(run.triggerPostId && run.triggerPostId.equals(task.rootPostId));
}

export function getPresetProjectRoleInitialInstruction(
  settings: Pick<AppSettingsDto, "presetProjects">,
  presetProjectId: string | undefined,
  role: TaskRole
): string | undefined {
  if (!presetProjectId) {
    return undefined;
  }
  const project = settings.presetProjects.find((item) => item.id === presetProjectId);
  const instruction = project?.roleInitialInstructions[role]?.trim();
  return instruction ? instruction : undefined;
}

const codexThreadRoleLabel: Record<TaskRole, string> = {
  se: "程序",
  art: "美术",
  design: "策划",
  music: "音乐",
  general: "综合"
};

export function buildCodexThreadName(prefix: string, role: TaskRole, threadName: string): string {
  return [prefix.trim(), codexThreadRoleLabel[role], threadName.trim()].filter(Boolean).join("-");
}

export class AgentWorker {
  private readonly queue: WorkerJob[] = [];
  private readonly idleResolvers = new Set<() => void>();
  private concurrency: number;
  private activeCount = 0;

  constructor(
    private readonly repo: HarnessRepository,
    private readonly runner: CodexRunner,
    private readonly bus: ThreadEventBus,
    private readonly config: AppConfig
  ) {
    this.concurrency = Math.max(1, Math.min(5, Math.floor(config.codexWorkerConcurrency)));
  }

  setConcurrency(limit: number): void {
    this.concurrency = Math.max(1, Math.min(5, Math.floor(limit || 1)));
    this.drain();
  }

  getConcurrency(): number {
    return this.concurrency;
  }

  enqueue(job: WorkerJob): void {
    this.queue.push(job);
    this.drain();
  }

  async processNow(job: WorkerJob): Promise<void> {
    this.queue.unshift(job);
    this.drain();
    await this.whenIdle();
  }

  async whenIdle(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.idleResolvers.add(resolve);
    });
  }

  async recoverQueuedWipRuns(): Promise<number> {
    const wipThreads = await this.repo.collections.threads.find({ boardStage: "wip" }).sort({ lastActivityAt: 1 }).toArray();
    let recovered = 0;

    for (const thread of wipThreads) {
      if (!thread.currentTaskId) {
        continue;
      }
      const task = await this.repo.collections.tasks.findOne({ _id: thread.currentTaskId });
      if (!task || task.status !== "queued") {
        continue;
      }
      const run = await this.repo.collections.runs.findOne({ _id: task.currentRunId });
      if (!run || run.status !== "queued") {
        continue;
      }

      this.enqueue({
        threadId: thread._id,
        taskId: task._id,
        runId: run._id
      });
      recovered += 1;
    }

    return recovered;
  }

  async recoverInterruptedRunningRuns(): Promise<number> {
    const runningRuns = await this.repo.collections.runs.find({ status: "running" }).sort({ lastEventAt: 1 }).toArray();
    let recovered = 0;

    for (const run of runningRuns) {
      const task = await this.repo.collections.tasks.findOne({ _id: run.taskId });
      if (!task || !task.currentRunId.equals(run._id)) {
        continue;
      }
      const thread = await this.repo.collections.threads.findOne({ _id: task.threadId });
      if (!thread || !thread.currentTaskId?.equals(task._id) || thread.boardStage !== "wip") {
        continue;
      }

      await this.interruptOrphanedRun({
        threadId: thread._id,
        taskId: task._id,
        runId: run._id
      });
      recovered += 1;
    }

    return recovered;
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) {
        break;
      }

      this.activeCount += 1;
      void this.process(job).finally(() => {
        this.activeCount -= 1;
        this.drain();
        this.resolveIdleIfReady();
      });
    }

    this.resolveIdleIfReady();
  }

  private resolveIdleIfReady(): void {
    if (this.activeCount > 0 || this.queue.length > 0) {
      return;
    }
    for (const resolve of this.idleResolvers) {
      resolve();
    }
    this.idleResolvers.clear();
  }

  private async process(job: WorkerJob): Promise<void> {
    try {
      const ackPost = await this.repo.createAckPost(job.threadId, job.taskId, job.runId);
      this.publishPost(ackPost);
      await this.publishCurrentThread(job.threadId);

      const startedAt = new Date();
      const running = await this.repo.updateTaskAndRunStatus({
        ...job,
        taskStatus: "running",
        runStatus: "running",
        phase: "execute",
        startedAt,
        boardStage: "wip"
      });
      this.publishThread(running.thread);
      this.publishRun(running.run, job.threadId);

      const task = await this.repo.collections.tasks.findOne({ _id: job.taskId });
      if (!task) {
        throw new Error(`Task not found: ${job.taskId.toHexString()}`);
      }
      const thread = await this.repo.findThread(job.threadId);
      if (!thread) {
        throw new Error(`Thread not found: ${job.threadId.toHexString()}`);
      }
      const appSettings = await this.repo.getAppSettings();
      const appSettingsDto = this.repo.toAppSettingsDto(appSettings);
      const shouldApplyInitialization = shouldApplyRoleInitialInstruction(running.run, task);
      const roleInitialInstruction = shouldApplyInitialization
        ? getPresetProjectRoleInitialInstruction(
            appSettingsDto,
            thread.presetProjectId,
            task.role ?? thread.role ?? "general"
          )
        : undefined;
      const systemPrompt = shouldApplyInitialization ? appSettings.systemPrompt : "";

      const prompt = buildCodexPrompt(
        String(task.taskSpec.objective ?? task.taskSpec.rawRequest ?? ""),
        String(task.taskSpec.rawRequest ?? ""),
        roleInitialInstruction,
        systemPrompt
      );
      const cwd = thread.folder ?? this.config.codexWorkspace;
      const codexThreadId = await this.findReusableCodexThreadId(job);
      const codexThreadName = buildCodexThreadName(
        appSettings.codexThreadPrefix,
        task.role ?? thread.role ?? "general",
        thread.name ?? thread.title
      );

      const result = await this.runner.run(
        { prompt, runId: job.runId.toHexString(), cwd, codexThreadId, codexThreadName },
        async (event) => {
          await this.repo.appendEvent({
            ...job,
            eventType: event.error ? "codex_event_invalid" : "codex_event",
            payload: {
              raw: event.raw,
              value: event.value,
              error: event.error,
              eventType: event.eventType
            }
          });
        }
      );

      if (result.exitCode === 0) {
        await this.completeSuccessfully(job, result.lastMessage || "Codex 已完成任务。", {
          codexSessionRef: result.codexSessionRef,
          metadata: result.metadata
        });
      } else {
        await this.fail(job, result.stderr || result.lastMessage || `Codex exited with code ${result.exitCode}`, {
          codexSessionRef: result.codexSessionRef,
          metadata: result.metadata
        });
      }
    } catch (error) {
      await this.fail(job, error instanceof Error ? error.message : "Worker failed");
    }
  }

  private async findReusableCodexThreadId(job: WorkerJob): Promise<string | undefined> {
    const previousRun = await this.repo.collections.runs
      .find({
        taskId: job.taskId,
        _id: { $ne: job.runId },
        agentName: "codex-local",
        $or: [
          { "metadata.appServerThreadId": { $type: "string" } },
          { codexSessionRef: { $regex: /^app-server:/ } }
        ]
      })
      .sort({ endedAt: -1, startedAt: -1, _id: -1 })
      .limit(1)
      .next();

    return extractAppServerThreadId(previousRun);
  }

  private async completeSuccessfully(
    job: WorkerJob,
    message: string,
    codex?: { codexSessionRef?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const resultPost = await this.repo.createAgentPost({
      ...job,
      replyType: "result",
      body: message
    });
    this.publishPost(resultPost);

    const updated = await this.repo.updateTaskAndRunStatus({
      ...job,
      taskStatus: "delivered",
      runStatus: "completed",
      phase: "complete",
      endedAt: new Date(),
      exitReason: "completed",
      codexSessionRef: codex?.codexSessionRef,
      metadata: codex?.metadata,
      boardStage: "review"
    });
    this.publishThread(updated.thread);
    this.publishRun(updated.run, job.threadId);
  }

  private async fail(
    job: WorkerJob,
    reason: string,
    codex?: { codexSessionRef?: string; metadata?: Record<string, unknown> }
  ): Promise<void> {
    const failurePost = await this.repo.createAgentPost({
      ...job,
      replyType: "failure",
      body: `执行失败：${reason}`
    });
    this.publishPost(failurePost);

    const updated = await this.repo.updateTaskAndRunStatus({
      ...job,
      taskStatus: "failed",
      runStatus: "failed",
      phase: "failed",
      endedAt: new Date(),
      exitReason: reason,
      codexSessionRef: codex?.codexSessionRef,
      metadata: codex?.metadata,
      boardStage: "wip"
    });
    this.publishThread(updated.thread);
    this.publishRun(updated.run, job.threadId);
  }

  private async interruptOrphanedRun(job: WorkerJob): Promise<void> {
    const reason = "Harness 服务重启或热重载时丢失了这个 Codex run 的观察器，无法确认它已经正常完成。";
    const failurePost = await this.repo.createAgentPost({
      ...job,
      replyType: "failure",
      body: `执行中断：${reason}请检查本地产物后回复修改意见，或重新拖入 WIP 启动下一轮。`
    });
    this.publishPost(failurePost);

    const updated = await this.repo.updateTaskAndRunStatus({
      ...job,
      taskStatus: "failed",
      runStatus: "failed",
      phase: "failed",
      endedAt: new Date(),
      exitReason: "interrupted: worker observer lost during Harness restart",
      metadata: {
        recoveryReason: "worker_observer_lost"
      },
      boardStage: "wip"
    });
    this.publishThread(updated.thread);
    this.publishRun(updated.run, job.threadId);
  }

  private publishPost(post: Parameters<typeof serializePost>[0]): void {
    const dto: PostDto = serializePost(post);
    this.bus.publish({ type: "post.created", threadId: dto.threadId, post: dto });
  }

  private publishThread(thread: Parameters<typeof serializeThread>[0]): void {
    const dto: ThreadDto = serializeThread(thread);
    this.bus.publish({ type: "thread.updated", threadId: dto.id, thread: dto });
  }

  private publishRun(run: Parameters<typeof serializeRun>[0], threadId: ObjectId): void {
    const dto: RunDto = serializeRun(run);
    this.bus.publish({ type: "run.updated", threadId: threadId.toHexString(), run: dto });
  }

  private async publishCurrentThread(threadId: ObjectId): Promise<void> {
    const thread = await this.repo.findThread(threadId);
    if (thread) {
      this.publishThread(thread);
    }
  }
}

function extractAppServerThreadId(run: RunDoc | null): string | undefined {
  const metadataThreadId = run?.metadata.appServerThreadId;
  if (typeof metadataThreadId === "string" && metadataThreadId.trim()) {
    return metadataThreadId;
  }

  const refParts = run?.codexSessionRef?.split(":");
  if (refParts?.[0] === "app-server" && refParts[1]) {
    return refParts[1];
  }

  return undefined;
}
