import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_SYSTEM_PROMPT,
  THREAD_NAME_LIMIT,
  USER_POST_LIMIT,
  bulkImportBacklogInputSchema,
  createPostInputSchema,
  createTaskThreadInputSchema,
  createThreadInputSchema,
  updateAppSettingsInputSchema,
  updateBacklogTaskInputSchema,
  updateBoardAutomationInputSchema,
  updateBoardDisplayInputSchema,
  updateBoardStageInputSchema
} from "./schemas";

describe("createThreadInputSchema", () => {
  it("accepts a named local thread folder", () => {
    const parsed = createThreadInputSchema.parse({
      name: " 真实 Codex 闭环 ",
      folder: " /Users/example/Workspace/Harness "
    });

    expect(parsed.name).toBe("真实 Codex 闭环");
    expect(parsed.folder).toBe("/Users/example/Workspace/Harness");
  });

  it("rejects empty or over-limit thread names", () => {
    expect(() => createThreadInputSchema.parse({ name: "", folder: "/tmp" })).toThrow();
    expect(() => createThreadInputSchema.parse({ name: "x".repeat(THREAD_NAME_LIMIT + 1), folder: "/tmp" })).toThrow();
  });
});

describe("createPostInputSchema", () => {
  it("accepts a focused user post", () => {
    const parsed = createPostInputSchema.parse({ body: "帮我实现第一阶段 MVP" });

    expect(parsed.body).toBe("帮我实现第一阶段 MVP");
    expect(parsed.refs).toEqual([]);
  });

  it("rejects posts over the 500 character limit", () => {
    const body = "x".repeat(USER_POST_LIMIT + 1);

    expect(() => createPostInputSchema.parse({ body })).toThrow();
  });
});

describe("createTaskThreadInputSchema", () => {
  it("accepts the task body when creating a thread", () => {
    const parsed = createTaskThreadInputSchema.parse({
      name: "真实 Codex 闭环",
      folder: "/tmp/harness",
      role: "se",
      body: "只回复：测试任务已完成。"
    });

    expect(parsed).toMatchObject({
      name: "真实 Codex 闭环",
      folder: "/tmp/harness",
      role: "se",
      body: "只回复：测试任务已完成。",
      refs: []
    });
  });

  it("rejects an over-limit root task", () => {
    expect(() =>
      createTaskThreadInputSchema.parse({
        name: "长度校验",
        folder: "/tmp/harness",
        role: "general",
        body: "x".repeat(USER_POST_LIMIT + 1)
      })
    ).toThrow();
    expect(() =>
      createTaskThreadInputSchema.parse({
        name: "角色校验",
        folder: "/tmp/harness",
        role: "运营",
        body: "测试非法角色"
      })
    ).toThrow();
  });
});

describe("bulkImportBacklogInputSchema", () => {
  it("accepts a CSV import payload with one target folder", () => {
    const parsed = bulkImportBacklogInputSchema.parse({
      folder: " /tmp/harness ",
      csv: "client_key,name,role,body\nUS-001,登录页,se,实现登录页"
    });

    expect(parsed).toEqual({
      folder: "/tmp/harness",
      csv: "client_key,name,role,body\nUS-001,登录页,se,实现登录页"
    });
  });

  it("rejects an empty CSV import payload", () => {
    expect(() => bulkImportBacklogInputSchema.parse({ folder: "/tmp/harness", csv: "" })).toThrow();
  });
});

describe("updateBoardStageInputSchema", () => {
  it("accepts a Kanban board stage", () => {
    expect(updateBoardStageInputSchema.parse({ boardStage: "wip" })).toEqual({ boardStage: "wip" });
  });

  it("rejects unknown board stages", () => {
    expect(() => updateBoardStageInputSchema.parse({ boardStage: "blocked" })).toThrow();
    expect(() => updateBoardStageInputSchema.parse({ boardStage: "backlog" })).toThrow();
    expect(() => updateBoardStageInputSchema.parse({ boardStage: "archive" })).toThrow();
  });
});

describe("updateBoardDisplayInputSchema", () => {
  it("accepts display preferences", () => {
    expect(updateBoardDisplayInputSchema.parse({ boardDisplay: "auto" })).toEqual({ boardDisplay: "auto" });
    expect(updateBoardDisplayInputSchema.parse({ boardDisplay: "shown" })).toEqual({ boardDisplay: "shown" });
    expect(updateBoardDisplayInputSchema.parse({ boardDisplay: "hidden" })).toEqual({ boardDisplay: "hidden" });
  });

  it("rejects unknown display preferences", () => {
    expect(() => updateBoardDisplayInputSchema.parse({ boardDisplay: "ready" })).toThrow();
  });
});

describe("updateBoardAutomationInputSchema", () => {
  it("accepts an automation toggle", () => {
    expect(updateBoardAutomationInputSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(updateBoardAutomationInputSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it("rejects non-boolean automation toggles", () => {
    expect(() => updateBoardAutomationInputSchema.parse({ enabled: "true" })).toThrow();
  });
});

describe("updateAppSettingsInputSchema", () => {
  it("accepts persisted app settings", () => {
    expect(
      updateAppSettingsInputSchema.parse({
        autoRunIntervalMinutes: 3,
        maxConcurrentTasks: 2,
        codexThreadPrefix: " [Harness] ",
        systemPrompt: " 自定义基础 prompt ",
        presetProjects: [
          {
            id: " example-app ",
            name: " ExampleApp ",
            folder: " /Users/example/Workspace/ExampleApp ",
            roleInitialInstructions: {
              se: "先检查现有实现",
              art: "",
              design: "先梳理边界",
              music: "",
              general: ""
            }
          }
        ]
      })
    ).toEqual({
      autoRunIntervalMinutes: 3,
      maxConcurrentTasks: 2,
      codexThreadPrefix: "[Harness]",
      systemPrompt: "自定义基础 prompt",
      presetProjects: [
        {
          id: "example-app",
          name: "ExampleApp",
          folder: "/Users/example/Workspace/ExampleApp",
          roleInitialInstructions: {
            se: "先检查现有实现",
            art: "",
            design: "先梳理边界",
            music: "",
            general: ""
          }
        }
      ]
    });
  });

  it("rejects out-of-range settings values", () => {
    expect(() =>
      updateAppSettingsInputSchema.parse({
        autoRunIntervalMinutes: 0,
        maxConcurrentTasks: 6,
        codexThreadPrefix: "[Harness]",
        systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
        presetProjects: []
      })
    ).toThrow();
  });
});

describe("updateBacklogTaskInputSchema", () => {
  it("accepts a renamed ready task body", () => {
    const parsed = updateBacklogTaskInputSchema.parse({
      name: " 修改 Backlog 任务 ",
      role: "design",
      body: " 调整任务正文 "
    });

    expect(parsed).toEqual({
      name: "修改 Backlog 任务",
      role: "design",
      body: "调整任务正文"
    });
  });

  it("rejects over-limit task edits", () => {
    expect(() =>
      updateBacklogTaskInputSchema.parse({
        name: "修改 Backlog 任务",
        role: "general",
        body: "x".repeat(USER_POST_LIMIT + 1)
      })
    ).toThrow();
  });
});
