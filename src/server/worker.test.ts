import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { buildCodexThreadName, getPresetProjectRoleInitialInstruction, shouldApplyRoleInitialInstruction } from "./worker";

describe("shouldApplyRoleInitialInstruction", () => {
  it("applies role initialization for the root post run only", () => {
    const rootPostId = new ObjectId();

    expect(
      shouldApplyRoleInitialInstruction(
        {
          triggerPostId: rootPostId
        },
        {
          rootPostId
        }
      )
    ).toBe(true);
  });

  it("skips role initialization for reply runs", () => {
    expect(
      shouldApplyRoleInitialInstruction(
        {
          triggerPostId: new ObjectId()
        },
        {
          rootPostId: new ObjectId()
        }
      )
    ).toBe(false);
  });
});

describe("buildCodexThreadName", () => {
  it("formats the thread name as prefix-role-task", () => {
    expect(buildCodexThreadName("[Harness]", "se", "真实 Codex 闭环")).toBe("[Harness]-程序-真实 Codex 闭环");
  });

  it("omits an empty prefix without leaving extra separators", () => {
    expect(buildCodexThreadName("", "music", "主界面背景音乐")).toBe("音乐-主界面背景音乐");
  });
});

describe("getPresetProjectRoleInitialInstruction", () => {
  const settings = {
    presetProjects: [
      {
        id: "example-app",
        name: "ExampleApp",
        folder: "/tmp/example-app",
        roleInitialInstructions: {
          se: "先跑测试",
          art: "",
          design: "先列边界",
          music: "",
          general: ""
        }
      }
    ]
  };

  it("returns undefined when no preset project is selected", () => {
    expect(getPresetProjectRoleInitialInstruction(settings, undefined, "se")).toBeUndefined();
  });

  it("uses the selected preset project's role instruction", () => {
    expect(getPresetProjectRoleInitialInstruction(settings, "example-app", "se")).toBe("先跑测试");
  });

  it("returns undefined for empty or missing project instructions", () => {
    expect(getPresetProjectRoleInitialInstruction(settings, "example-app", "music")).toBeUndefined();
    expect(getPresetProjectRoleInitialInstruction(settings, "missing", "se")).toBeUndefined();
  });
});
