import { describe, expect, it } from "vitest";
import { buildAckBody, buildCodexPrompt, normalizeTaskPost } from "./normalizer";

describe("normalizeTaskPost", () => {
  it("creates a compact title and first version spec", () => {
    const normalized = normalizeTaskPost("  帮我做一个真实 Codex 执行闭环  ");

    expect(normalized.title).toBe("帮我做一个真实 Codex 执行闭环");
    expect(normalized.spec.rawRequest).toContain("真实 Codex");
    expect(normalized.summaryText).toContain("执行闭环");
  });
});

describe("buildAckBody", () => {
  it("returns one ack reply with task understanding and startup progress", () => {
    const body = buildAckBody("实现 MVP");

    expect(body).toContain("实现 MVP");
    expect(body).toContain("Codex 已启动");
  });
});

describe("buildCodexPrompt", () => {
  it("appends role initialization instructions when configured", () => {
    const prompt = buildCodexPrompt("实现设置面板", "请补全设置弹层和接口。", "先检查现有导航结构，再开始修改。");

    expect(prompt).toContain("当前角色初始化要求");
    expect(prompt).toContain("先检查现有导航结构");
    expect(prompt).toContain("请补全设置弹层和接口");
  });

  it("uses the configured system prompt", () => {
    const prompt = buildCodexPrompt("实现设置面板", "请补全设置页。", undefined, "你是自定义 Harness Agent。");

    expect(prompt).toContain("你是自定义 Harness Agent。");
    expect(prompt).not.toContain("Tweet-Native AI Harness 后台拉起");
    expect(prompt).toContain("当前任务摘要：实现设置面板");
  });
});
