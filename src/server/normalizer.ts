import { DEFAULT_CODEX_SYSTEM_PROMPT, USER_POST_LIMIT } from "../shared/schemas";

export interface NormalizedTask {
  title: string;
  summaryText: string;
  spec: {
    rawRequest: string;
    objective: string;
    constraints: string[];
    expectedOutput: string;
  };
}

const whitespace = /\s+/g;

export function normalizeTaskPost(body: string): NormalizedTask {
  const compact = body.trim().replace(whitespace, " ");
  const title = compact.length > 42 ? `${compact.slice(0, 42)}...` : compact;
  const objective = compact.length > 160 ? `${compact.slice(0, 160)}...` : compact;

  return {
    title: title || "新的工作任务",
    summaryText: objective,
    spec: {
      rawRequest: body,
      objective,
      constraints: [`用户根帖不超过 ${USER_POST_LIMIT} 字`, "默认在当前 Harness 工作区内执行"],
      expectedOutput: "通过 thread 的 result 回帖直接交付结果"
    }
  };
}

export function buildAckBody(summaryText: string): string {
  return `收到。我会按当前任务版本开始执行：${summaryText}\n\nCodex 已启动，正在当前工作区执行任务。`;
}

export function buildCodexPrompt(
  summaryText: string,
  rawRequest: string,
  roleInitialInstruction?: string,
  systemPrompt = DEFAULT_CODEX_SYSTEM_PROMPT
): string {
  const sections = [];

  const normalizedSystemPrompt = systemPrompt.trim();
  if (normalizedSystemPrompt) {
    sections.push(normalizedSystemPrompt, "");
  }

  sections.push(`当前任务摘要：${summaryText}`);

  const normalizedInstruction = roleInitialInstruction?.trim();
  if (normalizedInstruction) {
    sections.push("", "当前角色初始化要求：", normalizedInstruction);
  }

  sections.push("", "用户原始请求：", rawRequest);
  return sections.join("\n");
}
