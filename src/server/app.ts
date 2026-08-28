import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import nodePath from "node:path";
import {
  batchCreateTaskThreadsInputSchema,
  bulkImportBacklogInputSchema,
  createTaskThreadApiInputSchema,
  createPostInputSchema,
  loginInputSchema,
  updateAppSettingsInputSchema,
  updateBacklogTaskInputSchema,
  updateBoardAutomationInputSchema,
  updateBoardDisplayInputSchema,
  updateBoardStageInputSchema
} from "../shared/schemas";
import type { AppConfig } from "./config";
import type { ThreadEventBus } from "./eventBus";
import { checkHealth } from "./health";
import type { AgentWorker } from "./worker";
import { RepositoryConflictError, RepositoryNotFoundError, type HarnessRepository } from "./repository";
import type { Collection, Db } from "mongodb";
import { createAuthService, ensureBootstrapAccount } from "./auth";
import type { AccountDoc, ServiceAccountDoc } from "./models";
import { serializeRun, serializeThread } from "./serializers";
import { BoardAutomationService } from "./boardAutomation";
import { parseBacklogImportCsv } from "./backlogImport";
import { createServiceAuthService, ensureBootstrapServiceAccount, type ServicePrincipal } from "./serviceAuth";
import type { BatchCreateThreadsDto, CreateThreadResultDto, StreamEvent } from "../shared/types";

declare module "fastify" {
  interface FastifyRequest {
    servicePrincipal?: ServicePrincipal;
  }
}

