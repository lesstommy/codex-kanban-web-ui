import { RepositoryConflictError, type HarnessRepository } from "./repository";
import type { ThreadEventBus } from "./eventBus";
import type { AgentWorker } from "./worker";
import type { BoardAutomationDto, BoardAutomationRunDto } from "../shared/types";
import { serializeThread } from "./serializers";

export class BoardAutomationService {
  private timer?: ReturnType<typeof setTimeout>;
  private checking = false;
  private stopped = true;

  constructor(
    private readonly repo: HarnessRepository,
    private readonly worker: AgentWorker,
    private readonly bus: ThreadEventBus
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    void this.checkImmediatelyThenSchedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  async getState(): Promise<BoardAutomationDto> {
    const settings = await this.repo.getBoardAutomationSettings();
    return this.repo.toBoardAutomationDto(settings);
  }

  async setEnabled(enabled: boolean): Promise<BoardAutomationDto> {
    const settings = await this.repo.updateBoardAutomationSettings({ enabled });
    if (!enabled) {
      await this.scheduleNextCheck();
      return this.repo.toBoardAutomationDto(settings);
    }
    return this.checkImmediatelyThenSchedule();
  }

  async checkNow(): Promise<BoardAutomationRunDto> {
    return this.runCheck("manual");
  }

  async refreshSchedule(): Promise<void> {
    await this.scheduleNextCheck();
  }

  private async checkImmediatelyThenSchedule(): Promise<BoardAutomationDto> {
    try {
      const result = await this.runCheck("scheduled");
      return result.automation;
    } finally {
      await this.scheduleNextCheck();
    }
  }

  private async checkIfEnabled(): Promise<void> {
    const settings = await this.repo.getBoardAutomationSettings();
    if (!settings.enabled) {
      return;
    }
    await this.runCheck("scheduled");
  }

  private async scheduleNextCheck(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.stopped) {
      return;
    }

    const settings = await this.repo.getBoardAutomationSettings();
    if (!settings.enabled) {
      return;
    }

    this.timer = setTimeout(() => {
      void (async () => {
        try {
          await this.checkIfEnabled();
        } finally {
          await this.scheduleNextCheck();
        }
      })();
    }, settings.intervalMs);
  }

  private async runCheck(reason: "manual" | "scheduled"): Promise<BoardAutomationRunDto> {
    if (this.checking) {
      const automation = await this.getState();
      return {
        automation: {
          ...automation,
          lastMessage: "自动模式正在检查中，本次请求已跳过。"
        },
        startedThreadIds: [],
        startedCount: 0
      };
    }

    this.checking = true;
    try {
      const settings = await this.repo.getBoardAutomationSettings();
      if (!settings.enabled) {
        return {
          automation: await this.repo.toBoardAutomationDto(settings),
          startedThreadIds: [],
          startedCount: 0
        };
      }

      const snapshot = await this.repo.getBoardAutomationSnapshot(settings.wipLimit);
      const startedThreadIds: string[] = [];

      if (snapshot.wipCount >= settings.wipLimit) {
        const updated = await this.repo.recordBoardAutomationCheck({
          startedThreadIds,
          message: `WIP 已有 ${snapshot.wipCount} 个任务，达到自动模式上限。`
        });
        return {
          automation: await this.repo.toBoardAutomationDto(updated),
          startedThreadIds,
          startedCount: startedThreadIds.length
        };
      }

      if (snapshot.readyColumnThreads.length === 0) {
        const updated = await this.repo.recordBoardAutomationCheck({
          startedThreadIds,
          message: "Ready 栏为空，没有可自动启动的任务。"
        });
        return {
          automation: await this.repo.toBoardAutomationDto(updated),
          startedThreadIds,
          startedCount: startedThreadIds.length
        };
      }

      for (const candidate of snapshot.startCandidates) {
        try {
          const moved = await this.repo.moveThreadBoardStage(candidate.thread._id, "wip");
          if (moved.started && moved.task && moved.run) {
            this.worker.enqueue({
              threadId: moved.thread._id,
              taskId: moved.task._id,
              runId: moved.run._id
            });
            const threadDto = serializeThread(moved.thread);
            this.bus.publish({ type: "thread.updated", threadId: threadDto.id, thread: threadDto });
            startedThreadIds.push(threadDto.id);
          }
        } catch (error) {
          if (!(error instanceof RepositoryConflictError)) {
            throw error;
          }
        }
      }

      const message =
        startedThreadIds.length > 0
          ? `自动模式从 Ready 栏启动了 ${startedThreadIds.length} 个任务。`
          : reason === "manual"
            ? "Ready 栏没有可启动的 queued 任务。"
            : "本轮没有可自动启动的任务。";
      const updated = await this.repo.recordBoardAutomationCheck({
        startedThreadIds,
        message
      });
      return {
        automation: await this.repo.toBoardAutomationDto(updated),
        startedThreadIds,
        startedCount: startedThreadIds.length
      };
    } finally {
      this.checking = false;
    }
  }
}
