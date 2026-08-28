import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { FastifyInstance } from "fastify";
import { loadConfig, type AppConfig } from "./config";
import { AppServerCodexRunner } from "./codexRunner";
import { ensureIndexes, makeCollections, type Collections } from "./db";
import { ThreadEventBus } from "./eventBus";
import { HarnessRepository } from "./repository";
import { AgentWorker } from "./worker";
import { buildServer } from "./app";
import type { ThreadDoc } from "./models";
import { DEFAULT_CODEX_SYSTEM_PROMPT } from "../shared/schemas";

const codexE2eTest = process.env.HARNESS_SKIP_CODEX_E2E === "1" ? it.skip : it;

describe("Harness API and worker", () => {
  let replSet: MongoMemoryReplSet;
  let client: MongoClient;
  let collections: Collections;
  let app: FastifyInstance;
  let repo: HarnessRepository;
  let config: AppConfig;
  let localDir: string;
  let worker: AgentWorker;
  let bus: ThreadEventBus;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: "wiredTiger" }
    });
    client = new MongoClient(replSet.getUri());
    await client.connect();
    const db = client.db("harness_test");
    collections = makeCollections(db);
    await ensureIndexes(collections);
    localDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-test-"));
    config = loadConfig({
      mongoUri: replSet.getUri(),
      mongoDb: "harness_test",
      codexBin: process.env.CODEX_TEST_BIN ?? "codex",
      codexSandbox: "read-only",
      codexApproval: "never",
      codexReasoningEffort: "low",
      localDir,
      serviceAuth: {
        bootstrapToken: "test-service-token",
        bootstrapName: "codex-cli"
      },
      auth: {
        enabled: false,
        username: "admin",
        sessionTtlMs: 7 * 24 * 60 * 60 * 1000,
        cookieName: "harness_session",
        cookieSecure: false,
        loginMaxAttempts: 8,
        loginWindowMs: 5 * 60 * 1000
      }
    });
    repo = new HarnessRepository(client, collections);
    bus = new ThreadEventBus();
    worker = new AgentWorker(repo, new AppServerCodexRunner(config), bus, config);
    app = await buildServer({
      config,
      db,
      repo,
      worker,
      bus,
      accounts: collections.accounts,
      serviceAccounts: collections.serviceAccounts
    });
  }, 60000);

  afterAll(async () => {
    await worker.whenIdle();
    await app.close();
    await client.close();
    await replSet.stop();
    await fs.rm(localDir, { recursive: true, force: true });
  });

  it("backfills self-defined task ids and keeps them uniquely indexed", async () => {
    const now = new Date();
    const legacyThreadId = new ObjectId();
    await collections.threads.insertOne({
      _id: legacyThreadId,
      name: "Legacy task without public id",
      folder: localDir,
      title: "Legacy task without public id",
      status: "queued",
      boardStage: "ready",
      boardDisplay: "auto",
      currentVersionText: "Legacy task",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now
    } as ThreadDoc);

    await ensureIndexes(collections);

    const legacyThread = await collections.threads.findOne({ _id: legacyThreadId });
    expect(legacyThread?.publicTaskId).toMatch(/^HT-\d{8}-[0-9A-Z]{7}$/);
    expect(legacyThread?.role).toBe("general");
    const indexes = await collections.threads.indexes();
    expect(indexes.some((index) => index.unique === true && index.key.publicTaskId === 1)).toBe(true);
  });

  it("keeps Ready and Done as real stages while storing board display preferences", async () => {
    const suffix = Date.now();
    const readyPrefix = `Ready library ${suffix}`;
    const donePrefix = `Done library ${suffix}`;
    const baseMs = Date.now();
    let firstReadyThreadId = "";
    let firstDoneThreadId = "";

    for (let index = 0; index < 12; index += 1) {
      const created = await repo.createTaskThread({
        folder: localDir,
        name: `${readyPrefix} ${index}`,
        role: "general",
        body: `Ready cap task ${index}`,
        refs: []
      });
      const lastActivityAt = new Date(baseMs + index * 1000);
      await collections.threads.updateOne(
        { _id: created.thread._id },
        { $set: { boardStage: "ready", lastActivityAt, updatedAt: lastActivityAt } }
      );
      firstReadyThreadId ||= created.thread._id.toHexString();
    }

    for (let index = 0; index < 12; index += 1) {
      const created = await repo.createTaskThread({
        folder: localDir,
        name: `${donePrefix} ${index}`,
        role: "general",
        body: `Done cap task ${index}`,
        refs: []
      });
      const lastActivityAt = new Date(baseMs + index * 1000);
      await collections.threads.updateOne(
        { _id: created.thread._id },
        { $set: { boardStage: "done", status: "delivered", lastActivityAt, updatedAt: lastActivityAt } }
      );
      firstDoneThreadId ||= created.thread._id.toHexString();
    }

    await repo.listThreads();

    await expect(collections.threads.countDocuments({ name: { $regex: `^${readyPrefix}` }, boardStage: "ready" })).resolves.toBe(12);
    await expect(collections.threads.countDocuments({ name: { $regex: `^${donePrefix}` }, boardStage: "done" })).resolves.toBe(12);

    const readyDisplayResponse = await app.inject({
      method: "PATCH",
      url: `/api/threads/${firstReadyThreadId}/board-display`,
      payload: { boardDisplay: "shown" }
    });
    expect(readyDisplayResponse.statusCode).toBe(200);
    expect(readyDisplayResponse.json()).toMatchObject({
      thread: {
        id: firstReadyThreadId,
        boardStage: "ready",
        boardDisplay: "shown"
      }
    });

    const doneDisplayResponse = await app.inject({
      method: "PATCH",
      url: `/api/threads/${firstDoneThreadId}/board-display`,
      payload: { boardDisplay: "hidden" }
    });
    expect(doneDisplayResponse.statusCode).toBe(200);
    expect(doneDisplayResponse.json()).toMatchObject({
      thread: {
        id: firstDoneThreadId,
        boardStage: "done",
        boardDisplay: "hidden"
      }
    });

    const rejectedBacklogStage = await app.inject({
      method: "PATCH",
      url: `/api/threads/${firstReadyThreadId}/board-stage`,
      payload: { boardStage: "backlog" }
    });
    expect(rejectedBacklogStage.statusCode).toBe(400);
  });

  it("selects automation candidates from the displayed Ready column only", async () => {
    const suffix = Date.now();
    const prefix = `Automation Ready ${suffix}`;
    const baseMs = Date.now() + 60 * 60 * 1000;
    const created: Array<{ index: number; threadId: ObjectId }> = [];

    for (let index = 0; index < 12; index += 1) {
      const bundle = await repo.createTaskThread({
        folder: localDir,
        name: `${prefix} ${index}`,
        role: "general",
        body: `Automation ready task ${index}`,
        refs: []
      });
      const lastActivityAt = new Date(baseMs + index * 1000);
      await collections.threads.updateOne(
        { _id: bundle.thread._id },
        { $set: { boardStage: "ready", boardDisplay: "auto", lastActivityAt, updatedAt: lastActivityAt } }
      );
      created.push({ index, threadId: bundle.thread._id });
    }

    const snapshot = await repo.getBoardAutomationSnapshot(20);
    const visibleNames = snapshot.readyColumnThreads
      .filter((thread) => thread.name?.startsWith(prefix))
      .map((thread) => thread.name);
    expect(visibleNames).toEqual(Array.from({ length: 10 }, (_, offset) => `${prefix} ${11 - offset}`));

    await Promise.all([
      collections.threads.updateOne({ _id: created[0].threadId }, { $set: { boardDisplay: "shown" } }),
      collections.threads.updateOne({ _id: created[11].threadId }, { $set: { boardDisplay: "hidden" } })
    ]);

    const adjustedSnapshot = await repo.getBoardAutomationSnapshot(20);
    const adjustedNames = adjustedSnapshot.readyColumnThreads
      .filter((thread) => thread.name?.startsWith(prefix))
      .map((thread) => thread.name);
    expect(adjustedNames).toContain(`${prefix} 0`);
    expect(adjustedNames).not.toContain(`${prefix} 11`);
    expect(adjustedNames).not.toContain(`${prefix} 12`);
  });

  it("exposes board automation settings and respects the WIP cap without starting Codex", async () => {
    const suffix = Date.now();
    const ready = await repo.createTaskThread({
      folder: localDir,
      name: `Automation cap ready ${suffix}`,
      role: "general",
      body: "这个任务不应该在 WIP 已满时启动。",
      refs: []
    });
    const baseMs = Date.now() + 2 * 60 * 60 * 1000;
    await collections.threads.updateOne(
      { _id: ready.thread._id },
      { $set: { boardStage: "ready", boardDisplay: "shown", lastActivityAt: new Date(baseMs) } }
    );

    for (let index = 0; index < 5; index += 1) {
      const wip = await repo.createTaskThread({
        folder: localDir,
        name: `Automation cap WIP ${suffix} ${index}`,
        role: "general",
        body: `WIP cap task ${index}`,
        refs: []
      });
      await collections.threads.updateOne(
        { _id: wip.thread._id },
        { $set: { boardStage: "wip", status: "running", lastActivityAt: new Date(baseMs + index + 1) } }
      );
      await collections.runs.updateOne(
        { _id: wip.run._id },
        { $set: { status: "running", phase: "execute", startedAt: new Date(baseMs + index + 1) } }
      );
    }

    const initial = await app.inject({
      method: "GET",
      url: "/api/board-automation"
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      enabled: false,
      wipLimit: 5,
      intervalMs: 300000
    });

    const enabled = await app.inject({
      method: "PATCH",
      url: "/api/board-automation",
      payload: { enabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    const enabledBody = enabled.json();
    expect(enabledBody).toMatchObject({
      automation: {
        enabled: true,
        wipLimit: 5
      }
    });
    expect(enabledBody.automation.lastMessage).toContain("WIP");
    expect(enabledBody.automation.lastCheckedAt).toEqual(expect.any(String));

    const check = await app.inject({
      method: "POST",
      url: "/api/board-automation/check"
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({
      startedCount: 0,
      startedThreadIds: [],
      automation: {
        enabled: true,
        wipLimit: 5
      }
    });
    expect(check.json().automation.lastMessage).toContain("WIP");

    const readyDetail = await repo.getThreadDetail(ready.thread._id);
    expect(readyDetail?.thread.boardStage).toBe("ready");
    expect(readyDetail?.run?.status).toBe("queued");

    await app.inject({
      method: "PATCH",
      url: "/api/board-automation",
      payload: { enabled: false }
    });
  });

  it("persists app settings, syncs automation config, and updates worker concurrency", async () => {
    const initial = await app.inject({
      method: "GET",
      url: "/api/settings"
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      autoRunIntervalMinutes: 5,
      maxConcurrentTasks: 5,
      codexThreadPrefix: "[Harness]",
      systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
      presetProjects: []
    });

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: {
        autoRunIntervalMinutes: 3,
        maxConcurrentTasks: 2,
        codexThreadPrefix: "[Lab]",
        systemPrompt: "你是测试 Agent。\n请只回复测试结果。",
        presetProjects: [
          {
            id: "example-app",
            name: "ExampleApp",
            folder: path.join(localDir, "ExampleApp"),
            roleInitialInstructions: {
              se: "先检查现有实现",
              art: "",
              design: "先梳理需求边界",
              music: "",
              general: "先列出关键假设"
            }
          }
        ]
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      settings: {
        autoRunIntervalMinutes: 3,
        maxConcurrentTasks: 2,
        codexThreadPrefix: "[Lab]",
        systemPrompt: "你是测试 Agent。\n请只回复测试结果。",
        presetProjects: [
          {
            id: "example-app",
            name: "ExampleApp",
            folder: path.join(localDir, "ExampleApp"),
            roleInitialInstructions: {
              se: "先检查现有实现",
              design: "先梳理需求边界",
              general: "先列出关键假设"
            }
          }
        ]
      },
      automation: {
        wipLimit: 2,
        intervalMs: 180000
      }
    });
    expect(worker.getConcurrency()).toBe(2);

    const stored = await collections.appSettings.findOne({ _id: "app_settings" });
    expect(stored?.autoRunIntervalMinutes).toBe(3);
    expect(stored?.maxConcurrentTasks).toBe(2);
    expect(stored?.codexThreadPrefix).toBe("[Lab]");
    expect(stored?.systemPrompt).toBe("你是测试 Agent。\n请只回复测试结果。");
    expect(stored?.presetProjects).toEqual([
        {
          id: "example-app",
          name: "ExampleApp",
          folder: path.join(localDir, "ExampleApp"),
          roleInitialInstructions: {
            se: "先检查现有实现",
            art: "",
            design: "先梳理需求边界",
            music: "",
            general: "先列出关键假设"
          }
        }
      ]);
    expect(stored?.roleInitialInstructions).toBeUndefined();

    const automationDoc = await collections.boardAutomation.findOne({ _id: "board_automation" });
    expect(automationDoc?.wipLimit).toBe(2);
    expect(automationDoc?.intervalMs).toBe(180000);
  });

  it("edits and deletes queued Backlog tasks only", async () => {
    const created = await repo.createTaskThread({
      folder: localDir,
      name: "待修改 Backlog 任务",
      role: "se",
      body: "原始任务内容",
      refs: []
    });
    const threadId = created.thread._id.toHexString();

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/threads/${threadId}`,
      payload: {
        name: "已修改 Backlog 任务",
        role: "music",
        body: "新的任务内容"
      }
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateResponse.json()).toMatchObject({
      thread: {
        id: threadId,
        name: "已修改 Backlog 任务",
        role: "music",
        boardStage: "ready",
        status: "queued",
        currentVersionText: "新的任务内容"
      }
    });

    const updatedDetail = await repo.getThreadDetail(created.thread._id);
    expect(updatedDetail?.thread.name).toBe("已修改 Backlog 任务");
    expect(updatedDetail?.thread.role).toBe("music");
    expect(updatedDetail?.task?.role).toBe("music");
    expect(updatedDetail?.posts.find((post) => post.id === created.rootPost._id.toHexString())?.body).toBe("新的任务内容");
    expect(updatedDetail?.task?.taskSpec.rawRequest).toBe("新的任务内容");
    expect(updatedDetail?.versions[0]?.summaryText).toBe("新的任务内容");
    const updatedListItem = (await repo.listThreads()).find((thread) => thread.id === threadId);
    expect(updatedListItem?.postCount).toBe(0);
    expect(updatedListItem?.latestPost).toBeUndefined();

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/threads/${threadId}`
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toEqual({
      threadId,
      publicTaskId: created.thread.publicTaskId,
      deleted: true
    });
    await expect(collections.threads.countDocuments({ _id: created.thread._id })).resolves.toBe(0);
    await expect(collections.posts.countDocuments({ threadId: created.thread._id })).resolves.toBe(0);
    await expect(collections.tasks.countDocuments({ threadId: created.thread._id })).resolves.toBe(0);
    await expect(collections.runs.countDocuments({ taskId: created.task._id })).resolves.toBe(0);
    await expect(collections.taskVersions.countDocuments({ taskId: created.task._id })).resolves.toBe(0);
    await expect(collections.events.countDocuments({ threadId: created.thread._id })).resolves.toBe(0);

    const running = await repo.createTaskThread({
      folder: localDir,
      name: "运行中不可编辑",
      role: "general",
      body: "运行中任务内容",
      refs: []
    });
    await Promise.all([
      collections.threads.updateOne({ _id: running.thread._id }, { $set: { boardStage: "wip", status: "running" } }),
      collections.runs.updateOne({ _id: running.run._id }, { $set: { status: "running", phase: "execute", startedAt: new Date() } })
    ]);

    const rejectedUpdate = await app.inject({
      method: "PATCH",
      url: `/api/threads/${running.thread._id.toHexString()}`,
      payload: {
        name: "不应该成功",
        body: "不应该成功"
      }
    });
    expect(rejectedUpdate.statusCode).toBe(409);

    const rejectedDelete = await app.inject({
      method: "DELETE",
      url: `/api/threads/${running.thread._id.toHexString()}`
    });
    expect(rejectedDelete.statusCode).toBe(409);
  });

  it("previews and imports CSV rows into hidden Backlog tasks", async () => {
    const csv = [
      "client_key,name,role,body",
      "US-101,批量任务一,se,实现批量任务一",
      "US-102,批量任务二,music,\"实现批量任务二，包含逗号\""
    ].join("\n");

    const preview = await app.inject({
      method: "POST",
      url: "/api/backlog/import/preview",
      payload: {
        folder: localDir,
        csv
      }
    });

    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      totalRows: 2,
      validRows: 2,
      errors: []
    });
    expect(preview.json().rows.map((row: { role: string }) => row.role)).toEqual(["se", "music"]);

    const imported = await app.inject({
      method: "POST",
      url: "/api/backlog/import",
      payload: {
        folder: localDir,
        csv
      }
    });

    expect(imported.statusCode).toBe(201);
    expect(imported.json()).toMatchObject({
      importedCount: 2,
      totalRows: 2,
      validRows: 2
    });

    const threads = await collections.threads.find({ name: { $regex: "^批量任务" } }).sort({ name: 1 }).toArray();
    expect(threads).toHaveLength(2);
    expect(threads.map((thread) => thread.boardStage)).toEqual(["ready", "ready"]);
    expect(threads.map((thread) => thread.boardDisplay)).toEqual(["hidden", "hidden"]);
    expect(threads.map((thread) => thread.role)).toEqual(["se", "music"]);
    expect(threads.map((thread) => thread.folder)).toEqual([localDir, localDir]);

    const taskIds = threads.flatMap((thread) => (thread.currentTaskId ? [thread.currentTaskId] : []));
    const tasks = await collections.tasks.find({ _id: { $in: taskIds } }).toArray();
    expect(tasks.map((task) => task.role).sort()).toEqual(["music", "se"]);
    const runs = await collections.runs.find({ taskId: { $in: taskIds } }).toArray();
    expect(runs.map((run) => run.status).sort()).toEqual(["queued", "queued"]);
    expect(runs.every((run) => run.metadata.source === "api.backlog.import")).toBe(true);
    expect(runs.map((run) => run.metadata.role).sort()).toEqual(["music", "se"]);

    const posts = await collections.posts.find({ threadId: { $in: threads.map((thread) => thread._id) } }).toArray();
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.authorType === "user" && post.postType === "root")).toBe(true);
  });

  it("rejects invalid CSV imports without creating tasks", async () => {
    const beforeCount = await collections.threads.countDocuments({ name: "错误导入任务" });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/backlog/import",
      payload: {
        folder: localDir,
        csv: "client_key,name,role,body\nBAD-1,错误导入任务,se,"
      }
    });

    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({
      message: "body 不能为空。",
      totalRows: 1,
      validRows: 0
    });

    const rejectedRole = await app.inject({
      method: "POST",
      url: "/api/backlog/import",
      payload: {
        folder: localDir,
        csv: "client_key,name,role,body\nBAD-2,错误角色,运营,实现错误角色任务"
      }
    });

    expect(rejectedRole.statusCode).toBe(400);
    expect(rejectedRole.json()).toMatchObject({
      message: "role 必须是 se/程序、art/美术、design/策划、music/音乐、general/综合。",
      totalRows: 1,
      validRows: 0
    });
    await expect(collections.threads.countDocuments({ name: "错误导入任务" })).resolves.toBe(beforeCount);
  });

  it("supports Bearer-token task intake with idempotent external task keys", async () => {
    const headers = { authorization: "Bearer test-service-token" };

    const created = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers,
      payload: {
        folder: localDir,
        presetProjectId: "example-app",
        name: "CLI 单任务",
        role: "se",
        body: "通过 CLI 创建的单个任务",
        externalTaskKey: "CLI-101"
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      created: true
    });

    const duplicated = await app.inject({
      method: "POST",
      url: "/api/threads",
      headers,
      payload: {
        folder: localDir,
        name: "CLI 单任务",
        role: "se",
        body: "通过 CLI 创建的单个任务",
        externalTaskKey: "CLI-101"
      }
    });
    expect(duplicated.statusCode).toBe(200);
    expect(duplicated.json()).toMatchObject({
      created: false,
      publicTaskId: created.json<{ publicTaskId: string }>().publicTaskId
    });

    const thread = await repo.findThreadByReference(created.json<{ publicTaskId: string }>().publicTaskId);
    expect(thread).toMatchObject({
      externalTaskSource: "codex-cli",
      externalTaskKey: "CLI-101",
      presetProjectId: "example-app"
    });

    const batch = await app.inject({
      method: "POST",
      url: "/api/threads/batch",
      headers,
      payload: {
        folder: localDir,
        presetProjectId: "example-app",
        boardDisplay: "hidden",
        tasks: [
          {
            name: "CLI 批量任务一",
            role: "design",
            body: "批量任务一",
            externalTaskKey: "CLI-201"
          },
          {
            name: "CLI 批量任务二",
            role: "music",
            body: "批量任务二",
            externalTaskKey: "CLI-202"
          },
          {
            name: "CLI 单任务",
            role: "se",
            body: "通过 CLI 创建的单个任务",
            externalTaskKey: "CLI-101"
          }
        ]
      }
    });

    expect(batch.statusCode).toBe(201);
    expect(batch.json()).toMatchObject({
      createdCount: 2,
      existingCount: 1
    });

    const importedThreads = await collections.threads
      .find({ externalTaskSource: "codex-cli", externalTaskKey: { $in: ["CLI-201", "CLI-202"] } })
      .toArray();
    expect(importedThreads).toHaveLength(2);
    expect(importedThreads.every((next) => next.boardDisplay === "hidden")).toBe(true);
    expect(importedThreads.every((next) => next.presetProjectId === "example-app")).toBe(true);
  });

  it("rejects external task keys without a Bearer token", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      payload: {
        folder: localDir,
        name: "未授权外部键",
        role: "general",
        body: "不应该通过",
        externalTaskKey: "NO-TOKEN-1"
      }
    });

    expect(response.statusCode).toBe(401);
  });

  codexE2eTest("creates a Ready card, starts it from WIP, reviews it, and allows a replied rerun", async () => {
    await repo.updateAppSettings({
      autoRunIntervalMinutes: 5,
      maxConcurrentTasks: 5,
      codexThreadPrefix: "[Harness]",
      systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
      presetProjects: []
    });
    worker.setConcurrency(5);

    const threadResponse = await app.inject({
      method: "POST",
      url: "/api/threads",
      payload: {
        folder: localDir,
        name: "真实 Codex 闭环",
        role: "se",
        body: "不要改文件，不要调用工具，只回复：测试任务已完成。"
      }
    });

    expect(threadResponse.statusCode).toBe(201);
    const created = threadResponse.json<{ threadId: string; publicTaskId: string; taskId: string }>();
    expect(created.publicTaskId).toMatch(/^HT-\d{8}-[0-9A-Z]{7}$/);

    const readyDetail = await repo.getThreadDetail(new ObjectId(created.threadId));
    expect(readyDetail?.thread).toMatchObject({
      publicTaskId: created.publicTaskId,
      status: "queued",
      boardStage: "ready",
      folder: localDir,
      role: "se",
      name: "真实 Codex 闭环"
    });
    expect(readyDetail?.task?.role).toBe("se");
    expect(readyDetail?.posts.some((post) => post.replyType === "ack")).toBe(false);
    expect(readyDetail?.run?.status).toBe("queued");

    const publicDetailResponse = await app.inject({
      method: "GET",
      url: `/api/threads/${created.publicTaskId}`
    });
    expect(publicDetailResponse.statusCode).toBe(200);
    expect(publicDetailResponse.json()).toMatchObject({
      thread: {
        id: created.threadId,
        publicTaskId: created.publicTaskId
      }
    });

    const startResponse = await app.inject({
      method: "PATCH",
      url: `/api/threads/${created.publicTaskId}/board-stage`,
      payload: { boardStage: "wip" }
    });
    expect(startResponse.statusCode).toBe(200);
    expect(startResponse.json()).toMatchObject({
      started: true,
      thread: {
        id: created.threadId,
        boardStage: "wip"
      }
    });

    const detail = await waitFor(async () => {
      const next = await repo.getThreadDetail(new ObjectId(created.threadId));
      if (
        !next?.posts.some((post) => post.replyType === "result") ||
        next.run?.status !== "completed" ||
        next.thread.boardStage !== "review"
      ) {
        throw new Error("result post not ready");
      }
      return next;
    }, 180000);

    expect(detail.thread.status).toBe("delivered");
    expect(detail.thread.boardStage).toBe("review");
    expect(detail.thread.folder).toBe(localDir);
    expect(detail.thread.name).toBe("真实 Codex 闭环");
    const replyTypes = detail.posts.map((post) => post.replyType);
    const ackPost = detail.posts.find((post) => post.replyType === "ack");
    expect(replyTypes).toContain("ack");
    expect(replyTypes).not.toContain("progress");
    expect(replyTypes).toContain("result");
    expect(ackPost?.body).toContain("Codex 已启动");
    expect(detail.run?.status).toBe("completed");
    expect(detail.run?.codexSessionRef).toMatch(/^app-server:/);
    expect(detail.run?.metadata.runner).toBe("app-server");
    expect(detail.run?.metadata.cwd).toBe(localDir);
    const firstAppServerThreadId = detail.run?.metadata.appServerThreadId;
    if (typeof firstAppServerThreadId !== "string") {
      throw new Error("first app-server thread id missing");
    }
    expect(detail.run?.metadata.appServerThreadReused).toBe(false);
    await expect(readAppServerThreadName(config, firstAppServerThreadId, localDir)).resolves.toBe(
      "[Harness]-程序-真实 Codex 闭环"
    );

    const heartbeatResponse = await app.inject({
      method: "GET",
      url: `/api/tasks/${created.publicTaskId}/heartbeat`
    });

    expect(heartbeatResponse.statusCode).toBe(200);
    expect(heartbeatResponse.json()).toMatchObject({
      taskId: created.taskId,
      publicTaskId: created.publicTaskId,
      threadId: created.threadId,
      state: "completed",
      label: "完成",
      isTerminal: true,
      runStatus: "completed"
    });

    const doneResponse = await app.inject({
      method: "PATCH",
      url: `/api/threads/${created.threadId}/board-stage`,
      payload: { boardStage: "done" }
    });
    expect(doneResponse.statusCode).toBe(200);
    expect(doneResponse.json()).toMatchObject({
      started: false,
      thread: {
        id: created.threadId,
        boardStage: "done",
        status: "delivered"
      },
      run: {
        status: "completed"
      }
    });

    const rejectedRerun = await app.inject({
      method: "PATCH",
      url: `/api/threads/${created.threadId}/board-stage`,
      payload: { boardStage: "wip" }
    });
    expect(rejectedRerun.statusCode).toBe(409);

    const replyResponse = await app.inject({
      method: "POST",
      url: `/api/threads/${created.threadId}/replies`,
      payload: {
        body: "继续验证：不要改文件，不要调用工具，只回复：第二轮测试任务已完成。"
      }
    });
    expect(replyResponse.statusCode).toBe(201);
    const replied = replyResponse.json<{ runId: string }>();

    const afterReply = await repo.getThreadDetail(new ObjectId(created.threadId));
    expect(afterReply?.thread.boardStage).toBe("ready");
    expect(afterReply?.run?.id).toBe(replied.runId);
    expect(afterReply?.run?.status).toBe("queued");

    const rerunResponse = await app.inject({
      method: "PATCH",
      url: `/api/threads/${created.threadId}/board-stage`,
      payload: { boardStage: "wip" }
    });
    expect(rerunResponse.statusCode).toBe(200);
    expect(rerunResponse.json()).toMatchObject({ started: true });

    const rerunDetail = await waitFor(async () => {
      const next = await repo.getThreadDetail(new ObjectId(created.threadId));
      if (next?.run?.id !== replied.runId || next.run.status !== "completed" || next.thread.boardStage !== "review") {
        throw new Error("rerun result not ready");
      }
      return next;
    }, 180000);

    expect(rerunDetail.posts.some((post) => post.replyType === "result" && post.runId === replied.runId)).toBe(true);
    expect(rerunDetail.run?.metadata.appServerThreadId).toBe(firstAppServerThreadId);
    expect(rerunDetail.run?.metadata.appServerThreadReused).toBe(true);
    expect(rerunDetail.run?.codexSessionRef).toContain(`app-server:${firstAppServerThreadId}:`);
  }, 360000);

  it("reports a long-running task heartbeat without failing the run", async () => {
    const created = await repo.createTaskThread({
      folder: localDir,
      name: "长时间运行状态",
      role: "general",
      body: "模拟一个仍在运行的长任务。",
      refs: []
    });
    const startedAt = new Date(Date.now() - 31 * 60 * 1000);
    const lastEventAt = new Date(Date.now() - 60 * 1000);

    await Promise.all([
      collections.tasks.updateOne({ _id: created.task._id }, { $set: { status: "running", updatedAt: lastEventAt } }),
      collections.threads.updateOne({ _id: created.thread._id }, { $set: { status: "running", updatedAt: lastEventAt } }),
      collections.runs.updateOne(
        { _id: created.run._id },
        {
          $set: {
            status: "running",
            phase: "execute",
            startedAt,
            lastEventAt
          }
        }
      )
    ]);

    const response = await app.inject({
      method: "GET",
      url: `/api/tasks/${created.task._id.toHexString()}/heartbeat`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      state: "long_running",
      label: "长时间运行",
      isTerminal: false,
      runStatus: "running",
      runPhase: "execute"
    });
  });

  it("recovers orphaned running WIP runs as interrupted failures", async () => {
    const created = await repo.createTaskThread({
      folder: localDir,
      name: "孤立运行恢复",
      role: "general",
      body: "模拟一个后端重启前仍在运行的任务。",
      refs: []
    });
    const startedAt = new Date(Date.now() - 10 * 60 * 1000);
    const lastEventAt = new Date(Date.now() - 5 * 60 * 1000);

    await Promise.all([
      collections.tasks.updateOne({ _id: created.task._id }, { $set: { status: "running", updatedAt: lastEventAt } }),
      collections.threads.updateOne(
        { _id: created.thread._id },
        { $set: { status: "running", boardStage: "wip", updatedAt: lastEventAt, lastActivityAt: lastEventAt } }
      ),
      collections.runs.updateOne(
        { _id: created.run._id },
        {
          $set: {
            status: "running",
            phase: "execute",
            startedAt,
            lastEventAt
          }
        }
      )
    ]);

    const recovered = await worker.recoverInterruptedRunningRuns();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const detail = await repo.getThreadDetail(created.thread._id);
    expect(detail?.thread.boardStage).toBe("wip");
    expect(detail?.thread.status).toBe("failed");
    expect(detail?.run?.status).toBe("failed");
    expect(detail?.run?.exitReason).toContain("worker observer lost");
    expect(
      detail?.posts.some((post) => post.replyType === "failure" && post.body.includes("执行中断"))
    ).toBe(true);
  });

  it("lists local directories for thread creation", async () => {
    const childDir = path.join(localDir, "workspace-a");
    await fs.mkdir(childDir, { recursive: true });

    const response = await app.inject({
      method: "GET",
      url: `/api/local-directories?path=${encodeURIComponent(localDir)}`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      path: localDir,
      entries: expect.arrayContaining([
        {
          name: "workspace-a",
          path: childDir
        }
      ])
    });
  });

  it("only emits CORS credentials for configured origins", async () => {
    const allowed = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://127.0.0.1:5173" }
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const rejected = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://untrusted.example" }
    });
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves local files only from the thread folder", async () => {
    const htmlPath = path.join(localDir, "landing.html");
    const imagePath = path.join(localDir, "preview.png");
    const symlinkPath = path.join(localDir, "escape.html");
    const outsidePath = path.join(os.tmpdir(), `harness-outside-${Date.now()}.html`);
    await fs.writeFile(htmlPath, "<!doctype html><title>Landing</title>", "utf8");
    await fs.writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    await fs.writeFile(outsidePath, "<!doctype html><title>Outside</title>", "utf8");
    await fs.symlink(outsidePath, symlinkPath);
    const created = await repo.createTaskThread({
      folder: localDir,
      name: "本地文件链接",
      role: "general",
      body: "生成 landing 页面",
      refs: []
    });

    const served = await app.inject({
      method: "GET",
      url: `/api/local-files/${created.thread._id.toHexString()}/landing.html`
    });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("text/html");
    expect(served.headers["content-security-policy"]).toContain("sandbox");
    expect(served.body).toContain("<title>Landing</title>");

    const servedImage = await app.inject({
      method: "GET",
      url: `/api/local-files/${created.thread._id.toHexString()}/preview.png`
    });
    expect(servedImage.statusCode).toBe(200);
    expect(servedImage.headers["content-type"]).toContain("image/png");
    expect(servedImage.headers["content-security-policy"]).toBeUndefined();

    const previousFileLimit = config.localFileMaxBytes;
    config.localFileMaxBytes = 4;
    const oversized = await app.inject({
      method: "GET",
      url: `/api/local-files/${created.thread._id.toHexString()}/landing.html`
    });
    config.localFileMaxBytes = previousFileLimit;
    expect(oversized.statusCode).toBe(413);

    const rejected = await app.inject({
      method: "GET",
      url: `/api/local-files/${created.thread._id.toHexString()}/escape.html`
    });
    expect(rejected.statusCode).toBe(403);

    await fs.rm(outsidePath, { force: true });
  });

  it("rejects user posts over the 500 character limit", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/threads",
      payload: {
        folder: localDir,
        name: "长度校验",
        body: "x".repeat(501)
      }
    });

    expect(response.statusCode).toBe(400);
  });

  it("protects API routes when auth is enabled", async () => {
    const authApp = await buildServer({
      config: {
        ...config,
        auth: {
          ...config.auth,
          enabled: true,
          password: "secret-password",
          sessionSecret: "test-session-secret"
        }
      },
      db: client.db("harness_test"),
      repo,
      worker,
      bus,
      accounts: collections.accounts,
      serviceAccounts: collections.serviceAccounts
    });

    try {
      const account = await collections.accounts.findOne({ username: "admin" });
      expect(account).toMatchObject({
        username: "admin",
        role: "admin",
        status: "active"
      });
      expect(account?.passwordHash).toMatch(/^scrypt\$/);

      const denied = await authApp.inject({
        method: "GET",
        url: "/api/threads"
      });
      expect(denied.statusCode).toBe(401);

      const me = await authApp.inject({
        method: "GET",
        url: "/api/auth/me"
      });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        enabled: true,
        authenticated: false
      });

      const badLogin = await authApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong-password" }
      });
      expect(badLogin.statusCode).toBe(401);

      const badUsername = await authApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "other-user", password: "secret-password" }
      });
      expect(badUsername.statusCode).toBe(401);

      const login = await authApp.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "secret-password" }
      });
      expect(login.statusCode).toBe(200);
      expect(login.json()).toMatchObject({
        enabled: true,
        authenticated: true
      });

      const cookie = extractCookie(login.headers["set-cookie"]);
      expect(cookie).toContain("harness_session=");

      const allowed = await authApp.inject({
        method: "GET",
        url: "/api/threads",
        headers: { cookie }
      });
      expect(allowed.statusCode).toBe(200);

      const logout = await authApp.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie }
      });
      expect(logout.statusCode).toBe(200);
      expect(extractCookie(logout.headers["set-cookie"])).toContain("Max-Age=0");
    } finally {
      await authApp.close();
    }
  });
});