export interface ServerDeps {
  config: AppConfig;
  db: Db;
  repo: HarnessRepository;
  worker: AgentWorker;
  bus: ThreadEventBus;
  accounts: Collection<AccountDoc>;
  serviceAccounts: Collection<ServiceAccountDoc>;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  await ensureBootstrapAccount(deps.config.auth, deps.accounts);
  await ensureBootstrapServiceAccount(deps.config.serviceAuth, deps.serviceAccounts);
  const boardAutomation = new BoardAutomationService(deps.repo, deps.worker, deps.bus);
  const auth = createAuthService(deps.config.auth, deps.accounts);
  const serviceAuth = createServiceAuthService(deps.serviceAccounts);
  const loginAttempts = new Map<string, LoginAttemptState>();
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info"
    }
  });

  await app.register(cors, {
    origin: deps.config.corsOrigins,
    credentials: true
  });

  boardAutomation.start();
  app.addHook("onClose", async () => {
    boardAutomation.stop();
  });

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0] ?? request.url;
    if (request.method === "OPTIONS" || !pathname.startsWith("/api/") || pathname.startsWith("/api/auth/")) {
      return;
    }

    const servicePrincipal = await serviceAuth.authenticate(request.headers.authorization);
    if (servicePrincipal) {
      request.servicePrincipal = servicePrincipal;
      return;
    }

    if (!auth.enabled || (await auth.state(request.headers.cookie)).authenticated) {
      return;
    }
    return reply.code(401).send({ message: "请先登录" });
  });

  app.get("/api/auth/me", async (request) => auth.state(request.headers.cookie));

  app.post("/api/auth/login", async (request, reply) => {
    const parsed = loginInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "登录请求无效",
        issues: parsed.error.issues
      });
    }

    const loginKey = request.ip;
    if (isLoginRateLimited(loginAttempts, loginKey, deps.config.auth)) {
      return reply.code(429).send({ message: "登录尝试过多，请稍后再试" });
    }

    const result = await auth.login(parsed.data.username, parsed.data.password);
    if (!result) {
      recordLoginFailure(loginAttempts, loginKey, deps.config.auth);
      return reply.code(401).send({ message: "访问密码错误" });
    }
    clearLoginFailures(loginAttempts, loginKey);
    if (result.cookie) {
      reply.header("Set-Cookie", result.cookie);
    }
    return result.state;
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    const result = auth.logout();
    if (result.cookie) {
      reply.header("Set-Cookie", result.cookie);
    }
    return result.state;
  });

  app.get("/api/health", async () => checkHealth(deps.db, deps.config));

  app.get("/api/settings", async () => {
    return deps.repo.toAppSettingsDto(await deps.repo.getAppSettings());
  });

  app.patch("/api/settings", async (request, reply) => {
    const parsed = updateAppSettingsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid app settings",
        issues: parsed.error.issues
      });
    }
    const settings = await deps.repo.updateAppSettings(parsed.data);
    deps.worker.setConcurrency(settings.maxConcurrentTasks);
    await boardAutomation.refreshSchedule();
    return {
      settings: deps.repo.toAppSettingsDto(settings),
      automation: await boardAutomation.getState()
    };
  });

  app.get("/api/board-automation", async () => {
    return boardAutomation.getState();
  });

  app.patch("/api/board-automation", async (request, reply) => {
    const parsed = updateBoardAutomationInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid board automation setting",
        issues: parsed.error.issues
      });
    }
    return {
      automation: await boardAutomation.setEnabled(parsed.data.enabled)
    };
  });

  app.post("/api/board-automation/check", async () => {
    return boardAutomation.checkNow();
  });

  app.get("/api/local-directories", async (request, reply) => {
    const { path } = request.query as { path?: string };
    const targetPath = nodePath.resolve(path || deps.config.codexWorkspace);

    try {
      const stat = await fs.stat(targetPath);
      if (!stat.isDirectory()) {
        return reply.code(400).send({ message: "Path is not a directory" });
      }

      const entries = await fs.readdir(targetPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: nodePath.join(targetPath, entry.name)
        }))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
        .slice(0, 200);

      const parentPath = nodePath.dirname(targetPath);
      return {
        path: targetPath,
        parentPath: parentPath === targetPath ? undefined : parentPath,
        entries: directories
      };
    } catch (error) {
      return reply.code(400).send({
        message: error instanceof Error ? error.message : "Cannot read local directory"
      });
    }
  });

  app.get("/api/local-files/:threadId/*", async (request, reply) => {
    const { threadId } = request.params as { threadId: string };
    const relativePath = (request.params as { "*": string })["*"];
    if (!relativePath) {
      return reply.code(400).send({ message: "Invalid local file path" });
    }

    const thread = await deps.repo.findThreadByReference(threadId);
    if (!thread) {
      return reply.code(404).send({ message: "Thread not found" });
    }

    try {
      const rootPath = await fs.realpath(nodePath.resolve(thread.folder ?? deps.config.codexWorkspace));
      const requestedPath = nodePath.resolve(rootPath, relativePath);
      if (!isPathInside(rootPath, requestedPath)) {
        return reply.code(403).send({ message: "Local file is outside the thread folder" });
      }

      const targetPath = await fs.realpath(requestedPath);
      if (!isPathInside(rootPath, targetPath)) {
        return reply.code(403).send({ message: "Local file is outside the thread folder" });
      }

      const stat = await fs.stat(targetPath);
      if (!stat.isFile()) {
        return reply.code(404).send({ message: "Local file not found" });
      }
      if (stat.size > deps.config.localFileMaxBytes) {
        return reply.code(413).send({ message: "Local file exceeds the configured size limit" });
      }

      const mimeType = mimeTypeForPath(targetPath);
      reply
        .type(mimeType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `inline; filename="${encodeHeaderFilename(nodePath.basename(targetPath))}"`);
      if (isSandboxedMimeType(mimeType)) {
        reply.header("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups");
      }
      return reply.send(await fs.readFile(targetPath));
    } catch (error) {
      return reply.code(404).send({
        message: error instanceof Error ? error.message : "Local file not found"
      });
    }
  });

  app.get("/api/threads", async () => {
    return deps.repo.listThreads();
  });

  app.post("/api/threads", async (request, reply) => {
    const parsed = createTaskThreadApiInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid task thread",
        issues: parsed.error.issues
      });
    }
    if (parsed.data.externalTaskKey && !request.servicePrincipal) {
      return reply.code(401).send({ message: "externalTaskKey requires a Bearer service token" });
    }

    const created = await deps.repo.createTaskThread({
      ...parsed.data,
      externalTaskSource: request.servicePrincipal?.name
    });
    const payload: CreateThreadResultDto = {
      threadId: created.thread._id.toHexString(),
      publicTaskId: created.thread.publicTaskId,
      postId: created.rootPost._id.toHexString(),
      taskId: created.task._id.toHexString(),
      runId: created.run._id.toHexString(),
      created: created.created
    };
    return reply.code(created.created ? 201 : 200).send(payload);
  });

  app.post("/api/threads/batch", async (request, reply) => {
    const parsed = batchCreateTaskThreadsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid task batch",
        issues: parsed.error.issues
      });
    }
    if (parsed.data.tasks.some((task) => task.externalTaskKey) && !request.servicePrincipal) {
      return reply.code(401).send({ message: "externalTaskKey requires a Bearer service token" });
    }

    const items = await deps.repo.createTaskThreadsBatch({
      folder: parsed.data.folder,
      presetProjectId: parsed.data.presetProjectId,
      boardDisplay: parsed.data.boardDisplay,
      externalTaskSource: request.servicePrincipal?.name,
      tasks: parsed.data.tasks
    });

    const payload: BatchCreateThreadsDto = {
      createdCount: items.filter((item) => item.created).length,
      existingCount: items.filter((item) => !item.created).length,
      items: items.map((item) => ({
        threadId: item.thread._id.toHexString(),
        publicTaskId: item.thread.publicTaskId,
        postId: item.rootPost._id.toHexString(),
        taskId: item.task._id.toHexString(),
        runId: item.run._id.toHexString(),
        created: item.created,
        name: item.thread.name ?? item.thread.title,
        role: item.task.role ?? item.thread.role ?? "general",
        externalTaskKey: item.thread.externalTaskKey
      }))
    };

    return reply.code(payload.createdCount > 0 ? 201 : 200).send(payload);
  });

  app.post("/api/backlog/import/preview", async (request, reply) => {
    const parsed = bulkImportBacklogInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid backlog import",
        issues: parsed.error.issues
      });
    }

    return parseBacklogImportCsv(parsed.data.csv);
  });

  app.post("/api/backlog/import", async (request, reply) => {
    const parsed = bulkImportBacklogInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid backlog import",
        issues: parsed.error.issues
      });
    }

    const preview = parseBacklogImportCsv(parsed.data.csv);
    if (preview.errors.length > 0 || preview.rows.length === 0) {
      return reply.code(400).send({
        message: preview.errors[0]?.message ?? "CSV 没有可导入的任务。",
        ...preview
      });
    }

    const imported = await deps.repo.createBacklogImport({
      folder: parsed.data.folder,
      presetProjectId: parsed.data.presetProjectId,
      rows: preview.rows
    });
    const threads = imported.map((bundle) => serializeThread(bundle.thread));
    for (const thread of threads) {
      deps.bus.publish({ type: "thread.updated", threadId: thread.id, thread });
    }

    return reply.code(201).send({
      ...preview,
      importedCount: imported.length,
      threads
    });
  });

  app.get("/api/threads/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const detail = await deps.repo.getThreadDetailByReference(id);
    if (!detail) {
      return reply.code(404).send({ message: "Thread not found" });
    }
    return detail;
  });

  app.patch("/api/threads/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateBacklogTaskInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid backlog task",
        issues: parsed.error.issues
      });
    }

    try {
      const existingThread = await deps.repo.findThreadByReference(id);
      if (!existingThread) {
        return reply.code(404).send({ message: "Thread not found" });
      }
      const thread = await deps.repo.updateBacklogTask(existingThread._id, parsed.data);
      const threadDto = serializeThread(thread);
      deps.bus.publish({ type: "thread.updated", threadId: threadDto.id, thread: threadDto });
      return { thread: threadDto };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return reply.code(409).send({ message: error.message });
      }
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ message: error.message });
      }
      throw error;
    }
  });

  app.delete("/api/threads/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const existingThread = await deps.repo.findThreadByReference(id);
      if (!existingThread) {
        return reply.code(404).send({ message: "Thread not found" });
      }
      const thread = await deps.repo.deleteBacklogTask(existingThread._id);
      return {
        threadId: thread._id.toHexString(),
        publicTaskId: thread.publicTaskId,
        deleted: true
      };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return reply.code(409).send({ message: error.message });
      }
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ message: error.message });
      }
      throw error;
    }
  });

  app.patch("/api/threads/:id/board-stage", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateBoardStageInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid board stage",
        issues: parsed.error.issues
      });
    }

    try {
      const existingThread = await deps.repo.findThreadByReference(id);
      if (!existingThread) {
        return reply.code(404).send({ message: "Thread not found" });
      }
      const moved = await deps.repo.moveThreadBoardStage(existingThread._id, parsed.data.boardStage);
      if (moved.started && moved.task && moved.run) {
        deps.worker.enqueue({
          threadId: moved.thread._id,
          taskId: moved.task._id,
          runId: moved.run._id
        });
      }
      const threadDto = serializeThread(moved.thread);
      deps.bus.publish({ type: "thread.updated", threadId: threadDto.id, thread: threadDto });
      return {
        thread: threadDto,
        run: moved.run ? serializeRun(moved.run) : undefined,
        started: moved.started
      };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return reply.code(409).send({ message: error.message });
      }
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ message: error.message });
      }
      throw error;
    }
  });

  app.patch("/api/threads/:id/board-display", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateBoardDisplayInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid board display",
        issues: parsed.error.issues
      });
    }

    try {
      const existingThread = await deps.repo.findThreadByReference(id);
      if (!existingThread) {
        return reply.code(404).send({ message: "Thread not found" });
      }
      const thread = await deps.repo.updateThreadBoardDisplay(existingThread._id, parsed.data.boardDisplay);
      const threadDto = serializeThread(thread);
      deps.bus.publish({ type: "thread.updated", threadId: threadDto.id, thread: threadDto });
      return { thread: threadDto };
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return reply.code(409).send({ message: error.message });
      }
      if (error instanceof RepositoryNotFoundError) {
        return reply.code(404).send({ message: error.message });
      }
      throw error;
    }
  });

  app.get("/api/tasks/:id/heartbeat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const heartbeat = await deps.repo.getTaskHeartbeatByReference(id);
    if (!heartbeat) {
      return reply.code(404).send({ message: "Task not found" });
    }
    return heartbeat;
  });

  app.get("/api/threads/:id/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const thread = await deps.repo.findThreadByReference(id);
    if (!thread) {
      return reply.code(404).send({ message: "Thread not found" });
    }
    const threadId = thread._id.toHexString();

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });

    const send = (event: StreamEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    send({ type: "ready", threadId });
    const unsubscribe = deps.bus.subscribe(threadId, send);
    request.raw.on("close", unsubscribe);
  });

  app.post("/api/threads/:id/replies", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = createPostInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        message: "Invalid reply",
        issues: parsed.error.issues
      });
    }

    let created: Awaited<ReturnType<HarnessRepository["createReplyRunInThread"]>>;
    try {
      const existingThread = await deps.repo.findThreadByReference(id);
      if (!existingThread) {
        return reply.code(404).send({ message: "Thread not found" });
      }
      created = await deps.repo.createReplyRunInThread(existingThread._id, parsed.data);
    } catch (error) {
      if (error instanceof RepositoryConflictError) {
        return reply.code(409).send({ message: error.message });
      }
      return reply.code(404).send({
        message: error instanceof Error ? error.message : "Thread not found"
      });
    }

    return reply.code(201).send({
      threadId: created.thread._id.toHexString(),
      publicTaskId: created.thread.publicTaskId,
      postId: created.post._id.toHexString(),
      taskId: created.task._id.toHexString(),
      runId: created.run._id.toHexString()
    });
  });

  return app;
}

