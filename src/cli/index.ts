import fs from "node:fs/promises";
import process from "node:process";
import {
  batchCreateTaskThreadsInputSchema,
  boardDisplaySchema,
  createPostInputSchema,
  createTaskThreadApiInputSchema,
  taskRoleSchema
} from "../shared/schemas";
import type {
  BatchCreateThreadsDto,
  CreateThreadResultDto,
  TaskHeartbeatDto,
  ThreadDetailDto,
  ThreadListItemDto
} from "../shared/types";
import { parseTaskJsonl } from "./jsonl";

const DEFAULT_API_BASE_URL = process.env.HARNESS_API_BASE_URL?.trim() || "http://127.0.0.1:4317";
const DEFAULT_TOKEN = process.env.HARNESS_API_TOKEN?.trim();

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));

  if (cli.help) {
    printHelp();
    return;
  }

  switch (cli.command[0]) {
    case "task":
      await handleTaskCommand(cli);
      return;
    case "settings":
      await handleSettingsCommand(cli);
      return;
    default:
      throw new Error("Unknown command. Run `harness --help`.");
  }
}

async function handleTaskCommand(cli: ParsedCli): Promise<void> {
  const action = cli.command[1];
  switch (action) {
    case "create":
      await handleTaskCreate(cli);
      return;
    case "import":
      await handleTaskImport(cli);
      return;
    case "list":
      await handleTaskList(cli);
      return;
    case "show":
      await handleTaskShow(cli);
      return;
    case "start":
      await handleTaskStart(cli);
      return;
    case "reply":
      await handleTaskReply(cli);
      return;
    case "heartbeat":
      await handleTaskHeartbeat(cli);
      return;
    default:
      throw new Error("Unknown task command. Run `harness --help`.");
  }
}

async function handleSettingsCommand(cli: ParsedCli): Promise<void> {
  const action = cli.command[1];
  if (action !== "get") {
    throw new Error("Unknown settings command. Run `harness --help`.");
  }
  const data = await requestJson(cli, "/api/settings");
  printResult(cli, data);
}