function extractCookie(header: string | string[] | number | undefined): string {
  if (Array.isArray(header)) {
    return header[0] ?? "";
  }
  return typeof header === "string" ? header : "";
}

async function waitFor<T>(callback: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const started = Date.now();
  let lastError: unknown;

  while (Date.now() - started < timeoutMs) {
    try {
      return await callback();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("waitFor timed out");
}

async function readAppServerThreadName(config: AppConfig, threadId: string, cwd: string): Promise<string | undefined> {
  const rpc = new AppServerRpcClient(config.codexBin, cwd);
  try {
    await rpc.initialize();
    const response = await rpc.request<{ thread?: { name?: string | null } }>("thread/read", {
      threadId,
      includeTurns: false
    });
    return response.thread?.name ?? undefined;
  } finally {
    await rpc.close();
  }
}

class AppServerRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private nextRequestId = 1;
  private buffer = "";
  private closed = false;

  constructor(codexBin: string, cwd: string) {
    this.child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flushBuffer();
    });
    this.child.on("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Codex app-server exited before the request completed"));
      }
      this.pending.clear();
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "tweet-native-ai-harness-test",
        title: "Tweet-Native AI Harness Test",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30000): Promise<T> {
    if (this.closed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new Error("Codex app-server stdin is closed");
    }
    const id = this.nextRequestId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.child.kill("SIGTERM");
    await waitFor(() => Promise.resolve(this.closed || this.child.killed).then((done) => {
      if (!done) {
        throw new Error("waiting for app-server close");
      }
    }), 3000).catch(() => {
      this.child.kill("SIGKILL");
    });
  }

  private flushBuffer(): void {
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) {
        const parsed = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof parsed.id === "number") {
          const pending = this.pending.get(parsed.id);
          if (pending) {
            this.pending.delete(parsed.id);
            clearTimeout(pending.timer);
            if (parsed.error) {
              pending.reject(new Error(parsed.error.message ?? "Codex app-server request failed"));
            } else {
              pending.resolve(parsed.result);
            }
          }
        }
      }
      newlineIndex = this.buffer.indexOf("\n");
    }
  }
}
