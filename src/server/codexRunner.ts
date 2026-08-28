import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppConfig } from "./config";
import { JsonLineAccumulator } from "./jsonLineParser";

export interface CodexRunInput {
  prompt: string;
  runId: string;
  cwd?: string;
  codexThreadId?: string;
  codexThreadName?: string;
}

export interface CodexRunResult {
  exitCode: number;
  lastMessage: string;
  stderr: string;
  codexSessionRef?: string;
  metadata?: Record<string, unknown>;
}

export type CodexEventHandler = (event: {
  raw: string;
  value?: Record<string, unknown>;
  error?: string;
  eventType?: string;
}) => Promise<void> | void;

export interface CodexRunner {
  run(input: CodexRunInput, onEvent: CodexEventHandler): Promise<CodexRunResult>;
}

interface RpcError {
  code?: number;
  message?: string;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ThreadStartResponse {
  thread?: {
    id?: string;
  };
}

interface ThreadResumeResponse {
  thread?: {
    id?: string;
  };
}

interface TurnStartResponse {
  turn?: {
    id?: string;
  };
}

interface TurnCompletedParams {
  threadId?: string;
  turn?: {
    id?: string;
    status?: string;
    error?: {
      message?: string;
      additionalDetails?: string | null;
    } | null;
  };
}

interface ItemCompletedParams {
  item?: {
    type?: string;
    id?: string;
    text?: string;
  };
}

interface AgentMessageDeltaParams {
  itemId?: string;
  delta?: string;
}

interface ThreadTurnsItemsListResponse {
  data?: Array<{
    type?: string;
    text?: string;
  }>;
}

const APP_SERVER_REQUEST_TIMEOUT_MS = 30000;
const APP_SERVER_EXIT_TIMEOUT_MS = 3000;
const MAX_STDERR_CHARS = 20000;

export class AppServerCodexRunner implements CodexRunner {
  constructor(private readonly config: AppConfig) {}