interface LoginAttemptState {
  count: number;
  resetAt: number;
}

function isLoginRateLimited(
  attempts: Map<string, LoginAttemptState>,
  key: string,
  config: AppConfig["auth"],
  now = Date.now()
): boolean {
  const state = attempts.get(key);
  if (!state) {
    return false;
  }
  if (state.resetAt <= now) {
    attempts.delete(key);
    return false;
  }
  return state.count >= config.loginMaxAttempts;
}

function recordLoginFailure(
  attempts: Map<string, LoginAttemptState>,
  key: string,
  config: AppConfig["auth"],
  now = Date.now()
): void {
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, {
      count: 1,
      resetAt: now + config.loginWindowMs
    });
    return;
  }
  attempts.set(key, {
    ...current,
    count: current.count + 1
  });
}

function clearLoginFailures(attempts: Map<string, LoginAttemptState>, key: string): void {
  attempts.delete(key);
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const relative = nodePath.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

function mimeTypeForPath(filePath: string): string {
  const extension = nodePath.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp"
  };
  return mimeTypes[extension] ?? "application/octet-stream";
}

function isSandboxedMimeType(mimeType: string): boolean {
  return mimeType.startsWith("text/html") || mimeType.startsWith("image/svg+xml");
}

function encodeHeaderFilename(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, "_");
}
