import type {
  BulkImportBacklogRequest,
  CreatePostRequest,
  CreateTaskThreadRequest,
  LoginRequest,
  UpdateAppSettingsRequest,
  UpdateBacklogTaskRequest,
  UpdateBoardAutomationRequest,
  UpdateBoardDisplayRequest,
  UpdateBoardStageRequest
} from "../shared/schemas";
import type {
  AppSettingsDto,
  AppSettingsUpdateDto,
  AuthStateDto,
  BacklogTaskDeleteDto,
  BacklogTaskUpdateDto,
  BulkImportBacklogDto,
  BulkImportBacklogPreviewDto,
  BoardAutomationDto,
  BoardAutomationRunDto,
  BoardAutomationUpdateDto,
  BoardDisplayUpdateDto,
  BoardStageUpdateDto,
  HealthDto,
  LocalDirectoryDto,
  TaskHeartbeatDto,
  ThreadDetailDto,
  ThreadListItemDto
} from "../shared/types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthRequiredError extends ApiError {
  constructor(message = "请先登录") {
    super(message, 401);
    this.name = "AuthRequiredError";
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers: HeadersInit = {
    ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...init?.headers
  };
  const response = await fetch(url, {
    credentials: "same-origin",
    headers,
    ...init
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    if (response.status === 401) {
      throw new AuthRequiredError(message);
    }
    throw new ApiError(message || `Request failed: ${response.status}`, response.status);
  }

  return response.json() as Promise<T>;
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) {
    return "";
  }
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    return typeof parsed.message === "string" ? parsed.message : text;
  } catch {
    return text;
  }
}

export function isAuthRequiredError(cause: unknown): cause is AuthRequiredError {
  return cause instanceof AuthRequiredError;
}

export function fetchAuthState(): Promise<AuthStateDto> {
  return requestJson<AuthStateDto>("/api/auth/me");
}

export function login(input: LoginRequest): Promise<AuthStateDto> {
  return requestJson<AuthStateDto>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function logout(): Promise<AuthStateDto> {
  return requestJson<AuthStateDto>("/api/auth/logout", {
    method: "POST"
  });
}

export function fetchHealth(): Promise<HealthDto> {
  return requestJson<HealthDto>("/api/health");
}

export function fetchAppSettings(): Promise<AppSettingsDto> {
  return requestJson<AppSettingsDto>("/api/settings");
}

export function updateAppSettings(input: UpdateAppSettingsRequest): Promise<AppSettingsUpdateDto> {
  return requestJson<AppSettingsUpdateDto>("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function fetchBoardAutomation(): Promise<BoardAutomationDto> {
  return requestJson<BoardAutomationDto>("/api/board-automation");
}

export function updateBoardAutomation(input: UpdateBoardAutomationRequest): Promise<BoardAutomationUpdateDto> {
  return requestJson<BoardAutomationUpdateDto>("/api/board-automation", {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function checkBoardAutomation(): Promise<BoardAutomationRunDto> {
  return requestJson<BoardAutomationRunDto>("/api/board-automation/check", {
    method: "POST"
  });
}

export function fetchThreads(): Promise<ThreadListItemDto[]> {
  return requestJson<ThreadListItemDto[]>("/api/threads");
}

export function createThread(input: CreateTaskThreadRequest): Promise<{
  threadId: string;
  publicTaskId: string;
  postId: string;
  taskId: string;
  runId: string;
}> {
  return requestJson("/api/threads", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function previewBacklogImport(input: BulkImportBacklogRequest): Promise<BulkImportBacklogPreviewDto> {
  return requestJson<BulkImportBacklogPreviewDto>("/api/backlog/import/preview", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function importBacklogTasks(input: BulkImportBacklogRequest): Promise<BulkImportBacklogDto> {
  return requestJson<BulkImportBacklogDto>("/api/backlog/import", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function fetchThread(id: string): Promise<ThreadDetailDto> {
  return requestJson<ThreadDetailDto>(`/api/threads/${id}`);
}

export function updateBacklogTask(threadId: string, input: UpdateBacklogTaskRequest): Promise<BacklogTaskUpdateDto> {
  return requestJson<BacklogTaskUpdateDto>(`/api/threads/${threadId}`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function deleteBacklogTask(threadId: string): Promise<BacklogTaskDeleteDto> {
  return requestJson<BacklogTaskDeleteDto>(`/api/threads/${threadId}`, {
    method: "DELETE"
  });
}

export function updateThreadBoardStage(threadId: string, input: UpdateBoardStageRequest): Promise<BoardStageUpdateDto> {
  return requestJson<BoardStageUpdateDto>(`/api/threads/${threadId}/board-stage`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function updateThreadBoardDisplay(threadId: string, input: UpdateBoardDisplayRequest): Promise<BoardDisplayUpdateDto> {
  return requestJson<BoardDisplayUpdateDto>(`/api/threads/${threadId}/board-display`, {
    method: "PATCH",
    body: JSON.stringify(input)
  });
}

export function fetchTaskHeartbeat(taskId: string): Promise<TaskHeartbeatDto> {
  return requestJson<TaskHeartbeatDto>(`/api/tasks/${taskId}/heartbeat`);
}

export function createThreadReply(threadId: string, input: CreatePostRequest): Promise<{
  threadId: string;
  publicTaskId: string;
  postId: string;
  taskId: string;
  runId: string;
}> {
  return requestJson(`/api/threads/${threadId}/replies`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function fetchLocalDirectories(path?: string): Promise<LocalDirectoryDto> {
  const search = path ? `?path=${encodeURIComponent(path)}` : "";
  return requestJson<LocalDirectoryDto>(`/api/local-directories${search}`);
}