  async run(input: CodexRunInput, onEvent: CodexEventHandler): Promise<CodexRunResult> {
    const cwd = input.cwd ?? this.config.codexWorkspace;
    const child = spawn(this.config.codexBin, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    const parser = new JsonLineAccumulator();
    const pending = new Map<number | string, PendingRequest>();
    const eventWrites: Promise<void>[] = [];
    const agentMessages = new Map<string, string>();

    let stderr = "";
    let nextRequestId = 1;
    let threadId: string | undefined;
    let turnId: string | undefined;
    let finalMessage = "";
    let completedStatus = "failed";
    let completedError: string | undefined;
    let processClosed = false;

    const appendStderr = (chunk: string) => {
      stderr = `${stderr}${chunk}`;
      if (stderr.length > MAX_STDERR_CHARS) {
        stderr = stderr.slice(stderr.length - MAX_STDERR_CHARS);
      }
    };

    const emit = (event: Parameters<CodexEventHandler>[0]) => {
      eventWrites.push(Promise.resolve(onEvent(event)).then(() => undefined));
    };

    const writeMessage = (message: Record<string, unknown>) => {
      if (child.stdin.destroyed || !child.stdin.writable) {
        throw new Error("Codex app-server stdin is closed");
      }
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const sendRequest = (method: string, params: unknown, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS) => {
      const id = nextRequestId++;
      writeMessage({ id, method, params });

      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex app-server request timed out: ${method}`));
        }, timeoutMs);

        pending.set(id, {
          method,
          resolve,
          reject,
          timer
        });
      });
    };

    let resolveTurnCompleted: (() => void) | undefined;
    const turnCompleted = new Promise<void>((resolve) => {
      resolveTurnCompleted = resolve;
    });

    const configuredTurnTimeoutMs =
      this.config.codexTurnTimeoutMs && this.config.codexTurnTimeoutMs > 0 ? this.config.codexTurnTimeoutMs : undefined;
    const turnTimeout =
      configuredTurnTimeoutMs
        ? setTimeout(() => {
            completedStatus = "failed";
            completedError = `Codex app-server turn timed out after ${configuredTurnTimeoutMs}ms`;
            resolveTurnCompleted?.();
          }, configuredTurnTimeoutMs)
        : undefined;

    const handleMessage = (parsed: { raw: string; value?: Record<string, unknown>; error?: string }) => {
      if (parsed.error || !parsed.value) {
        emit({ ...parsed, eventType: "app_server_invalid_json" });
        return;
      }

      const message = parsed.value as RpcMessage;

      if (message.id !== undefined && message.method === undefined) {
        const request = pending.get(message.id);
        if (!request) {
          emit({ raw: parsed.raw, value: parsed.value, eventType: "app_server_unmatched_response" });
          return;
        }

        pending.delete(message.id);
        clearTimeout(request.timer);

        if (message.error) {
          request.reject(new Error(`Codex app-server ${request.method} failed: ${message.error.message ?? "unknown error"}`));
        } else {
          request.resolve(message.result);
        }
        return;
      }

      if (message.id !== undefined && message.method) {
        emit({ raw: parsed.raw, value: parsed.value, eventType: message.method });
        this.rejectServerRequest(child, message.id, message.method);
        return;
      }

      if (message.method) {
        emit({ raw: parsed.raw, value: parsed.value, eventType: message.method });
        this.applyNotification(message, agentMessages, (messageText) => {
          finalMessage = messageText;
        });

        if (message.method === "turn/completed") {
          const params = message.params as TurnCompletedParams;
          completedStatus = params.turn?.status ?? "failed";
          completedError = [params.turn?.error?.message, params.turn?.error?.additionalDetails].filter(Boolean).join("\n");
          resolveTurnCompleted?.();
        }
      }
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      for (const parsed of parser.push(chunk)) {
        handleMessage(parsed);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", appendStderr);

    child.on("close", () => {
      processClosed = true;
      if (completedStatus !== "completed") {
        completedError = completedError ?? "Codex app-server exited before the turn completed";
        resolveTurnCompleted?.();
      }
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`Codex app-server exited before ${request.method} completed`));
      }
      pending.clear();
    });

    child.on("error", (error) => {
      appendStderr(error.message);
      completedStatus = "failed";
      completedError = error.message;
      resolveTurnCompleted?.();
    });

    try {
      await sendRequest("initialize", {
        clientInfo: {
          name: "codex-kanban-web-ui",
          title: "Codex Kanban Web UI",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false
        }
      });

      const requestedThreadId = input.codexThreadId;
      const thread = requestedThreadId
        ? ((await sendRequest("thread/resume", this.buildThreadResumeParams(requestedThreadId, cwd))) as ThreadResumeResponse)
        : ((await sendRequest("thread/start", this.buildThreadStartParams(cwd))) as ThreadStartResponse);
      threadId = thread.thread?.id;
      if (!threadId) {
        throw new Error("Codex app-server did not return a thread id");
      }
      if (!requestedThreadId && input.codexThreadName) {
        await sendRequest("thread/name/set", {
          threadId,
          name: input.codexThreadName
        });
      }

      const turn = (await sendRequest("turn/start", this.buildTurnStartParams(threadId, input, cwd))) as TurnStartResponse;
      turnId = turn.turn?.id;
      if (!turnId) {
        throw new Error("Codex app-server did not return a turn id");
      }

      await turnCompleted;

      if (!finalMessage && threadId && turnId) {
        finalMessage = await this.readFinalMessage(sendRequest, threadId, turnId);
      }

      for (const parsed of parser.flush()) {
        handleMessage(parsed);
      }
      await Promise.all(eventWrites);

      const codexSessionRef = threadId && turnId ? `app-server:${threadId}:${turnId}` : undefined;
      return {
        exitCode: completedStatus === "completed" ? 0 : 1,
        lastMessage: finalMessage.trim(),
        stderr: [completedError, stderr.trim()].filter(Boolean).join("\n\n"),
        codexSessionRef,
        metadata: {
          runner: "app-server",
          cwd,
          appServerThreadId: threadId,
          appServerTurnId: turnId,
          appServerTurnStatus: completedStatus,
          appServerThreadReused: Boolean(requestedThreadId)
        }
      };
    } catch (error) {
      await Promise.all(eventWrites);
      return {
        exitCode: 1,
        lastMessage: finalMessage.trim(),
        stderr: [error instanceof Error ? error.message : "Codex app-server runner failed", stderr.trim()]
          .filter(Boolean)
          .join("\n\n"),
        metadata: {
          runner: "app-server",
          cwd,
          appServerThreadId: threadId,
          appServerTurnId: turnId,
          appServerTurnStatus: completedStatus,
          appServerThreadReused: Boolean(input.codexThreadId)
        }
      };
    } finally {
      if (turnTimeout) {
        clearTimeout(turnTimeout);
      }
      for (const request of pending.values()) {
        clearTimeout(request.timer);
      }
      pending.clear();
      await this.closeChild(child, () => processClosed);
    }
  }

  private buildThreadStartParams(cwd: string): Record<string, unknown> {
    return {
      cwd,
      approvalPolicy: this.config.codexApproval,
      sandbox: this.config.codexSandbox,
      ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
      serviceName: "codex-kanban-web-ui",
      experimentalRawEvents: false,
      persistExtendedHistory: false
    };
  }

  private buildThreadResumeParams(threadId: string, cwd: string): Record<string, unknown> {
    return {
      threadId,
      cwd,
      approvalPolicy: this.config.codexApproval,
      sandbox: this.config.codexSandbox,
      ...(this.config.codexModel ? { model: this.config.codexModel } : {})
    };
  }

  private buildTurnStartParams(threadId: string, input: CodexRunInput, cwd: string): Record<string, unknown> {
    return {
      threadId,
      input: [
        {
          type: "text",
          text: input.prompt,
          text_elements: []
        }
      ],
      responsesapiClientMetadata: {
        harnessRunId: input.runId
      },
      cwd,
      approvalPolicy: this.config.codexApproval,
      ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
      ...(this.config.codexReasoningEffort ? { effort: this.config.codexReasoningEffort } : {})
    };
  }

  private applyNotification(
    message: RpcMessage,
    agentMessages: Map<string, string>,
    setFinalMessage: (message: string) => void
  ): void {
    if (message.method === "item/agentMessage/delta") {
      const params = message.params as AgentMessageDeltaParams;
      if (params.itemId && typeof params.delta === "string") {
        agentMessages.set(params.itemId, `${agentMessages.get(params.itemId) ?? ""}${params.delta}`);
      }
      return;
    }

    if (message.method === "item/completed") {
      const params = message.params as ItemCompletedParams;
      if (params.item?.type === "agentMessage") {
        const messageText = params.item.text ?? (params.item.id ? agentMessages.get(params.item.id) : undefined);
        if (messageText) {
          setFinalMessage(messageText);
        }
      }
    }
  }

  private async readFinalMessage(
    sendRequest: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>,
    threadId: string,
    turnId: string
  ): Promise<string> {
    const items = (await sendRequest(
      "thread/turns/items/list",
      {
        threadId,
        turnId,
        limit: 100
      },
      APP_SERVER_REQUEST_TIMEOUT_MS
    )) as ThreadTurnsItemsListResponse;

    return (
      items.data
        ?.filter((item) => item.type === "agentMessage" && typeof item.text === "string")
        .map((item) => item.text)
        .at(-1) ?? ""
    );
  }

  private rejectServerRequest(child: ChildProcessWithoutNullStreams, id: number | string, method: string): void {
    if (child.stdin.destroyed || !child.stdin.writable) {
      return;
    }

    child.stdin.write(
      `${JSON.stringify({
        id,
        error: {
          code: -32601,
          message: `Harness does not handle app-server request: ${method}`
        }
      })}\n`
    );
  }

  private async closeChild(child: ChildProcessWithoutNullStreams, isClosed: () => boolean): Promise<void> {
    if (isClosed()) {
      return;
    }

    child.stdin.end();

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!isClosed()) {
          child.kill("SIGTERM");
        }
        resolve();
      }, APP_SERVER_EXIT_TIMEOUT_MS);

      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