async function handleTaskCreate(cli: ParsedCli): Promise<void> {
  const body = await readRequiredBody(cli);
  const payload = createTaskThreadApiInputSchema.parse({
    folder: requireOption(cli, "folder"),
    name: requireOption(cli, "name"),
    role: cli.options.role ?? "general",
    body,
    refs: [],
    presetProjectId: cli.options["preset-project-id"],
    boardDisplay: cli.options["board-display"],
    externalTaskKey: cli.options["external-task-key"]
  });
  const result = await requestJson<CreateThreadResultDto>(cli, "/api/threads", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  printResult(cli, result, formatCreateText(result));
}

async function handleTaskImport(cli: ParsedCli): Promise<void> {
  const filePath = requireOption(cli, "file");
  const content = await fs.readFile(filePath, "utf8");
  const parsed = parseTaskJsonl(content);
  const payload = batchCreateTaskThreadsInputSchema.parse({
    folder: requireOption(cli, "folder"),
    presetProjectId: cli.options["preset-project-id"],
    boardDisplay: cli.options["board-display"] ?? "hidden",
    tasks: parsed.tasks
  });
  const result = await requestJson<BatchCreateThreadsDto>(cli, "/api/threads/batch", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  printResult(cli, result, formatBatchCreateText(result));
}

async function handleTaskList(cli: ParsedCli): Promise<void> {
  const data = await requestJson<ThreadListItemDto[]>(cli, "/api/threads");
  printResult(cli, data, data.map(formatThreadListLine).join("\n"));
}

async function handleTaskShow(cli: ParsedCli): Promise<void> {
  const id = requirePositional(cli, 2, "thread id");
  const data = await requestJson<ThreadDetailDto>(cli, `/api/threads/${encodeURIComponent(id)}`);
  printResult(cli, data, formatThreadDetailText(data));
}

async function handleTaskStart(cli: ParsedCli): Promise<void> {
  const id = requirePositional(cli, 2, "thread id");
  const data = await requestJson(cli, `/api/threads/${encodeURIComponent(id)}/board-stage`, {
    method: "PATCH",
    body: JSON.stringify({ boardStage: "wip" })
  });
  printResult(cli, data);
}

async function handleTaskReply(cli: ParsedCli): Promise<void> {
  const id = requirePositional(cli, 2, "thread id");
  const body = await readRequiredBody(cli);
  const payload = createPostInputSchema.parse({
    body,
    refs: []
  });
  const data = await requestJson(cli, `/api/threads/${encodeURIComponent(id)}/replies`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
  printResult(cli, data);
}

async function handleTaskHeartbeat(cli: ParsedCli): Promise<void> {
  const id = requirePositional(cli, 2, "task or thread id");
  const data = await requestJson<TaskHeartbeatDto>(cli, `/api/tasks/${encodeURIComponent(id)}/heartbeat`);
  printResult(cli, data, formatHeartbeatText(data));
}

async function readRequiredBody(cli: ParsedCli): Promise<string> {
  if (typeof cli.options.body === "string" && cli.options.body.trim()) {
    return cli.options.body;
  }
  if (typeof cli.options["body-file"] === "string") {
    return (await fs.readFile(cli.options["body-file"], "utf8")).trim();
  }
  throw new Error("Missing required body. Use --body or --body-file.");
}

async function requestJson<T>(cli: ParsedCli, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  const token = cli.options.token ?? DEFAULT_TOKEN;
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${cli.options.apiBaseUrl}${path}`, {
    ...init,
    headers
  });

  const text = await response.text();
  const data = text ? safeJsonParse(text) : undefined;
  if (!response.ok) {
    const message =
      typeof data === "object" && data && "message" in data && typeof data.message === "string"
        ? data.message
        : text || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return data as T;
}

function printResult(cli: ParsedCli, data: unknown, textFallback?: string): void {
  if (cli.options.json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${textFallback ?? JSON.stringify(data, null, 2)}\n`);
}

function formatCreateText(result: CreateThreadResultDto): string {
  return `${result.created ? "created" : "existing"} ${result.publicTaskId} ${result.threadId}`;
}

function formatBatchCreateText(result: BatchCreateThreadsDto): string {
  const lines = [
    `created=${result.createdCount} existing=${result.existingCount}`
  ];
  for (const item of result.items) {
    lines.push(`${item.created ? "created" : "existing"} ${item.publicTaskId} ${item.name}`);
  }
  return lines.join("\n");
}

function formatThreadListLine(thread: ThreadListItemDto): string {
  return [
    thread.publicTaskId,
    thread.boardStage,
    thread.status,
    thread.role,
    thread.name
  ].join(" ");
}

function formatThreadDetailText(detail: ThreadDetailDto): string {
  const lines = [
    `${detail.thread.publicTaskId} ${detail.thread.name}`,
    `stage=${detail.thread.boardStage} status=${detail.thread.status} role=${detail.thread.role}`,
    `folder=${detail.thread.folder}`,
    `posts=${detail.posts.length}`
  ];
  if (detail.thread.externalTaskKey) {
    lines.push(`externalTaskKey=${detail.thread.externalTaskKey}`);
  }
  if (detail.run) {
    lines.push(`run=${detail.run.id} ${detail.run.status} ${detail.run.phase}`);
  }
  return lines.join("\n");
}

function formatHeartbeatText(heartbeat: TaskHeartbeatDto): string {
  return [
    `${heartbeat.publicTaskId ?? heartbeat.taskId} ${heartbeat.label}`,
    `state=${heartbeat.state} taskStatus=${heartbeat.taskStatus} runStatus=${heartbeat.runStatus ?? "n/a"}`
  ].join("\n");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface ParsedCli {
  command: string[];
  help: boolean;
  options: {
    apiBaseUrl: string;
    token?: string;
    json: boolean;
    name?: string;
    folder?: string;
    role?: string;
    body?: string;
    "body-file"?: string;
    file?: string;
    "preset-project-id"?: string;
    "board-display"?: string;
    "external-task-key"?: string;
  };
}

function parseCli(argv: string[]): ParsedCli {
  const command: string[] = [];
  const options: ParsedCli["options"] = {
    apiBaseUrl: DEFAULT_API_BASE_URL,
    json: false
  };
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value) {
      continue;
    }
    if (value === "--help" || value === "-h") {
      help = true;
      continue;
    }
    if (value === "--json") {
      options.json = true;
      continue;
    }
    if (value.startsWith("--")) {
      const key = value.slice(2);
      const next = argv[index + 1];
      if (key === "api-base-url") {
        options.apiBaseUrl = next ?? DEFAULT_API_BASE_URL;
        index += 1;
        continue;
      }
      if (key === "token") {
        options.token = next;
        index += 1;
        continue;
      }
      if (key === "role") {
        options.role = taskRoleSchema.parse(next);
        index += 1;
        continue;
      }
      if (key === "board-display") {
        options["board-display"] = boardDisplaySchema.parse(next);
        index += 1;
        continue;
      }
      if (
        key === "name" ||
        key === "folder" ||
        key === "body" ||
        key === "body-file" ||
        key === "file" ||
        key === "preset-project-id" ||
        key === "external-task-key"
      ) {
        options[key] = next;
        index += 1;
        continue;
      }
      throw new Error(`Unknown option: --${key}`);
    }
    command.push(value);
  }

  return { command, help, options };
}

function requireOption(cli: ParsedCli, key: keyof ParsedCli["options"]): string {
  const value = cli.options[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required option: --${String(key)}`);
  }
  return value.trim();
}

function requirePositional(cli: ParsedCli, index: number, label: string): string {
  const value = cli.command[index];
  if (!value?.trim()) {
    throw new Error(`Missing required ${label}`);
  }
  return value.trim();
}

function printHelp(): void {
  process.stdout.write(`Harness CLI

Usage:
  harness task create --folder PATH --name NAME --body TEXT [--role ROLE] [--preset-project-id ID] [--board-display auto|shown|hidden] [--external-task-key KEY]
  harness task import --file tasks.jsonl --folder PATH [--preset-project-id ID] [--board-display auto|shown|hidden]
  harness task list
  harness task show <thread-id-or-public-task-id>
  harness task start <thread-id-or-public-task-id>
  harness task reply <thread-id-or-public-task-id> --body TEXT
  harness task heartbeat <task-id-or-public-task-id>
  harness settings get

Options:
  --api-base-url URL   Default: ${DEFAULT_API_BASE_URL}
  --token TOKEN        Bearer token. Defaults to HARNESS_API_TOKEN.
  --json               Print JSON output

JSONL import format:
  {"name":"登录页","role":"se","body":"实现邮箱登录页","externalTaskKey":"US-101"}
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
