import { batchCreateTaskThreadItemInputSchema, type BatchCreateTaskThreadItemInput } from "../shared/schemas";

export interface ParsedJsonlTasks {
  tasks: BatchCreateTaskThreadItemInput[];
}

export function parseTaskJsonl(content: string): ParsedJsonlTasks {
  const tasks: BatchCreateTaskThreadItemInput[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) {
      continue;
    }

    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error instanceof Error ? error.message : "parse failed"}`);
    }

    const parsedTask = batchCreateTaskThreadItemInputSchema.safeParse(parsedLine);
    if (!parsedTask.success) {
      const issue = parsedTask.error.issues[0];
      throw new Error(`Invalid task at line ${index + 1}: ${issue?.message ?? "validation failed"}`);
    }

    tasks.push(parsedTask.data);
  }

  if (tasks.length === 0) {
    throw new Error("JSONL did not contain any tasks");
  }

  return { tasks };
}
