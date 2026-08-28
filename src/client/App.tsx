import {
  Activity,
  AlertCircle,
  Archive,
  ArrowLeft,
  Bot,
  CheckCircle2,
  ChevronLeft,
  Clock3,
  Columns3,
  Eye,
  Folder,
  FolderOpen,
  LockKeyhole,
  LogOut,
  Loader2,
  Pencil,
  Plus,
  Power,
  Play,
  RefreshCw,
  Settings2,
  Send,
  Inbox,
  Trash2,
  Upload,
  X,
  UserRound
} from "lucide-react";
import { type DragEvent, type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BULK_IMPORT_MAX_ROWS,
  CODEX_THREAD_PREFIX_LIMIT,
  CODEX_SYSTEM_PROMPT_LIMIT,
  DEFAULT_CODEX_SYSTEM_PROMPT,
  PRESET_PROJECT_NAME_LIMIT,
  ROLE_INIT_INSTRUCTION_LIMIT,
  TASK_ROLE_VALUES,
  THREAD_NAME_LIMIT,
  USER_POST_LIMIT,
  type BoardDisplay,
  type BoardStage,
  type TaskRole
} from "../shared/schemas";
import type {
  AppSettingsDto,
  AuthStateDto,
  BoardAutomationDto,
  BulkImportBacklogPreviewDto,
  HealthDto,
  LocalDirectoryDto,
  PostDto,
  PresetProjectDto,
  RunDto,
  StreamEvent,
  TaskHeartbeatDto,
  ThreadDetailDto,
  ThreadListItemDto
} from "../shared/types";
import {
  createThread,
  createThreadReply,
  deleteBacklogTask,
  checkBoardAutomation,
  fetchAppSettings,
  fetchAuthState,
  fetchBoardAutomation,
  fetchHealth,
  fetchLocalDirectories,
  fetchTaskHeartbeat,
  fetchThread,
  fetchThreads,
  importBacklogTasks,
  isAuthRequiredError,
  login as loginWithPassword,
  logout as logoutSession,
  previewBacklogImport,
  updateAppSettings as saveAppSettings,
  updateBacklogTask,
  updateBoardAutomation,
  updateThreadBoardDisplay,
  updateThreadBoardStage
} from "./api";
import { readCsvFile } from "./csvEncoding";

const statusLabel: Record<string, string> = {
  queued: "未开始",
  accepted: "已接单",
  researching: "调研中",
  running: "执行中",
  waiting_for_input: "待澄清",
  delivered: "已交付",
  failed: "失败",
  cancelled: "已取消"
};

const boardStageLabel: Record<BoardStage, string> = {
  ready: "Ready",
  wip: "WIP",
  review: "Review",
  done: "Done"
};

const boardStageHint: Record<BoardStage, string> = {
  ready: "待启动",
  wip: "工作中",
  review: "待检查",
  done: "已完成"
};

const taskRoleLabel: Record<TaskRole, string> = {
  se: "程序",
  art: "美术",
  design: "策划",
  music: "音乐",
  general: "综合"
};

type AppSettingsFormState = {
  autoRunIntervalMinutes: number;
  maxConcurrentTasks: number;
  codexThreadPrefix: string;
  systemPrompt: string;
  presetProjects: PresetProjectDto[];
};

type KanbanStage = BoardStage;
type LibraryStage = "backlog" | "archive";
type WorkspaceView = "board" | "import" | "settings" | "library";

const boardColumns: KanbanStage[] = ["ready", "wip", "review", "done"];
const boardColumnSet = new Set<BoardStage>(boardColumns);
const libraryPreviewLimit = 10;
const boardAutoDisplayLimit = 10;
const autoRunIntervalOptions = Array.from({ length: 10 }, (_, index) => index + 1);
const maxConcurrentTaskOptions = Array.from({ length: 5 }, (_, index) => index + 1);

const replyLabel: Record<string, string> = {
  ack: "ACK",
  progress: "进展",
  question: "问题",
  result: "结果",
  failure: "失败"
};

function defaultRoleInitialInstructions(): Record<TaskRole, string> {
  return {
    se: "",
    art: "",
    design: "",
    music: "",
    general: ""
  };
}

function defaultSettingsDraft(): AppSettingsFormState {
  return {
    autoRunIntervalMinutes: 5,
    maxConcurrentTasks: 5,
    codexThreadPrefix: "[Harness]",
    systemPrompt: DEFAULT_CODEX_SYSTEM_PROMPT,
    presetProjects: []
  };
}

function settingsToDraft(settings: AppSettingsDto): AppSettingsFormState {
  return {
    autoRunIntervalMinutes: settings.autoRunIntervalMinutes,
    maxConcurrentTasks: settings.maxConcurrentTasks,
    codexThreadPrefix: settings.codexThreadPrefix,
    systemPrompt: settings.systemPrompt,
    presetProjects: settings.presetProjects.map((project) => ({
      ...project,
      roleInitialInstructions: { ...project.roleInitialInstructions }
    }))
  };
}

function makePresetProjectId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `preset-${crypto.randomUUID()}`;
  }
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function App() {
  const [authState, setAuthState] = useState<AuthStateDto>();
  const [threads, setThreads] = useState<ThreadListItemDto[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [detail, setDetail] = useState<ThreadDetailDto>();
  const [health, setHealth] = useState<HealthDto>();
  const [loginUsername, setLoginUsername] = useState("admin");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginError, setLoginError] = useState<string>();
  const [threadName, setThreadName] = useState("");
  const [editThreadName, setEditThreadName] = useState("");
  const [taskRole, setTaskRole] = useState<TaskRole>("general");
  const [editTaskRole, setEditTaskRole] = useState<TaskRole>("general");
  const [directory, setDirectory] = useState<LocalDirectoryDto>();
  const [selectedPresetProjectId, setSelectedPresetProjectId] = useState<string>();
  const [newTaskDraft, setNewTaskDraft] = useState("");
  const [editTaskDraft, setEditTaskDraft] = useState("");
  const [replyDraft, setReplyDraft] = useState("");
  const [heartbeat, setHeartbeat] = useState<TaskHeartbeatDto>();
  const [boardAutomation, setBoardAutomation] = useState<BoardAutomationDto>();
  const [settings, setSettings] = useState<AppSettingsDto>();
  const [settingsDraft, setSettingsDraft] = useState<AppSettingsFormState>(() => defaultSettingsDraft());
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("board");
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [isPreviewingImport, setIsPreviewingImport] = useState(false);
  const [isImportingBacklog, setIsImportingBacklog] = useState(false);
  const [isUpdatingBacklogTask, setIsUpdatingBacklogTask] = useState(false);
  const [isDeletingBacklogTask, setIsDeletingBacklogTask] = useState(false);
  const [isUpdatingAutomation, setIsUpdatingAutomation] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isSettingsSavedDialogOpen, setIsSettingsSavedDialogOpen] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isPostingTask, setIsPostingTask] = useState(false);
  const [isLoadingDirectory, setIsLoadingDirectory] = useState(false);
  const [movingThreadId, setMovingThreadId] = useState<string>();
  const [pendingStageMove, setPendingStageMove] = useState<{ thread: ThreadListItemDto; boardStage: BoardStage }>();
  const [editingBacklogThread, setEditingBacklogThread] = useState<ThreadListItemDto>();
  const [deletingBacklogThread, setDeletingBacklogThread] = useState<ThreadListItemDto>();
  const [libraryStage, setLibraryStage] = useState<LibraryStage>();
  const [showFullLibrary, setShowFullLibrary] = useState(false);
  const [importCsv, setImportCsv] = useState("");
  const [importPreview, setImportPreview] = useState<BulkImportBacklogPreviewDto>();
  const [error, setError] = useState<string>();
  const eventSourceRef = useRef<EventSource | null>(null);

  const backlogThreads = useMemo(() => threads.filter((thread) => thread.boardStage === "ready"), [threads]);
  const archiveThreads = useMemo(() => threads.filter((thread) => thread.boardStage === "done"), [threads]);
  const presetProjects = settings?.presetProjects ?? [];
  const presetProjectNames = useMemo(
    () => new Map(presetProjects.map((project) => [project.id, project.name])),
    [presetProjects]
  );
  const boardThreads = useMemo(() => getDisplayedBoardThreads(threads), [threads]);
  const displayedReadyIds = useMemo(() => new Set(boardThreads.filter((thread) => thread.boardStage === "ready").map((thread) => thread.id)), [boardThreads]);
  const displayedDoneIds = useMemo(() => new Set(boardThreads.filter((thread) => thread.boardStage === "done").map((thread) => thread.id)), [boardThreads]);
  const boardGroups = useMemo(() => groupThreadsByBoardStage(boardThreads), [boardThreads]);
  const stageCounts = useMemo(() => countThreadsByBoardStage(threads), [threads]);
  const isCodexReady = health?.codex.ok && health.mongo.ok;
  const newTaskRemaining = USER_POST_LIMIT - newTaskDraft.length;
  const editTaskRemaining = USER_POST_LIMIT - editTaskDraft.length;
  const replyRemaining = USER_POST_LIMIT - replyDraft.length;
  const libraryBusyThreadId =
    movingThreadId ??
    (isUpdatingBacklogTask ? editingBacklogThread?.id : undefined) ??
    (isDeletingBacklogTask ? deletingBacklogThread?.id : undefined);

  const loadThreads = useCallback(async () => {
    const nextThreads = await fetchThreads();
    setThreads(nextThreads);
    setSelectedThreadId((current) => (current && nextThreads.some((thread) => thread.id === current) ? current : undefined));
  }, []);

  const loadHealth = useCallback(async () => {
    setHealth(await fetchHealth());
  }, []);

  const loadBoardAutomation = useCallback(async () => {
    setBoardAutomation(await fetchBoardAutomation());
  }, []);

  const loadSettings = useCallback(async () => {
    const nextSettings = await fetchAppSettings();
    setSettings(nextSettings);
    setSettingsDraft((current) =>
      workspaceView === "settings"
        ? current
        : settingsToDraft(nextSettings)
    );
  }, [workspaceView]);

  const loadThread = useCallback(async (threadId: string) => {
    setDetail(await fetchThread(threadId));
  }, []);

  const loadDirectory = useCallback(async (path?: string) => {
    setIsLoadingDirectory(true);
    try {
      setDirectory(await fetchLocalDirectories(path));
    } finally {
      setIsLoadingDirectory(false);
    }
  }, []);

  const resetWorkspace = useCallback(() => {
    eventSourceRef.current?.close();
    setThreads([]);
    setSelectedThreadId(undefined);
    setDetail(undefined);
    setHealth(undefined);
    setBoardAutomation(undefined);
    setSettings(undefined);
    setDirectory(undefined);
    setSelectedPresetProjectId(undefined);
    setHeartbeat(undefined);
    setReplyDraft("");
    setNewTaskDraft("");
    setEditTaskDraft("");
    setEditThreadName("");
    setTaskRole("general");
    setEditTaskRole("general");
    setWorkspaceView("board");
    setIsCreateModalOpen(false);
    setIsSettingsSavedDialogOpen(false);
    setImportCsv("");
    setImportPreview(undefined);
    setPendingStageMove(undefined);
    setEditingBacklogThread(undefined);
    setDeletingBacklogThread(undefined);
    setLibraryStage(undefined);
    setShowFullLibrary(false);
    setMovingThreadId(undefined);
    setSettingsDraft(defaultSettingsDraft());
  }, []);

  const handleAppError = useCallback(
    (cause: unknown) => {
      if (isAuthRequiredError(cause)) {
        resetWorkspace();
        setAuthState({ enabled: true, authenticated: false });
        setLoginError(undefined);
        return;
      }
      setError(formatError(cause));
    },
    [resetWorkspace]
  );

  const handleDirectoryChange = useCallback(
    (path?: string) => {
      setSelectedPresetProjectId(undefined);
      void loadDirectory(path).catch(handleAppError);
    },
    [handleAppError, loadDirectory]
  );

  const handlePresetProjectChange = useCallback(
    (projectId: string) => {
      const project = presetProjects.find((item) => item.id === projectId);
      setSelectedPresetProjectId(project?.id);
      if (project) {
        void loadDirectory(project.folder).catch(handleAppError);
      }
    },
    [handleAppError, loadDirectory, presetProjects]
  );

  function handleAddPresetProject(name: string, folder: string): string | undefined {
    const normalizedName = name.trim();
    const normalizedFolder = folder.trim();
    if (!normalizedName || !normalizedFolder) {
      return undefined;
    }
    const projectId = makePresetProjectId();
    setSettingsDraft((current) => {
      if (current.presetProjects.some((project) => project.name === normalizedName)) {
        return current;
      }
      return {
        ...current,
        presetProjects: [
          ...current.presetProjects,
          {
            id: projectId,
            name: normalizedName,
            folder: normalizedFolder,
            roleInitialInstructions: defaultRoleInitialInstructions()
          }
        ]
      };
    });
    return projectId;
  }

  function handleRemovePresetProject(projectId: string) {
    setSettingsDraft((current) => ({
      ...current,
      presetProjects: current.presetProjects.filter((project) => project.id !== projectId)
    }));
  }

  function handlePresetProjectRoleInstructionChange(projectId: string, role: TaskRole, value: string) {
    setSettingsDraft((current) => ({
      ...current,
      presetProjects: current.presetProjects.map((project) =>
        project.id === projectId
          ? {
              ...project,
              roleInitialInstructions: {
                ...project.roleInitialInstructions,
                [role]: value
              }
            }
          : project
      )
    }));
  }

  useEffect(() => {
    let cancelled = false;
    setIsCheckingAuth(true);
    void fetchAuthState()
      .then((nextAuthState) => {
        if (!cancelled) {
          setAuthState(nextAuthState);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(formatError(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCheckingAuth(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authState?.authenticated) {
      return;
    }
    void Promise.all([loadThreads(), loadHealth(), loadDirectory(), loadBoardAutomation(), loadSettings()]).catch(handleAppError);
  }, [authState?.authenticated, handleAppError, loadBoardAutomation, loadDirectory, loadHealth, loadSettings, loadThreads]);

  useEffect(() => {
    if (!authState?.authenticated) {
      return;
    }
    const timer = window.setInterval(() => {
      void Promise.all([loadThreads(), loadBoardAutomation()]).catch(handleAppError);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [authState?.authenticated, handleAppError, loadBoardAutomation, loadThreads]);

  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(undefined);
      setHeartbeat(undefined);
      return;
    }

    setHeartbeat(undefined);
    void loadThread(selectedThreadId).catch(handleAppError);
  }, [handleAppError, loadThread, selectedThreadId]);

  useEffect(() => {
    const taskId = detail?.task?.id;
    if (!taskId || (detail.run && isTerminalRunStatus(detail.run.status))) {
      return;
    }

    let cancelled = false;
    const pollHeartbeat = async () => {
      const nextHeartbeat = await fetchTaskHeartbeat(taskId);
      if (cancelled) {
        return;
      }
      setHeartbeat(nextHeartbeat);
      if (nextHeartbeat.run) {
        setDetail((current) => (current?.task?.id === nextHeartbeat.taskId ? { ...current, run: nextHeartbeat.run } : current));
      }
      if (nextHeartbeat.isTerminal) {
        await Promise.all([loadThread(nextHeartbeat.threadId), loadThreads()]);
      }
    };

    void pollHeartbeat().catch(handleAppError);
    const timer = window.setInterval(() => {
      void pollHeartbeat().catch(handleAppError);
    }, 15000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [detail?.run?.status, detail?.task?.id, handleAppError, loadThread, loadThreads]);

  useEffect(() => {
    if (!detail?.run || isTerminalRunStatus(detail.run.status)) {
      return;
    }

    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [detail?.run?.id, detail?.run?.status]);

  useEffect(() => {
    eventSourceRef.current?.close();
    if (!selectedThreadId) {
      return;
    }

    const stream = new EventSource(`/api/threads/${selectedThreadId}/stream`);
    eventSourceRef.current = stream;

    stream.onmessage = (message) => {
      const event = JSON.parse(message.data) as StreamEvent;
      if (event.type === "post.created") {
        setDetail((current) =>
          current && current.thread.id === event.threadId
            ? { ...current, posts: appendUniquePost(current.posts, event.post) }
            : current
        );
      }
      if (event.type === "thread.updated") {
        setDetail((current) => (current ? { ...current, thread: event.thread } : current));
        void loadThreads();
      }
      if (event.type === "run.updated") {
        setDetail((current) => (current ? { ...current, run: event.run } : current));
        if (isTerminalRunStatus(event.run.status)) {
          setHeartbeat(undefined);
        }
      }
    };

    stream.onerror = () => {
      stream.close();
    };

    return () => stream.close();
  }, [loadThreads, selectedThreadId]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loginUsername.trim() || !loginPassword || isLoggingIn) {
      return;
    }

    setIsLoggingIn(true);
    setLoginError(undefined);
    setError(undefined);
    try {
      const nextAuthState = await loginWithPassword({ username: loginUsername, password: loginPassword });
      setAuthState(nextAuthState);
      setLoginPassword("");
    } catch (cause) {
      setLoginError(formatError(cause));
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleLogout() {
    setIsLoggingIn(true);
    setError(undefined);
    try {
      const nextAuthState = await logoutSession();
      resetWorkspace();
      setAuthState(nextAuthState);
      setLoginPassword("");
      setLoginError(undefined);
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsLoggingIn(false);
    }
  }

  async function handleCreateThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!threadName.trim() || !directory?.path || !newTaskDraft.trim() || newTaskRemaining < 0 || isCreatingThread) {
      return;
    }

    setIsCreatingThread(true);
    setError(undefined);
    try {
      await createThread({
        name: threadName,
        role: taskRole,
        folder: directory.path,
        presetProjectId: selectedPresetProjectId,
        body: newTaskDraft
      });
      setThreadName("");
      setTaskRole("general");
      setNewTaskDraft("");
      setIsCreateModalOpen(false);
      setSelectedThreadId(undefined);
      setLibraryStage(undefined);
      setWorkspaceView("board");
      await loadThreads();
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsCreatingThread(false);
    }
  }

  function handleImportCsvChange(value: string) {
    setImportCsv(value);
    setImportPreview(undefined);
  }

  async function handlePreviewImport(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!directory?.path || !importCsv.trim() || isPreviewingImport) {
      return;
    }

    setIsPreviewingImport(true);
    setError(undefined);
    try {
      setImportPreview(
        await previewBacklogImport({
          folder: directory.path,
          presetProjectId: selectedPresetProjectId,
          csv: importCsv
        })
      );
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsPreviewingImport(false);
    }
  }

  async function handleImportBacklogTasks() {
    if (!directory?.path || !importCsv.trim() || isImportingBacklog) {
      return;
    }

    setIsImportingBacklog(true);
    setError(undefined);
    try {
      await importBacklogTasks({
        folder: directory.path,
        presetProjectId: selectedPresetProjectId,
        csv: importCsv
      });
      setImportCsv("");
      setImportPreview(undefined);
      setSelectedThreadId(undefined);
      setDetail(undefined);
      setHeartbeat(undefined);
      setLibraryStage("backlog");
      setWorkspaceView("library");
      setShowFullLibrary(false);
      await loadThreads();
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsImportingBacklog(false);
    }
  }

  async function handleReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedThreadId || !replyDraft.trim() || replyRemaining < 0 || isPostingTask) {
      return;
    }

    setIsPostingTask(true);
    setError(undefined);
    try {
      const created = await createThreadReply(selectedThreadId, { body: replyDraft });
      setReplyDraft("");
      await loadThreads();
      await loadThread(created.threadId);
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsPostingTask(false);
    }
  }

  function handleOpenEditBacklogTask(thread: ThreadListItemDto) {
    setEditingBacklogThread(thread);
    setEditThreadName(thread.name);
    setEditTaskRole(thread.role);
    setEditTaskDraft(thread.latestPost?.body ?? thread.currentVersionText);
    setError(undefined);
  }

  function handleCloseEditBacklogTask() {
    setEditingBacklogThread(undefined);
    setEditThreadName("");
    setEditTaskRole("general");
    setEditTaskDraft("");
    setError(undefined);
  }

  async function handleUpdateBacklogTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingBacklogThread || !editThreadName.trim() || !editTaskDraft.trim() || editTaskRemaining < 0 || isUpdatingBacklogTask) {
      return;
    }

    setIsUpdatingBacklogTask(true);
    setError(undefined);
    try {
      const updated = await updateBacklogTask(editingBacklogThread.id, {
        name: editThreadName,
        role: editTaskRole,
        body: editTaskDraft
      });
      setThreads((current) => current.map((thread) => (thread.id === updated.thread.id ? { ...thread, ...updated.thread } : thread)));
      setSelectedThreadId(undefined);
      setDetail(undefined);
      setHeartbeat(undefined);
      setLibraryStage(undefined);
      setShowFullLibrary(false);
      handleCloseEditBacklogTask();
      await loadThreads();
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsUpdatingBacklogTask(false);
    }
  }

  function handleOpenDeleteBacklogTask(thread: ThreadListItemDto) {
    setDeletingBacklogThread(thread);
  }

  async function handleConfirmDeleteBacklogTask() {
    const thread = deletingBacklogThread;
    if (!thread || isDeletingBacklogTask) {
      return;
    }

    setIsDeletingBacklogTask(true);
    setError(undefined);
    try {
      await deleteBacklogTask(thread.id);
      setThreads((current) => current.filter((item) => item.id !== thread.id));
      if (selectedThreadId === thread.id) {
        setSelectedThreadId(undefined);
        setDetail(undefined);
        setHeartbeat(undefined);
      }
      setDeletingBacklogThread(undefined);
      await loadThreads();
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsDeletingBacklogTask(false);
    }
  }

  async function moveThreadToStage(threadId: string, boardStage: BoardStage) {
    setMovingThreadId(threadId);
    setError(undefined);
    try {
      const updated = await updateThreadBoardStage(threadId, { boardStage });
      setThreads((current) => current.map((thread) => (thread.id === updated.thread.id ? { ...thread, ...updated.thread } : thread)));
      if (selectedThreadId === threadId) {
        await loadThread(threadId);
      }
      await loadThreads();
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setMovingThreadId(undefined);
    }
  }

  async function setThreadBoardDisplay(threadId: string, boardDisplay: BoardDisplay) {
    setMovingThreadId(threadId);
    setError(undefined);
    try {
      const updated = await updateThreadBoardDisplay(threadId, { boardDisplay });
      setThreads((current) => current.map((thread) => (thread.id === updated.thread.id ? { ...thread, ...updated.thread } : thread)));
      if (selectedThreadId === threadId) {
        await loadThread(threadId);
      }
      await loadThreads();
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setMovingThreadId(undefined);
    }
  }

  function handleBoardStageRequest(thread: ThreadListItemDto, boardStage: BoardStage) {
    if (thread.boardStage === boardStage && boardStage !== "wip") {
      return;
    }
    if (boardStage === "wip") {
      setPendingStageMove({ thread, boardStage });
      return;
    }
    void moveThreadToStage(thread.id, boardStage);
  }

  async function handleConfirmStageMove() {
    const move = pendingStageMove;
    if (!move) {
      return;
    }
    setPendingStageMove(undefined);
    await moveThreadToStage(move.thread.id, move.boardStage);
  }

  function handleOpenLibrary(boardStage: LibraryStage) {
    setIsCreateModalOpen(false);
    setSelectedThreadId(undefined);
    setDetail(undefined);
    setHeartbeat(undefined);
    setLibraryStage(boardStage);
    setWorkspaceView("library");
    setShowFullLibrary(false);
  }

  function handleOpenThreadFromLibrary(threadId: string) {
    setSelectedThreadId(threadId);
  }

  function handleSetLibraryDisplay(thread: ThreadListItemDto, isDisplayed: boolean) {
    void setThreadBoardDisplay(thread.id, isDisplayed ? "hidden" : "shown");
  }

  async function handleToggleBoardAutomation(enabled: boolean) {
    if (isUpdatingAutomation) {
      return;
    }
    setIsUpdatingAutomation(true);
    setError(undefined);
    try {
      const updated = await updateBoardAutomation({ enabled });
      setBoardAutomation(updated.automation);
      if (enabled) {
        await loadThreads();
      }
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsUpdatingAutomation(false);
    }
  }

  async function handleCheckBoardAutomation() {
    if (isUpdatingAutomation || !boardAutomation?.enabled) {
      return;
    }
    setIsUpdatingAutomation(true);
    setError(undefined);
    try {
      const result = await checkBoardAutomation();
      setBoardAutomation(result.automation);
      if (result.startedCount > 0) {
        await loadThreads();
      }
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsUpdatingAutomation(false);
    }
  }

  function handleRefreshBoard() {
    void Promise.all([loadThreads(), loadHealth(), loadBoardAutomation(), loadSettings()]).catch(handleAppError);
  }

  function handleOpenBoard() {
    setIsCreateModalOpen(false);
    setLibraryStage(undefined);
    setSelectedThreadId(undefined);
    setWorkspaceView("board");
  }

  function handleOpenSettings() {
    setLibraryStage(undefined);
    setSelectedThreadId(undefined);
    setIsCreateModalOpen(false);
    setSettingsDraft(settings ? settingsToDraft(settings) : defaultSettingsDraft());
    setWorkspaceView("settings");
  }

  function handleOpenImport() {
    setLibraryStage(undefined);
    setSelectedThreadId(undefined);
    setIsCreateModalOpen(false);
    setWorkspaceView("import");
  }

  async function handleSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSavingSettings) {
      return;
    }

    setIsSavingSettings(true);
    setError(undefined);
    try {
      const updated = await saveAppSettings(settingsDraft);
      setSettings(updated.settings);
      setSettingsDraft(settingsToDraft(updated.settings));
      setBoardAutomation(updated.automation);
      setSelectedPresetProjectId((current) =>
        current && updated.settings.presetProjects.some((project) => project.id === current) ? current : undefined
      );
      setIsSettingsSavedDialogOpen(true);
    } catch (cause) {
      handleAppError(cause);
    } finally {
      setIsSavingSettings(false);
    }
  }

  if (isCheckingAuth || !authState) {
    return <AuthLoadingScreen />;
  }

  if (authState.enabled && !authState.authenticated) {
    return (
      <LoginScreen
        error={loginError}
        isLoggingIn={isLoggingIn}
        onLogin={handleLogin}
        onPasswordChange={setLoginPassword}
        onUsernameChange={setLoginUsername}
        password={loginPassword}
        username={loginUsername}
      />
    );
  }

  return (
    <main className="appShell">
      <aside className="sidebar" aria-label="线程导航">
        <div className="brandBlock">
          <div className="brandMark">H</div>
          <div className="brandCopy">
            <h1>Harness</h1>
            <p>线程驱动的 Codex 工作台</p>
          </div>
        </div>

        <AccountStatusPanel
          authState={authState}
          health={health}
          isLoggingIn={isLoggingIn}
          onLogout={() => void handleLogout()}
          ready={Boolean(isCodexReady)}
        />

        <SidebarWorkspaceNav
          archiveCount={archiveThreads.length}
          activeLibraryStage={libraryStage}
          automation={boardAutomation}
          backlogCount={backlogThreads.length}
          isBoardActive={!selectedThreadId && workspaceView === "board" && !isCreateModalOpen}
          isCreateActive={isCreateModalOpen}
          isImportActive={!selectedThreadId && workspaceView === "import"}
          isSettingsActive={!selectedThreadId && workspaceView === "settings"}
          isUpdatingAutomation={isUpdatingAutomation}
          onAutomationCheck={() => void handleCheckBoardAutomation()}
          onAutomationToggle={(enabled) => void handleToggleBoardAutomation(enabled)}
          onCreateTask={() => {
            setIsCreateModalOpen(true);
          }}
          onImportTasks={handleOpenImport}
          onOpenBoard={handleOpenBoard}
          onOpenSettings={handleOpenSettings}
          onOpenLibrary={handleOpenLibrary}
          onRefresh={handleRefreshBoard}
          stageCounts={stageCounts}
        />
      </aside>

      <section className="workArea">
        {error ? (
          <div className="errorBanner" role="alert">
            <AlertCircle size={18} />
            {error}
          </div>
        ) : null}

        {selectedThreadId ? (
          detail ? (
            <ThreadWorkspace
              detail={detail}
              heartbeat={heartbeat}
              isPostingTask={isPostingTask}
              nowMs={nowMs}
              onBackToBoard={() => {
                setSelectedThreadId(undefined);
                setWorkspaceView("board");
                setLibraryStage(undefined);
              }}
              onReply={handleReply}
              onReplyDraftChange={setReplyDraft}
              replyDraft={replyDraft}
              replyRemaining={replyRemaining}
              run={detail.run}
            />
          ) : (
            <div className="emptyState">
              <Loader2 className="spin" size={24} />
              <h2>正在载入线程</h2>
            </div>
          )
        ) : workspaceView === "settings" ? (
          <AppSettingsPage
            draft={settingsDraft}
            directory={directory}
            isSaving={isSavingSettings}
            isLoadingDirectory={isLoadingDirectory}
            onAddPresetProject={handleAddPresetProject}
            onAutoRunIntervalMinutesChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                autoRunIntervalMinutes: value
              }))
            }
            onDirectoryChange={handleDirectoryChange}
            onMaxConcurrentTasksChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                maxConcurrentTasks: value
              }))
            }
            onCodexThreadPrefixChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                codexThreadPrefix: value
              }))
            }
            onSystemPromptChange={(value) =>
              setSettingsDraft((current) => ({
                ...current,
                systemPrompt: value
              }))
            }
            onPresetProjectRoleInstructionChange={handlePresetProjectRoleInstructionChange}
            onRemovePresetProject={handleRemovePresetProject}
            onSubmit={handleSaveSettings}
          />
        ) : workspaceView === "import" ? (
          <BulkImportBacklogPage
            directory={directory}
            importCsv={importCsv}
            importPreview={importPreview}
            isImporting={isImportingBacklog}
            isLoadingDirectory={isLoadingDirectory}
            isPreviewing={isPreviewingImport}
            onCsvChange={handleImportCsvChange}
            onCsvReadError={handleAppError}
            onDirectoryChange={handleDirectoryChange}
            onImport={() => void handleImportBacklogTasks()}
            onPresetProjectChange={handlePresetProjectChange}
            onPreview={(event) => void handlePreviewImport(event)}
            presetProjects={presetProjects}
            selectedPresetProjectId={selectedPresetProjectId}
          />
        ) : workspaceView === "library" && libraryStage ? (
          <StageLibraryPage
            busyThreadId={libraryBusyThreadId}
            onDeleteBacklogTask={handleOpenDeleteBacklogTask}
            onEditBacklogTask={handleOpenEditBacklogTask}
            onOpenThread={handleOpenThreadFromLibrary}
            onSetDisplay={handleSetLibraryDisplay}
            onShowAllChange={setShowFullLibrary}
            presetProjectNames={presetProjectNames}
            showAll={showFullLibrary}
            stage={libraryStage}
            threads={libraryStage === "backlog" ? backlogThreads : archiveThreads}
            visibleThreadIds={libraryStage === "backlog" ? displayedReadyIds : displayedDoneIds}
          />
        ) : (
          <KanbanBoard
            boardGroups={boardGroups}
            movingThreadId={movingThreadId}
            onArchiveThread={(thread) => void setThreadBoardDisplay(thread.id, "hidden")}
            onOpenThread={setSelectedThreadId}
            onStageRequest={handleBoardStageRequest}
            presetProjectNames={presetProjectNames}
          />
        )}
      </section>

      {isCreateModalOpen ? (
        <CreateThreadModal
          directory={directory}
          isCreatingThread={isCreatingThread}
          isLoadingDirectory={isLoadingDirectory}
          newTaskDraft={newTaskDraft}
          newTaskRemaining={newTaskRemaining}
          onClose={() => setIsCreateModalOpen(false)}
          onCreateThread={handleCreateThread}
          onDirectoryChange={handleDirectoryChange}
          onNewTaskDraftChange={setNewTaskDraft}
          onPresetProjectChange={handlePresetProjectChange}
          onRoleChange={setTaskRole}
          onThreadNameChange={setThreadName}
          presetProjects={presetProjects}
          role={taskRole}
          selectedPresetProjectId={selectedPresetProjectId}
          threadName={threadName}
        />
      ) : null}

      {pendingStageMove ? (
        <ConfirmStageMoveDialog
          isMoving={movingThreadId === pendingStageMove.thread.id}
          onCancel={() => setPendingStageMove(undefined)}
          onConfirm={() => void handleConfirmStageMove()}
          thread={pendingStageMove.thread}
        />
      ) : null}

      {editingBacklogThread ? (
        <EditBacklogTaskDialog
          editTaskDraft={editTaskDraft}
          editTaskRemaining={editTaskRemaining}
          editTaskRole={editTaskRole}
          editThreadName={editThreadName}
          isUpdating={isUpdatingBacklogTask}
          onClose={handleCloseEditBacklogTask}
          onEditTaskDraftChange={setEditTaskDraft}
          onEditTaskRoleChange={setEditTaskRole}
          onEditThreadNameChange={setEditThreadName}
          onSubmit={handleUpdateBacklogTask}
          thread={editingBacklogThread}
        />
      ) : null}

      {deletingBacklogThread ? (
        <ConfirmDeleteBacklogTaskDialog
          isDeleting={isDeletingBacklogTask}
          onCancel={() => setDeletingBacklogThread(undefined)}
          onConfirm={() => void handleConfirmDeleteBacklogTask()}
          thread={deletingBacklogThread}
        />
      ) : null}

      {isSettingsSavedDialogOpen ? <SettingsSavedDialog onClose={() => setIsSettingsSavedDialogOpen(false)} /> : null}
    </main>
  );
}

function AuthLoadingScreen() {
  return (
    <main className="loginShell">
      <div className="authLoading">
        <Loader2 className="spin" size={22} />
        <span>正在检查登录状态</span>
      </div>
    </main>
  );
}

function LoginScreen({
  error,
  isLoggingIn,
  onLogin,
  onPasswordChange,
  onUsernameChange,
  password,
  username
}: {
  error?: string;
  isLoggingIn: boolean;
  onLogin: (event: FormEvent<HTMLFormElement>) => void;
  onPasswordChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  password: string;
  username: string;
}) {
  return (
    <main className="loginShell">
      <form className="loginPanel" onSubmit={onLogin}>
        <div className="loginMark">
          <LockKeyhole size={22} />
        </div>
        <div className="loginCopy">
          <h1>登录 Harness</h1>
          <p>输入账户和访问密码后才能操作 Codex 工作台。</p>
        </div>
        <label className="fieldBlock">
          <span>账户</span>
          <input
            autoComplete="username"
            autoFocus
            onChange={(event) => onUsernameChange(event.target.value)}
            placeholder="输入账户"
            value={username}
          />
        </label>
        <label className="fieldBlock">
          <span>访问密码</span>
          <input
            autoComplete="current-password"
            onChange={(event) => onPasswordChange(event.target.value)}
            placeholder="输入访问密码"
            type="password"
            value={password}
          />
        </label>
        {error ? (
          <div className="loginError" role="alert">
            <AlertCircle size={16} />
            {error}
          </div>
        ) : null}
        <button className="primaryButton" disabled={!username.trim() || !password || isLoggingIn} type="submit">
          {isLoggingIn ? <Loader2 className="spin" size={16} /> : <LockKeyhole size={16} />}
          登录
        </button>
      </form>
    </main>
  );
}

function CreateThreadModal({
  directory,
  isCreatingThread,
  isLoadingDirectory,
  newTaskDraft,
  newTaskRemaining,
  onClose,
  onCreateThread,
  onDirectoryChange,
  onNewTaskDraftChange,
  onPresetProjectChange,
  onRoleChange,
  onThreadNameChange,
  presetProjects,
  role,
  selectedPresetProjectId,
  threadName
}: {
  directory?: LocalDirectoryDto;
  isCreatingThread: boolean;
  isLoadingDirectory: boolean;
  newTaskDraft: string;
  newTaskRemaining: number;
  onClose: () => void;
  onCreateThread: (event: FormEvent<HTMLFormElement>) => void;
  onDirectoryChange: (path?: string) => void;
  onNewTaskDraftChange: (value: string) => void;
  onPresetProjectChange: (projectId: string) => void;
  onRoleChange: (role: TaskRole) => void;
  onThreadNameChange: (value: string) => void;
  presetProjects: PresetProjectDto[];
  role: TaskRole;
  selectedPresetProjectId?: string;
  threadName: string;
}) {
  return (
    <div className="modalBackdrop" role="presentation">
      <form className="createThreadForm createThreadDialog" onSubmit={onCreateThread}>
        <div className="dialogHeader">
          <div>
            <span className="sectionLabel">Ready</span>
            <h2>发布任务</h2>
          </div>
          <button className="iconButton" onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </div>

        <label className="fieldBlock">
          <span>线程名称</span>
          <input
            maxLength={THREAD_NAME_LIMIT}
            onChange={(event) => onThreadNameChange(event.target.value)}
            placeholder="例如：Harness 执行链路改造"
            value={threadName}
          />
        </label>

        <TaskRoleSelect label="Role" onChange={onRoleChange} value={role} />

        <PresetProjectSelect
          onChange={onPresetProjectChange}
          presetProjects={presetProjects}
          selectedProjectId={selectedPresetProjectId}
        />

        <DirectoryChooser directory={directory} isLoading={isLoadingDirectory} onDirectoryChange={onDirectoryChange} />

        <label className="fieldBlock">
          <span>根任务</span>
          <textarea
            aria-label="根任务"
            maxLength={USER_POST_LIMIT + 20}
            onChange={(event) => onNewTaskDraftChange(event.target.value)}
            placeholder="用 500 字以内描述这条线程要完成的任务..."
            value={newTaskDraft}
          />
        </label>

        <div className="formFooter">
          <span className={newTaskRemaining < 0 ? "overLimit" : ""}>
            {directory?.path ?? "请选择本地目录"} · {newTaskRemaining} 字剩余
          </span>
          <button
            className="primaryButton"
            disabled={!threadName.trim() || !directory?.path || !newTaskDraft.trim() || newTaskRemaining < 0 || isCreatingThread}
            type="submit"
          >
            {isCreatingThread ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}
            发布到 Ready
          </button>
        </div>
      </form>
    </div>
  );
}

function TaskRoleSelect({
  label,
  onChange,
  value
}: {
  label: string;
  onChange: (role: TaskRole) => void;
  value: TaskRole;
}) {
  return (
    <label className="fieldBlock">
      <span>{label}</span>
      <select aria-label={label} onChange={(event) => onChange(event.target.value as TaskRole)} value={value}>
        {TASK_ROLE_VALUES.map((role) => (
          <option key={role} value={role}>
            {taskRoleLabel[role]}
          </option>
        ))}
      </select>
    </label>
  );
}

function PresetProjectSelect({
  onChange,
  presetProjects,
  selectedProjectId
}: {
  onChange: (projectId: string) => void;
  presetProjects: PresetProjectDto[];
  selectedProjectId?: string;
}) {
  if (presetProjects.length === 0) {
    return null;
  }

  const value = selectedProjectId && presetProjects.some((project) => project.id === selectedProjectId) ? selectedProjectId : "";
  return (
    <label className="fieldBlock">
      <span>预设项目</span>
      <select aria-label="预设项目" onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">手动选择目录</option>
        {presetProjects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function TaskRoleBadge({ role }: { role: TaskRole }) {
  return <span className={`taskRoleBadge ${role}`}>{taskRoleLabel[role]}</span>;
}

function AppSettingsPage({
  directory,
  draft,
  isLoadingDirectory,
  isSaving,
  onAddPresetProject,
  onAutoRunIntervalMinutesChange,
  onCodexThreadPrefixChange,
  onDirectoryChange,
  onMaxConcurrentTasksChange,
  onPresetProjectRoleInstructionChange,
  onRemovePresetProject,
  onSystemPromptChange,
  onSubmit
}: {
  directory?: LocalDirectoryDto;
  draft: AppSettingsFormState;
  isLoadingDirectory: boolean;
  isSaving: boolean;
  onAddPresetProject: (name: string, folder: string) => string | undefined;
  onAutoRunIntervalMinutesChange: (value: number) => void;
  onCodexThreadPrefixChange: (value: string) => void;
  onDirectoryChange: (path?: string) => void;
  onMaxConcurrentTasksChange: (value: number) => void;
  onPresetProjectRoleInstructionChange: (projectId: string, role: TaskRole, value: string) => void;
  onRemovePresetProject: (projectId: string) => void;
  onSystemPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [presetProjectName, setPresetProjectName] = useState("");
  const [roleProjectId, setRoleProjectId] = useState(draft.presetProjects[0]?.id ?? "");
  const normalizedProjectName = presetProjectName.trim();
  const hasDuplicateProjectName = draft.presetProjects.some((project) => project.name === normalizedProjectName);
  const canAddPresetProject = Boolean(normalizedProjectName && directory?.path && !hasDuplicateProjectName);
  const roleProject = draft.presetProjects.find((project) => project.id === roleProjectId);

  useEffect(() => {
    if (!draft.presetProjects.some((project) => project.id === roleProjectId)) {
      setRoleProjectId(draft.presetProjects[0]?.id ?? "");
    }
  }, [draft.presetProjects, roleProjectId]);

  return (
      <form className="createThreadForm workspacePage settingsPage" onSubmit={onSubmit}>
        <div className="pageHeader">
          <div>
            <span className="sectionLabel">Settings</span>
            <h2>工作台设置</h2>
            <p>这些设置会写入数据库。保存后立即生效，服务重启后仍会继续使用。</p>
          </div>
        </div>

        <div className="settingsGrid">
          <label className="fieldBlock">
            <span>新线程命名前缀</span>
            <input
              aria-label="新线程命名前缀"
              maxLength={CODEX_THREAD_PREFIX_LIMIT}
              onChange={(event) => onCodexThreadPrefixChange(event.target.value)}
              placeholder="[Harness]"
              value={draft.codexThreadPrefix}
            />
          </label>

          <label className="fieldBlock">
            <span>自动模式检查间隔</span>
            <select
              aria-label="自动模式检查间隔"
              onChange={(event) => onAutoRunIntervalMinutesChange(Number(event.target.value))}
              value={draft.autoRunIntervalMinutes}
            >
              {autoRunIntervalOptions.map((value) => (
                <option key={value} value={value}>
                  {value} 分钟
                </option>
              ))}
            </select>
          </label>

          <label className="fieldBlock">
            <span>允许同时工作的任务</span>
            <select
              aria-label="允许同时工作的任务"
              onChange={(event) => onMaxConcurrentTasksChange(Number(event.target.value))}
              value={draft.maxConcurrentTasks}
            >
              {maxConcurrentTaskOptions.map((value) => (
                <option key={value} value={value}>
                  {value} 个
                </option>
              ))}
            </select>
          </label>

          <div className="fieldBlock settingsSystemPromptBlock">
            <div className="settingsFieldHeader">
              <span>线程初始化基础 Prompt</span>
              <button
                className="secondaryButton compactTextButton"
                disabled={draft.systemPrompt === DEFAULT_CODEX_SYSTEM_PROMPT}
                onClick={() => onSystemPromptChange(DEFAULT_CODEX_SYSTEM_PROMPT)}
                type="button"
              >
                <RefreshCw size={14} />
                恢复默认
              </button>
            </div>
            <textarea
              aria-label="线程初始化基础 Prompt"
              maxLength={CODEX_SYSTEM_PROMPT_LIMIT}
              onChange={(event) => onSystemPromptChange(event.target.value)}
              placeholder={DEFAULT_CODEX_SYSTEM_PROMPT}
              value={draft.systemPrompt}
            />
            <p className="formHint">这段内容只会加入每个线程首次启动 Codex 的 prompt；线程内继续回复不会重复加入。</p>
          </div>
        </div>

        <section className="settingsPresetSection">
          <div className="settingsRoleHeader">
            <strong>预设项目</strong>
            <p>把常用工作区目录保存为项目，发布任务和批量导入时可以直接选择。</p>
          </div>

          <div className="presetProjectCreate">
            <label className="fieldBlock">
              <span>项目名称</span>
              <input
                maxLength={PRESET_PROJECT_NAME_LIMIT}
                onChange={(event) => setPresetProjectName(event.target.value)}
                placeholder="例如：ExampleApp"
                value={presetProjectName}
              />
            </label>
            <button
              className="secondaryButton"
              disabled={!canAddPresetProject}
              onClick={() => {
                if (!directory?.path) {
                  return;
                }
                const projectId = onAddPresetProject(normalizedProjectName, directory.path);
                if (projectId) {
                  setRoleProjectId(projectId);
                }
                setPresetProjectName("");
              }}
              type="button"
            >
              <Plus size={15} />
              新建项目
            </button>
          </div>
          {hasDuplicateProjectName ? <p className="formHint warning">项目名称已存在。</p> : null}

          <DirectoryChooser directory={directory} isLoading={isLoadingDirectory} label="绑定目录" onDirectoryChange={onDirectoryChange} />

          <div className="presetProjectList" aria-label="预设项目列表">
            {draft.presetProjects.length === 0 ? <p className="emptyText">还没有预设项目。</p> : null}
            {draft.presetProjects.map((project) => {
              const isActiveProject = project.id === roleProjectId;

              return (
                <div className={`presetProjectItem ${isActiveProject ? "active" : ""}`} key={project.id}>
                  <button
                    aria-pressed={isActiveProject}
                    className="presetProjectSelectButton"
                    onClick={() => setRoleProjectId(project.id)}
                    title="选择这个预设项目并编辑它的 Role 初始化字段"
                    type="button"
                  >
                    <Folder size={16} />
                    <div className="presetProjectMeta">
                      <strong>{project.name}</strong>
                      <span title={project.folder}>{project.folder}</span>
                    </div>
                  </button>
                  <div className="presetProjectActions">
                    <button className="iconButton danger" onClick={() => onRemovePresetProject(project.id)} title="删除预设项目" type="button">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <section className="projectRolePanel" aria-label="选中预设项目的 Role 初始化字段">
            <div className="settingsRoleHeader projectRoleHeader">
              <strong>选中项目的 Role 初始化字段</strong>
              <p>这些字段只在任务选择了对应预设项目时追加到首次 Codex prompt。手动选择目录的任务不会追加。</p>
            </div>
            {roleProject ? (
              <>
                <div className="selectedPresetProject">
                  <div>
                    <span className="selectedProjectEyebrow">正在编辑</span>
                    <strong>{roleProject.name}</strong>
                  </div>
                  <span className="selectedProjectFolder" title={roleProject.folder}>
                    {roleProject.folder}
                  </span>
                </div>
                <div className="settingsRoleGrid">
                  {TASK_ROLE_VALUES.map((role) => (
                    <label className="fieldBlock settingsRoleCard" key={role}>
                      <span>
                        <TaskRoleBadge role={role} />
                      </span>
                      <textarea
                        aria-label={`${roleProject.name} ${taskRoleLabel[role]} 初始化字段`}
                        maxLength={ROLE_INIT_INSTRUCTION_LIMIT}
                        onChange={(event) => onPresetProjectRoleInstructionChange(roleProject.id, role, event.target.value)}
                        placeholder={`选择 ${roleProject.name} 并启动 ${taskRoleLabel[role]} 任务时追加的固定要求`}
                        value={roleProject.roleInitialInstructions[role]}
                      />
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p className="emptyText">先新建一个预设项目，再配置该项目的 Role 初始化字段。</p>
            )}
          </section>
        </section>

        <div className="formFooter">
          <span>新线程名会按“前缀-角色名-任务名”生成；Role 初始化字段只跟随预设项目生效。</span>
          <button className="primaryButton" disabled={isSaving} type="submit">
            {isSaving ? <Loader2 className="spin" size={16} /> : <Settings2 size={16} />}
            保存设置
          </button>
        </div>
      </form>
  );
}

function BulkImportBacklogPage({
  directory,
  importCsv,
  importPreview,
  isImporting,
  isLoadingDirectory,
  isPreviewing,
  onCsvChange,
  onCsvReadError,
  onDirectoryChange,
  onImport,
  onPresetProjectChange,
  onPreview,
  presetProjects,
  selectedPresetProjectId
}: {
  directory?: LocalDirectoryDto;
  importCsv: string;
  importPreview?: BulkImportBacklogPreviewDto;
  isImporting: boolean;
  isLoadingDirectory: boolean;
  isPreviewing: boolean;
  onCsvChange: (value: string) => void;
  onCsvReadError: (cause: unknown) => void;
  onDirectoryChange: (path?: string) => void;
  onImport: () => void;
  onPresetProjectChange: (projectId: string) => void;
  onPreview: (event?: FormEvent<HTMLFormElement>) => void;
  presetProjects: PresetProjectDto[];
  selectedPresetProjectId?: string;
}) {
  const hasBlockingErrors = Boolean(importPreview?.errors.length);
  const canImport = Boolean(directory?.path && importCsv.trim() && importPreview?.rows.length && !hasBlockingErrors);

  return (
      <form className="createThreadForm workspacePage bulkImportPage" onSubmit={onPreview}>
        <div className="pageHeader">
          <div>
            <span className="sectionLabel">Backlog</span>
            <h2>批量导入任务</h2>
            <p>CSV 使用四列：client_key,name,role,body。role 可填 se、art、design、music、general；导入后全部进入 Backlog，不显示到 Ready，也不会启动 Codex。</p>
          </div>
        </div>

        <PresetProjectSelect
          onChange={onPresetProjectChange}
          presetProjects={presetProjects}
          selectedProjectId={selectedPresetProjectId}
        />

        <DirectoryChooser directory={directory} isLoading={isLoadingDirectory} label="导入文件夹" onDirectoryChange={onDirectoryChange} />

        <div className="bulkImportGrid">
          <label className="fieldBlock fileFieldBlock">
            <span>CSV 文件</span>
            <input
              accept=".csv,text/csv"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) {
                  return;
                }
                void readCsvFile(file).then(onCsvChange).catch(onCsvReadError);
              }}
              type="file"
            />
          </label>
          <a className="secondaryButton templateDownloadButton" href="/backlog-import-template.csv" download>
            <Upload size={15} />
            下载模板
          </a>
        </div>

        {importPreview ? <BulkImportPreviewPanel preview={importPreview} /> : <p className="importHelp">最多一次导入 {BULK_IMPORT_MAX_ROWS} 条任务。任务标题限制 {THREAD_NAME_LIMIT} 字，任务内容限制 {USER_POST_LIMIT} 字。</p>}

        <div className="formFooter">
          <span>
            {directory?.path ?? "请选择导入文件夹"}
            {importPreview ? ` · ${importPreview.validRows}/${importPreview.totalRows} 条有效` : ""}
          </span>
          <div className="dialogActions">
            <button className="secondaryButton" disabled={!directory?.path || !importCsv.trim() || isPreviewing || isImporting} type="submit">
              {isPreviewing ? <Loader2 className="spin" size={16} /> : <Eye size={16} />}
              预览
            </button>
            <button className="primaryButton" disabled={!canImport || isImporting || isPreviewing} onClick={onImport} type="button">
              {isImporting ? <Loader2 className="spin" size={16} /> : <Upload size={16} />}
              导入 Backlog
            </button>
          </div>
        </div>
      </form>
  );
}

function BulkImportPreviewPanel({ preview }: { preview: BulkImportBacklogPreviewDto }) {
  return (
    <section className={`importPreviewPanel ${preview.errors.length > 0 ? "hasErrors" : ""}`} aria-label="导入预览">
      <div className="importPreviewSummary">
        <strong>{preview.errors.length > 0 ? "CSV 需要修正" : "CSV 可以导入"}</strong>
        <span>
          共 {preview.totalRows} 行任务，{preview.validRows} 行有效，{preview.errors.length} 个错误
        </span>
      </div>

      {preview.errors.length > 0 ? (
        <div className="importErrorList" role="alert">
          {preview.errors.slice(0, 8).map((error) => (
            <p key={`${error.rowNumber}-${error.message}`}>
              第 {error.rowNumber} 行{error.clientKey ? `（${error.clientKey}）` : ""}：{error.message}
            </p>
          ))}
          {preview.errors.length > 8 ? <p>还有 {preview.errors.length - 8} 个错误未显示。</p> : null}
        </div>
      ) : null}

      {preview.rows.length > 0 ? (
        <div className="importPreviewTableWrap">
          <table className="importPreviewTable">
            <thead>
              <tr>
                <th>行</th>
                <th>client_key</th>
                <th>Role</th>
                <th>name</th>
                <th>body</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.slice(0, 10).map((row) => (
                <tr key={`${row.rowNumber}-${row.clientKey ?? row.name}`}>
                  <td>{row.rowNumber}</td>
                  <td>{row.clientKey ?? "-"}</td>
                  <td>
                    <TaskRoleBadge role={row.role} />
                  </td>
                  <td>{row.name}</td>
                  <td>{row.body}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > 10 ? <p className="importHelp">只预览前 10 条，有效任务共 {preview.rows.length} 条。</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function KanbanBoard({
  boardGroups,
  movingThreadId,
  onArchiveThread,
  onOpenThread,
  onStageRequest,
  presetProjectNames
}: {
  boardGroups: Record<KanbanStage, ThreadListItemDto[]>;
  movingThreadId?: string;
  onArchiveThread: (thread: ThreadListItemDto) => void;
  onOpenThread: (threadId: string) => void;
  onStageRequest: (thread: ThreadListItemDto, boardStage: BoardStage) => void;
  presetProjectNames: Map<string, string>;
}) {
  const findThread = (threadId: string) => boardColumns.flatMap((stage) => boardGroups[stage]).find((thread) => thread.id === threadId);

  function handleDrop(event: DragEvent<HTMLDivElement>, boardStage: BoardStage) {
    event.preventDefault();
    const threadId = event.dataTransfer.getData("application/x-harness-thread-id");
    const thread = findThread(threadId);
    if (thread) {
      onStageRequest(thread, boardStage);
    }
  }

  return (
    <section className="kanbanWorkspace">
      <div className="boardHeader">
        <div>
          <span className="sectionLabel">Kanban</span>
          <h2>任务看板</h2>
        </div>
      </div>

      <div className="kanbanBoard">
        {boardColumns.map((stage) => (
          <div
            className={`kanbanColumn ${stage}`}
            key={stage}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => handleDrop(event, stage)}
          >
            <div className="kanbanColumnHeader">
              <div>
                <strong>{boardStageLabel[stage]}</strong>
                <span>{boardStageHint[stage]}</span>
              </div>
              <span>{boardGroups[stage].length}</span>
            </div>
            <div className="kanbanColumnBody">
              {boardGroups[stage].length === 0 ? <p className="emptyText">暂无任务</p> : null}
              {boardGroups[stage].map((thread) => (
                <KanbanCard
                  isMoving={movingThreadId === thread.id}
                  key={thread.id}
                  onArchiveThread={onArchiveThread}
                  onOpenThread={onOpenThread}
                  presetProjectName={thread.presetProjectId ? (presetProjectNames.get(thread.presetProjectId) ?? thread.presetProjectId) : undefined}
                  thread={thread}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StageLibraryPage({
  busyThreadId,
  onDeleteBacklogTask,
  onEditBacklogTask,
  onOpenThread,
  onSetDisplay,
  onShowAllChange,
  presetProjectNames,
  showAll,
  stage,
  threads,
  visibleThreadIds
}: {
  busyThreadId?: string;
  onDeleteBacklogTask: (thread: ThreadListItemDto) => void;
  onEditBacklogTask: (thread: ThreadListItemDto) => void;
  onOpenThread: (threadId: string) => void;
  onSetDisplay: (thread: ThreadListItemDto, isDisplayed: boolean) => void;
  onShowAllChange: (showAll: boolean) => void;
  presetProjectNames: Map<string, string>;
  showAll: boolean;
  stage: LibraryStage;
  threads: ThreadListItemDto[];
  visibleThreadIds: Set<string>;
}) {
  const visibleThreads = showAll ? threads : threads.slice(0, libraryPreviewLimit);
  const hiddenCount = Math.max(0, threads.length - visibleThreads.length);
  const isBacklog = stage === "backlog";

  return (
      <section className="stageLibraryPage workspacePage" aria-label={isBacklog ? "Backlog 任务库" : "Archive 归档库"}>
        <div className="pageHeader">
          <div>
            <span className="sectionLabel">{isBacklog ? "Backlog" : "Archive"}</span>
            <h2>{isBacklog ? "Backlog 任务库" : "Archive 归档库"}</h2>
            <p>{isBacklog ? "这里包含所有 Ready 任务；Ready 栏只是默认最近 10 条和手动显示项。" : "这里包含所有 Done 任务；Done 栏只是默认最近 10 条和手动显示项。"}</p>
          </div>
        </div>

        <div className="stageLibraryList">
          {visibleThreads.length === 0 ? <p className="emptyText">{isBacklog ? "Backlog 暂无任务。" : "Archive 暂无归档任务。"}</p> : null}
          {visibleThreads.map((thread) => (
            <article className="stageLibraryCard" key={thread.id}>
              <div className="kanbanCardTop">
                <span className="taskIdBadge" title={`任务ID ${thread.publicTaskId}`}>
                  {thread.publicTaskId}
                </span>
                {thread.presetProjectId ? (
                  <span className="presetProjectBadge" title={`预设项目 ${presetProjectNames.get(thread.presetProjectId) ?? thread.presetProjectId}`}>
                    {presetProjectNames.get(thread.presetProjectId) ?? thread.presetProjectId}
                  </span>
                ) : null}
                <span className={`boardStageBadge ${thread.boardStage}`}>{boardStageLabel[thread.boardStage]}</span>
                <TaskRoleBadge role={thread.role} />
                <span className={`statusBadge compact ${thread.status}`}>{statusLabel[thread.status]}</span>
                <span className={`displayBadge ${visibleThreadIds.has(thread.id) ? "shown" : "hidden"}`}>
                  {visibleThreadIds.has(thread.id) ? `显示在 ${isBacklog ? "Ready" : "Done"}` : "未显示"}
                </span>
              </div>
              <h3>{thread.name}</h3>
              <PostBody body={thread.latestPost?.body ?? thread.currentVersionText} className="kanbanCardPreview" renderMedia={false} thread={thread} />
              <div className="kanbanCardMeta">
                <span title={thread.folder}>{folderLabel(thread.folder)}</span>
                <span>{thread.postCount} 条回复</span>
                <time dateTime={thread.lastActivityAt}>{formatTime(thread.lastActivityAt)}</time>
              </div>
              <div className="stageLibraryActions">
                <button className="secondaryButton" type="button" onClick={() => onOpenThread(thread.id)}>
                  <Eye size={15} />
                  打开
                </button>
                {isBacklog ? (
                  <>
                    <button
                      className="secondaryButton"
                      disabled={busyThreadId === thread.id}
                      type="button"
                      onClick={() => onEditBacklogTask(thread)}
                    >
                      <Pencil size={15} />
                      修改
                    </button>
                    <button
                      className="dangerButton"
                      disabled={busyThreadId === thread.id}
                      type="button"
                      onClick={() => onDeleteBacklogTask(thread)}
                    >
                      <Trash2 size={15} />
                      删除
                    </button>
                  </>
                ) : null}
                <button
                  className={visibleThreadIds.has(thread.id) ? "secondaryButton" : "primaryButton"}
                  disabled={busyThreadId === thread.id}
                  type="button"
                  onClick={() => onSetDisplay(thread, visibleThreadIds.has(thread.id))}
                >
                  {busyThreadId === thread.id ? <Loader2 className="spin" size={15} /> : <Plus size={15} />}
                  {visibleThreadIds.has(thread.id) ? `从 ${isBacklog ? "Ready" : "Done"} 隐藏` : `显示到 ${isBacklog ? "Ready" : "Done"}`}
                </button>
              </div>
            </article>
          ))}
        </div>

        {threads.length > libraryPreviewLimit ? (
          <div className="stageLibraryFooter">
            <span>
              共 {threads.length} 条{hiddenCount > 0 ? `，还有 ${hiddenCount} 条未显示` : ""}
            </span>
            <button className="secondaryButton" type="button" onClick={() => onShowAllChange(!showAll)}>
              {showAll ? "只看最近 10 条" : "显示全部"}
            </button>
          </div>
        ) : null}
      </section>
  );
}

function KanbanCard({
  isMoving,
  onArchiveThread,
  onOpenThread,
  presetProjectName,
  thread
}: {
  isMoving: boolean;
  onArchiveThread: (thread: ThreadListItemDto) => void;
  onOpenThread: (threadId: string) => void;
  presetProjectName?: string;
  thread: ThreadListItemDto;
}) {
  return (
    <article
      className={`kanbanCard ${thread.boardStage} ${isMoving ? "moving" : ""}`}
      draggable={!isMoving}
      onClick={() => onOpenThread(thread.id)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-harness-thread-id", thread.id);
      }}
    >
      <div className="kanbanCardTop">
        <span className="taskIdBadge" title={`任务ID ${thread.publicTaskId}`}>
          {thread.publicTaskId}
        </span>
        {presetProjectName ? (
          <span className="presetProjectBadge" title={`预设项目 ${presetProjectName}`}>
            {presetProjectName}
          </span>
        ) : null}
        <span className={`boardStageBadge ${thread.boardStage}`}>{boardStageLabel[thread.boardStage]}</span>
        <TaskRoleBadge role={thread.role} />
        <span className={`statusBadge compact ${thread.status}`}>{statusLabel[thread.status]}</span>
      </div>
      <h3>{thread.name}</h3>
      <PostBody body={thread.latestPost?.body ?? thread.currentVersionText} className="kanbanCardPreview" renderMedia={false} thread={thread} />
      <div className="kanbanCardMeta">
        <span title={thread.folder}>{folderLabel(thread.folder)}</span>
        <span>{thread.postCount} 条回复</span>
        <time dateTime={thread.lastActivityAt}>{formatTime(thread.lastActivityAt)}</time>
      </div>
      {thread.boardStage === "done" ? (
        <button
          className="iconButton cardArchiveButton"
          disabled={isMoving}
          onClick={(event) => {
            event.stopPropagation();
            onArchiveThread(thread);
          }}
          title="归档到 Archive"
          type="button"
        >
          {isMoving ? <Loader2 className="spin" size={15} /> : <Archive size={15} />}
        </button>
      ) : null}
      <button
        className="iconButton cardOpenButton"
        onClick={(event) => {
          event.stopPropagation();
          onOpenThread(thread.id);
        }}
        title="打开卡片"
        type="button"
      >
        {isMoving ? <Loader2 className="spin" size={15} /> : <Eye size={15} />}
      </button>
    </article>
  );
}

function ConfirmStageMoveDialog({
  isMoving,
  onCancel,
  onConfirm,
  thread
}: {
  isMoving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  thread: ThreadListItemDto;
}) {
  return (
    <div className="modalBackdrop" role="presentation">
      <div aria-modal="true" className="confirmDialog" role="dialog">
        <div className="dialogHeader">
          <div>
            <span className="sectionLabel">WIP</span>
            <h2>启动 Codex 执行</h2>
          </div>
          <button className="iconButton" disabled={isMoving} onClick={onCancel} title="取消" type="button">
            <X size={16} />
          </button>
        </div>
        <p>{thread.name}</p>
        <div className="dialogActions">
          <button className="secondaryButton" disabled={isMoving} onClick={onCancel} type="button">
            取消
          </button>
          <button className="primaryButton" disabled={isMoving} onClick={onConfirm} type="button">
            {isMoving ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
            确认启动
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsSavedDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="presentation">
      <div aria-labelledby="settingsSavedTitle" aria-modal="true" className="confirmDialog successDialog" role="dialog">
        <div className="successDialogMark">
          <CheckCircle2 size={22} />
        </div>
        <div>
          <h2 id="settingsSavedTitle">设置已保存</h2>
          <p>设置已经写入数据库，并会立即影响后续任务和 worker 行为。</p>
        </div>
        <div className="dialogActions">
          <button autoFocus className="primaryButton" onClick={onClose} type="button">
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}

function EditBacklogTaskDialog({
  editTaskDraft,
  editTaskRemaining,
  editTaskRole,
  editThreadName,
  isUpdating,
  onClose,
  onEditTaskDraftChange,
  onEditTaskRoleChange,
  onEditThreadNameChange,
  onSubmit,
  thread
}: {
  editTaskDraft: string;
  editTaskRemaining: number;
  editTaskRole: TaskRole;
  editThreadName: string;
  isUpdating: boolean;
  onClose: () => void;
  onEditTaskDraftChange: (value: string) => void;
  onEditTaskRoleChange: (role: TaskRole) => void;
  onEditThreadNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  thread: ThreadListItemDto;
}) {
  return (
    <div className="modalBackdrop" role="presentation">
      <form className="createThreadForm createThreadDialog" onSubmit={onSubmit}>
        <div className="dialogHeader">
          <div>
            <span className="sectionLabel">Backlog</span>
            <h2>修改任务</h2>
            <p title={thread.folder}>{thread.folder}</p>
          </div>
          <button className="iconButton" disabled={isUpdating} onClick={onClose} title="关闭" type="button">
            <X size={16} />
          </button>
        </div>

        <label className="fieldBlock">
          <span>线程名称</span>
          <input
            maxLength={THREAD_NAME_LIMIT}
            onChange={(event) => onEditThreadNameChange(event.target.value)}
            placeholder="例如：Harness 执行链路改造"
            value={editThreadName}
          />
        </label>

        <TaskRoleSelect label="Role" onChange={onEditTaskRoleChange} value={editTaskRole} />

        <label className="fieldBlock">
          <span>任务内容</span>
          <textarea
            aria-label="修改任务内容"
            maxLength={USER_POST_LIMIT + 20}
            onChange={(event) => onEditTaskDraftChange(event.target.value)}
            placeholder="用 500 字以内描述这条线程要完成的任务..."
            value={editTaskDraft}
          />
        </label>

        <div className="formFooter">
          <span className={editTaskRemaining < 0 ? "overLimit" : ""}>{editTaskRemaining} 字剩余</span>
          <div className="dialogActions">
            <button className="secondaryButton" disabled={isUpdating} onClick={onClose} type="button">
              取消
            </button>
            <button
              className="primaryButton"
              disabled={!editThreadName.trim() || !editTaskDraft.trim() || editTaskRemaining < 0 || isUpdating}
              type="submit"
            >
              {isUpdating ? <Loader2 className="spin" size={16} /> : <Pencil size={16} />}
              保存修改
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ConfirmDeleteBacklogTaskDialog({
  isDeleting,
  onCancel,
  onConfirm,
  thread
}: {
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  thread: ThreadListItemDto;
}) {
  return (
    <div className="modalBackdrop" role="presentation">
      <div aria-modal="true" className="confirmDialog destructiveDialog" role="dialog">
        <div className="dialogHeader">
          <div>
            <span className="sectionLabel dangerLabel">Backlog</span>
            <h2>删除任务</h2>
          </div>
          <button className="iconButton" disabled={isDeleting} onClick={onCancel} title="关闭" type="button">
            <X size={16} />
          </button>
        </div>
        <p>
          将删除「{thread.name}」整张卡片及其回复、任务版本和 run 记录。这个操作不能撤销。
        </p>
        <div className="dialogActions">
          <button className="secondaryButton" disabled={isDeleting} onClick={onCancel} type="button">
            取消
          </button>
          <button className="dangerButton" disabled={isDeleting} onClick={onConfirm} type="button">
            {isDeleting ? <Loader2 className="spin" size={16} /> : <Trash2 size={16} />}
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}

function DirectoryChooser({
  directory,
  isLoading,
  label = "线程文件夹",
  onDirectoryChange
}: {
  directory?: LocalDirectoryDto;
  isLoading: boolean;
  label?: string;
  onDirectoryChange: (path?: string) => void;
}) {
  return (
    <div className="directoryChooser">
      <div className="directoryHeader">
        <div>
          <span>{label}</span>
          <strong>{directory?.path ?? "载入本地目录..."}</strong>
        </div>
        <div className="directoryActions">
          <button
            className="iconButton"
            disabled={!directory?.parentPath || isLoading}
            onClick={() => onDirectoryChange(directory?.parentPath)}
            title="上一级"
            type="button"
          >
            <ChevronLeft size={16} />
          </button>
          <button className="iconButton" disabled={isLoading} onClick={() => onDirectoryChange(directory?.path)} title="刷新目录" type="button">
            {isLoading ? <Loader2 className="spin" size={16} /> : <RefreshCw size={16} />}
          </button>
        </div>
      </div>

      <div className="directoryList">
        {directory?.entries.length === 0 ? <p className="emptyText">当前目录下没有子目录。</p> : null}
        {directory?.entries.map((entry) => (
          <button className="directoryItem" key={entry.path} onClick={() => onDirectoryChange(entry.path)} type="button">
            <FolderOpen size={15} />
            <span>{entry.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ThreadWorkspace({
  detail,
  heartbeat,
  isPostingTask,
  nowMs,
  onBackToBoard,
  onReply,
  onReplyDraftChange,
  replyDraft,
  replyRemaining,
  run
}: {
  detail: ThreadDetailDto;
  heartbeat?: TaskHeartbeatDto;
  isPostingTask: boolean;
  nowMs: number;
  onBackToBoard: () => void;
  onReply: (event: FormEvent<HTMLFormElement>) => void;
  onReplyDraftChange: (value: string) => void;
  replyDraft: string;
  replyRemaining: number;
  run?: RunDto;
}) {
  const latestVersion = detail.versions[0];
  const timelinePosts = detail.posts.filter((post) => post.postType === "reply");

  return (
    <div className="threadWorkspace">
      <section className="threadPanel">
        <div className="threadHeader">
          <div>
            <button className="backButton" onClick={onBackToBoard} type="button">
              <ArrowLeft size={15} />
              看板
            </button>
            <span className={`boardStageBadge ${detail.thread.boardStage}`}>{boardStageLabel[detail.thread.boardStage]}</span>
            <TaskRoleBadge role={detail.thread.role} />
            <span className={`statusBadge ${detail.thread.status}`}>{statusLabel[detail.thread.status]}</span>
            <span className="taskIdBadge detailTaskId" title={`任务ID ${detail.thread.publicTaskId}`}>
              任务ID {detail.thread.publicTaskId}
            </span>
            <div className="threadCrumb" title={detail.thread.folder}>
              <Folder size={14} />
              <span>{detail.thread.folder}</span>
            </div>
            <h2>{detail.thread.name}</h2>
          </div>
          <RunPill heartbeat={heartbeat} run={run} />
        </div>

        <div className="versionBand">
          <span>当前版本</span>
          <p>{latestVersion?.summaryText ?? detail.thread.currentVersionText}</p>
        </div>

        {timelinePosts.length === 0 ? (
          <div className="emptyTimeline">
            <Activity size={22} />
            <p>这个线程还没有回复。后续 Codex 的 ACK、必要进展和结果会出现在这里。</p>
          </div>
        ) : (
          <Timeline heartbeat={heartbeat} nowMs={nowMs} posts={timelinePosts} run={run} thread={detail.thread} />
        )}

        <ReplyComposer
          isPostingTask={isPostingTask}
          onReply={onReply}
          onReplyDraftChange={onReplyDraftChange}
          replyDraft={replyDraft}
          replyRemaining={replyRemaining}
        />
      </section>

    </div>
  );
}

function ReplyComposer({
  isPostingTask,
  onReply,
  onReplyDraftChange,
  replyDraft,
  replyRemaining
}: {
  isPostingTask: boolean;
  onReply: (event: FormEvent<HTMLFormElement>) => void;
  onReplyDraftChange: (value: string) => void;
  replyDraft: string;
  replyRemaining: number;
}) {
  return (
    <form className="taskComposer replyComposer" onSubmit={onReply}>
      <textarea
        aria-label="回复当前线程"
        maxLength={USER_POST_LIMIT + 20}
        onChange={(event) => onReplyDraftChange(event.target.value)}
        placeholder="回复当前线程：评价结果、补充约束，或要求继续下一步..."
        value={replyDraft}
      />
      <div className="composerFooter">
        <span className={replyRemaining < 0 ? "overLimit" : ""}>{replyRemaining} 字剩余</span>
        <button className="primaryButton" disabled={!replyDraft.trim() || replyRemaining < 0 || isPostingTask} type="submit">
          {isPostingTask ? <Loader2 className="spin" size={16} /> : <Send size={16} />}
          回复
        </button>
      </div>
    </form>
  );
}

function AccountStatusPanel({
  authState,
  health,
  isLoggingIn,
  onLogout,
  ready
}: {
  authState: AuthStateDto;
  health?: HealthDto;
  isLoggingIn: boolean;
  onLogout: () => void;
  ready: boolean;
}) {
  return (
    <section className="accountStatusPanel" aria-label="登录状态">
      <div className="accountStatusMain">
        <div className="accountAvatar">
          <UserRound size={14} />
        </div>
        <div className="accountCopy">
          <strong>{authState.enabled ? (authState.user?.name ?? "已登录") : "本地模式"}</strong>
          <span>{authState.enabled ? "已登录" : "未启用登录"}</span>
        </div>
        {authState.enabled ? (
          <button className="iconButton accountLogoutButton" type="button" onClick={onLogout} title="退出登录">
            {isLoggingIn ? <Loader2 className="spin" size={16} /> : <LogOut size={16} />}
          </button>
        ) : null}
      </div>
      <ServerStatusInline health={health} ready={ready} />
    </section>
  );
}

function SidebarWorkspaceNav({
  activeLibraryStage,
  archiveCount,
  automation,
  backlogCount,
  isBoardActive,
  isCreateActive,
  isImportActive,
  isSettingsActive,
  isUpdatingAutomation,
  onAutomationCheck,
  onAutomationToggle,
  onCreateTask,
  onImportTasks,
  onOpenBoard,
  onOpenSettings,
  onOpenLibrary,
  onRefresh,
  stageCounts
}: {
  activeLibraryStage?: LibraryStage;
  archiveCount: number;
  automation?: BoardAutomationDto;
  backlogCount: number;
  isBoardActive: boolean;
  isCreateActive: boolean;
  isImportActive: boolean;
  isSettingsActive: boolean;
  isUpdatingAutomation: boolean;
  onAutomationCheck: () => void;
  onAutomationToggle: (enabled: boolean) => void;
  onCreateTask: () => void;
  onImportTasks: () => void;
  onOpenBoard: () => void;
  onOpenSettings: () => void;
  onOpenLibrary: (boardStage: LibraryStage) => void;
  onRefresh: () => void;
  stageCounts: Record<KanbanStage, number>;
}) {
  return (
    <nav className="workspaceNav" aria-label="工作台导航">
      <div className="workspaceNavHeader">
        <span>工作区</span>
        <div className="workspaceNavHeaderActions">
          <button
            className={`iconButton compactIconButton ${isSettingsActive ? "active" : ""}`}
            type="button"
            onClick={onOpenSettings}
            title="设置"
          >
            <Settings2 size={15} />
          </button>
          <button className="iconButton compactIconButton" type="button" onClick={onRefresh} title="刷新工作区">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <button className={`workspaceNavButton createAction ${isCreateActive ? "active" : ""}`} type="button" onClick={onCreateTask}>
        <span>
          <Plus size={15} />
          发布
        </span>
      </button>

      <button className={`workspaceNavButton ${isImportActive ? "active" : ""}`} type="button" onClick={onImportTasks}>
        <span>
          <Upload size={15} />
          批量导入
        </span>
      </button>

      <button className={`workspaceNavButton ${isBoardActive ? "active" : ""}`} type="button" onClick={onOpenBoard}>
        <span>
          <Columns3 size={15} />
          看板
        </span>
        <strong>{stageCounts.ready + stageCounts.wip + stageCounts.review + stageCounts.done}</strong>
      </button>

      <button className={`workspaceNavButton ${activeLibraryStage === "backlog" ? "active" : ""}`} type="button" onClick={() => onOpenLibrary("backlog")}>
        <span>
          <Inbox size={15} />
          Backlog
        </span>
        <strong>{backlogCount}</strong>
      </button>

      <button className={`workspaceNavButton ${activeLibraryStage === "archive" ? "active" : ""}`} type="button" onClick={() => onOpenLibrary("archive")}>
        <span>
          <Archive size={15} />
          Archive
        </span>
        <strong>{archiveCount}</strong>
      </button>

      <div className={`workspaceAutomationPanel ${automation?.enabled ? "enabled" : ""}`}>
        <div className="workspaceAutomationCopy">
          <span>自动模式</span>
          <strong>{automation?.enabled ? "已开启" : "已关闭"}</strong>
        </div>
        <button
          aria-checked={Boolean(automation?.enabled)}
          className="automationSwitch"
          disabled={isUpdatingAutomation || !automation}
          onClick={() => onAutomationToggle(!automation?.enabled)}
          role="switch"
          title="切换自动模式"
          type="button"
        >
          {isUpdatingAutomation ? <Loader2 className="spin" size={14} /> : <Power size={14} />}
        </button>
        <button
          className="iconButton compactIconButton"
          disabled={isUpdatingAutomation || !automation?.enabled}
          onClick={onAutomationCheck}
          title="立即检查 Ready 栏"
          type="button"
        >
          <RefreshCw size={14} />
        </button>
        <p>{automation ? automationStatusLabel(automation) : "正在读取状态"}</p>
      </div>

      <div className="workspaceStageSummary" aria-label="任务阶段数量">
        {boardColumns.map((stage) => (
          <div key={stage}>
            <span>{boardStageLabel[stage]}</span>
            <strong>{stageCounts[stage]}</strong>
          </div>
        ))}
      </div>
    </nav>
  );
}

function ServerStatusInline({
  health,
  ready
}: {
  health?: HealthDto;
  ready: boolean;
}) {
  return (
    <div className="serverStatusInline" title="当前服务器状态">
      <span className={`serverStatusItem ${health?.mongo.ok ? "ok" : "pending"}`}>
        {health?.mongo.ok ? <CheckCircle2 size={12} /> : <Clock3 size={12} />}
        <span>Mongo</span>
      </span>
      <span className={`serverStatusItem ${ready ? "ok" : "pending"}`}>
        {ready ? <CheckCircle2 size={12} /> : <Clock3 size={12} />}
        <span>Codex</span>
      </span>
    </div>
  );
}

function RunPill({ heartbeat, run }: { heartbeat?: TaskHeartbeatDto; run?: RunDto }) {
  const label = heartbeat?.label ?? (run ? runStatusLabel(run) : undefined);
  const className = heartbeat?.state ?? run?.status;
  if (!label || !className) {
    return null;
  }

  return (
    <div className={`runPill ${className}`}>
      <Activity size={15} />
      <span>{label}</span>
    </div>
  );
}

function Timeline({
  heartbeat,
  nowMs,
  posts,
  run,
  thread
}: {
  heartbeat?: TaskHeartbeatDto;
  nowMs: number;
  posts: PostDto[];
  run?: RunDto;
  thread: ThreadDetailDto["thread"];
}) {
  return (
    <div className="timeline">
      {posts.map((post) => {
        const isCurrentAgentRunPost = post.authorType === "agent" && post.runId !== undefined && post.runId === run?.id;
        return (
          <article className={`post ${post.authorType}`} key={post.id}>
            <div className="avatar">{post.authorType === "user" ? <UserRound size={16} /> : <Bot size={16} />}</div>
            <div className="postBody">
              <div className="postMeta">
                <strong>{post.authorType === "user" ? "你" : "Codex"}</strong>
                {post.replyType ? <span>{replyLabel[post.replyType]}</span> : null}
                {post.status ? <span className={`postStatus ${post.status}`}>{postStatusLabel(post.status)}</span> : null}
                <time dateTime={post.createdAt}>{formatTime(post.createdAt)}</time>
              </div>
              <PostBody body={post.body} thread={thread} />
              <PostRunStatus
                heartbeat={isCurrentAgentRunPost ? heartbeat : undefined}
                nowMs={nowMs}
                run={isCurrentAgentRunPost ? run : undefined}
              />
            </div>
          </article>
        );
      })}
    </div>
  );
}

type LinkableThread = Pick<ThreadDetailDto["thread"], "folder" | "id">;

function PostBody({
  body,
  className = "postContent",
  renderMedia = true,
  thread
}: {
  body: string;
  className?: string;
  renderMedia?: boolean;
  thread: LinkableThread;
}) {
  return <div className={className}>{renderPostBody(body, thread, renderMedia)}</div>;
}

function renderPostBody(body: string, thread: LinkableThread, renderMedia: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let codeIndex = 0;
  const codePattern = /`[^`]*`/g;
  for (const match of body.matchAll(codePattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > cursor) {
      nodes.push(...renderLinkedText(body.slice(cursor, match.index), thread, `text-${cursor}`, renderMedia));
    }
    nodes.push(renderInlineCode(match[0].slice(1, -1), thread, `code-${codeIndex}`, renderMedia));
    cursor = match.index + match[0].length;
    codeIndex += 1;
  }
  if (cursor < body.length) {
    nodes.push(...renderLinkedText(body.slice(cursor), thread, `text-${cursor}`, renderMedia));
  }
  return nodes;
}

function renderLinkedText(text: string, thread: LinkableThread, keyPrefix: string, renderMedia: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let linkIndex = 0;
  const markdownLinkPattern = /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of text.matchAll(markdownLinkPattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > cursor) {
      nodes.push(...renderPlainLinkedText(text.slice(cursor, match.index), thread, `${keyPrefix}-plain-${linkIndex}`, renderMedia));
    }
    if (match[2] !== undefined) {
      nodes.push(renderPostImage(match[1], match[2], thread, `${keyPrefix}-img-${linkIndex}`, renderMedia));
    } else {
      nodes.push(renderPostLink(match[3], match[4], thread, `${keyPrefix}-md-${linkIndex}`));
    }
    cursor = match.index + match[0].length;
    linkIndex += 1;
  }

  if (cursor < text.length) {
    nodes.push(...renderPlainLinkedText(text.slice(cursor), thread, `${keyPrefix}-plain-end`, renderMedia));
  }
  return nodes;
}

function renderPlainLinkedText(text: string, thread: LinkableThread, keyPrefix: string, renderMedia: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  const linkPattern =
    /(https?:\/\/[^\s<>()]+|file:\/\/\/[^\s<>()]+|(?:(?:\/|\.{1,2}\/|[A-Za-z0-9._-]+\/)[^\s<>()]+?\.(?:html?|css|js|json|md|txt|png|jpe?g|gif|svg|webp|pdf)(?::\d+(?::\d+)?)?))/gi;
  let cursor = 0;
  let linkIndex = 0;

  for (const match of text.matchAll(linkPattern)) {
    if (match.index === undefined) {
      continue;
    }
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const { token, trailing } = splitTrailingPunctuation(match[0]);
    nodes.push(renderPostImage(token, token, thread, `${keyPrefix}-${linkIndex}`, renderMedia));
    if (trailing) {
      nodes.push(trailing);
    }
    cursor = match.index + match[0].length;
    linkIndex += 1;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }
  return nodes;
}

function renderInlineCode(codeText: string, thread: LinkableThread, key: string, renderMedia: boolean): ReactNode {
  const inlineImage = renderMedia ? resolvePostImage(codeText.trim(), thread) : undefined;
  if (inlineImage) {
    return renderResolvedPostImage(codeText, inlineImage, key);
  }

  const localPath = localPathFromHref(codeText.trim());
  const apiHref = localPath ? localPathToApiHref(localPath, thread) : undefined;
  const codeNode = <code className="inlineCode">{codeText}</code>;
  if (!apiHref) {
    return <span key={key}>{codeNode}</span>;
  }
  return (
    <a className="inlineCodeLink" href={apiHref} key={key} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" title={localPath}>
      {codeNode}
    </a>
  );
}

function renderPostImage(altText: string, rawHref: string, thread: LinkableThread, key: string, renderMedia: boolean): ReactNode {
  const image = renderMedia ? resolvePostImage(rawHref, thread) : undefined;
  if (!image) {
    return renderPostLink(altText || rawHref, rawHref, thread, key);
  }

  return renderResolvedPostImage(altText, image, key);
}

function renderResolvedPostImage(altText: string, image: { label: string; src: string; title: string }, key: string): ReactNode {
  const caption = altText.trim() || image.label;
  return (
    <span className="postImageFrame" key={key}>
      <a href={image.src} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" title={image.title}>
        <img alt={caption} loading="lazy" src={image.src} />
      </a>
      <span className="postImageCaption">{caption}</span>
    </span>
  );
}

function renderPostLink(label: ReactNode, rawHref: string, thread: LinkableThread, key: string): ReactNode {
  const resolved = resolvePostHref(rawHref, thread);
  return (
    <a href={resolved.href} key={key} onClick={(event) => event.stopPropagation()} rel="noreferrer" target="_blank" title={resolved.title}>
      {label}
    </a>
  );
}

function resolvePostHref(rawHref: string, thread: LinkableThread): { href: string; title: string } {
  const href = rawHref.trim();
  if (/^https?:\/\//i.test(href)) {
    return { href, title: href };
  }

  const localPath = localPathFromHref(href);
  if (!localPath) {
    return { href, title: href };
  }

  const apiHref = localPathToApiHref(localPath, thread);
  return {
    href: apiHref ?? href,
    title: localPath
  };
}

function resolvePostImage(rawHref: string, thread: LinkableThread): { label: string; src: string; title: string } | undefined {
  const localPath = localPathFromHref(rawHref.trim());
  if (!localPath || !isImagePath(localPath)) {
    return undefined;
  }
  const src = localPathToApiHref(localPath, thread);
  if (!src) {
    return undefined;
  }
  return {
    label: imageLabelFromPath(localPath),
    src,
    title: localPath
  };
}

function localPathFromHref(href: string): string | undefined {
  if (/^file:\/\//i.test(href)) {
    try {
      return stripLineSuffix(decodeURIComponent(new URL(href).pathname));
    } catch {
      return undefined;
    }
  }
  if (href.startsWith("/") || looksLikeRelativeFilePath(href)) {
    try {
      return stripLineSuffix(decodeURIComponent(href));
    } catch {
      return stripLineSuffix(href);
    }
  }
  return undefined;
}

function isImagePath(value: string): boolean {
  return /\.(?:png|jpe?g|gif|svg|webp)$/i.test(stripLineSuffix(value).split(/[?#]/)[0] ?? value);
}

function imageLabelFromPath(value: string): string {
  const cleanPath = stripLineSuffix(value).split(/[?#]/)[0] ?? value;
  return cleanPath.split("/").filter(Boolean).pop() ?? "本地图片";
}

function localPathToApiHref(localPath: string, thread: LinkableThread): string | undefined {
  const rootPath = normalizePosixPath(thread.folder);
  const normalizedPath = normalizePosixPath(localPath);
  const relativePath = normalizedPath.startsWith("/")
    ? relativePathInside(rootPath, normalizedPath)
    : normalizePosixPath(normalizedPath.replace(/^\.\//, ""));
  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    return undefined;
  }
  return `/api/local-files/${encodeURIComponent(thread.id)}/${relativePath
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function relativePathInside(rootPath: string, targetPath: string): string | undefined {
  if (targetPath === rootPath) {
    return undefined;
  }
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return targetPath.startsWith(prefix) ? targetPath.slice(prefix.length) : undefined;
}

function looksLikeRelativeFilePath(value: string): boolean {
  return /^(?:\.{1,2}\/|[A-Za-z0-9._-]+\/)/.test(value) && /\.(?:html?|css|js|json|md|txt|png|jpe?g|gif|svg|webp|pdf)(?::\d+(?::\d+)?)?$/i.test(value);
}

function stripLineSuffix(value: string): string {
  return value.replace(/:(\d+)(?::\d+)?$/, "");
}

function normalizePosixPath(value: string): string {
  const isAbsolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0) {
        parts.pop();
      } else if (!isAbsolute) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }
  return `${isAbsolute ? "/" : ""}${parts.join("/")}`;
}

function splitTrailingPunctuation(value: string): { token: string; trailing: string } {
  const match = value.match(/^(.+?)([.,，。；;！？!?)）]+)$/);
  if (!match) {
    return { token: value, trailing: "" };
  }
  return { token: match[1], trailing: match[2] };
}

function PostRunStatus({ heartbeat, nowMs, run }: { heartbeat?: TaskHeartbeatDto; nowMs: number; run?: RunDto }) {
  if (!heartbeat && !run) {
    return null;
  }

  const state = heartbeat?.state ?? run?.status ?? "unknown";
  const title = heartbeat?.label ?? (run ? runStatusLabel(run) : "状态未知");
  const phase = heartbeat?.runPhase ?? run?.phase;
  const message = heartbeat?.message ?? (run ? runStatusMessage(run) : "等待任务心跳。");
  const lastEventAt = heartbeat?.lastEventAt ?? run?.lastEventAt;
  const lastHeartbeatAt = heartbeat?.lastHeartbeatAt ?? run?.lastHeartbeatAt;
  const durationLabel = runDurationLabel(heartbeat, run, nowMs);
  const StatusIcon = heartbeat?.isTerminal || run?.status === "completed" ? CheckCircle2 : Activity;

  return (
    <div className={`postRunStatus ${state}`}>
      <StatusIcon size={15} />
      <div className="postRunStatusMain">
        <strong>{title}</strong>
        {phase ? <span>当前阶段：{phase}</span> : null}
        <span>{message}</span>
      </div>
      <div className="postRunStatusMeta">
        {durationLabel ? <span>{durationLabel}</span> : null}
        {lastEventAt ? <span>最近事件 {formatTime(lastEventAt)}</span> : null}
        {lastHeartbeatAt ? <span>心跳 {formatTime(lastHeartbeatAt)}</span> : null}
      </div>
    </div>
  );
}

function appendUniquePost(posts: PostDto[], post: PostDto): PostDto[] {
  if (posts.some((item) => item.id === post.id)) {
    return posts;
  }
  return [...posts, post];
}

function getDisplayedBoardThreads(threads: ThreadListItemDto[]): ThreadListItemDto[] {
  const readyThreads = selectDisplayedLibraryThreads(threads.filter((thread) => thread.boardStage === "ready"));
  const doneThreads = selectDisplayedLibraryThreads(threads.filter((thread) => thread.boardStage === "done"));
  const readyIds = new Set(readyThreads.map((thread) => thread.id));
  const doneIds = new Set(doneThreads.map((thread) => thread.id));

  return threads.filter((thread) => {
    if (thread.boardStage === "ready") {
      return readyIds.has(thread.id);
    }
    if (thread.boardStage === "done") {
      return doneIds.has(thread.id);
    }
    return isKanbanStage(thread.boardStage);
  });
}

function selectDisplayedLibraryThreads(threads: ThreadListItemDto[]): ThreadListItemDto[] {
  const selected = new Set<string>();
  for (const thread of threads) {
    if (thread.boardDisplay === "shown") {
      selected.add(thread.id);
    }
  }

  let autoCount = 0;
  for (const thread of threads) {
    if (thread.boardDisplay === "hidden" || selected.has(thread.id)) {
      continue;
    }
    selected.add(thread.id);
    autoCount += 1;
    if (autoCount >= boardAutoDisplayLimit) {
      break;
    }
  }

  return threads.filter((thread) => selected.has(thread.id));
}

function groupThreadsByBoardStage(threads: ThreadListItemDto[]): Record<KanbanStage, ThreadListItemDto[]> {
  const groups: Record<KanbanStage, ThreadListItemDto[]> = {
    ready: [],
    wip: [],
    review: [],
    done: []
  };
  for (const thread of threads) {
    if (isKanbanStage(thread.boardStage)) {
      groups[thread.boardStage].push(thread);
    }
  }
  return groups;
}

function countThreadsByBoardStage(threads: ThreadListItemDto[]): Record<KanbanStage, number> {
  const counts: Record<KanbanStage, number> = {
    ready: 0,
    wip: 0,
    review: 0,
    done: 0
  };
  for (const thread of threads) {
    if (isKanbanStage(thread.boardStage)) {
      counts[thread.boardStage] += 1;
    }
  }
  return counts;
}

function isKanbanStage(boardStage: BoardStage): boardStage is KanbanStage {
  return boardColumnSet.has(boardStage);
}

function automationStatusLabel(automation: BoardAutomationDto): string {
  if (!automation.enabled) {
    return `Ready ${automation.readyColumnCount} · WIP ${automation.wipCount}/${automation.wipLimit}`;
  }
  if (automation.lastCheckedAt) {
    return `上次 ${formatTime(automation.lastCheckedAt)} · Ready ${automation.readyColumnCount}`;
  }
  return `每 ${formatDurationCompact(automation.intervalMs)} · WIP ${automation.wipCount}/${automation.wipLimit}`;
}

function folderLabel(folder: string): string {
  const parts = folder.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? folder;
}

function formatError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isTerminalRunStatus(status: RunDto["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function runStatusLabel(run: RunDto): string {
  if (run.status === "completed") {
    return "完成";
  }
  if (run.status === "failed") {
    return "失败";
  }
  if (run.status === "cancelled") {
    return "已取消";
  }
  if (run.status === "queued") {
    return "排队中";
  }
  return "工作中";
}

function runStatusMessage(run: RunDto): string {
  if (run.status === "completed") {
    return "任务已经完成。";
  }
  if (run.status === "failed") {
    return "任务已经失败。";
  }
  if (run.status === "cancelled") {
    return "任务已经取消。";
  }
  if (run.status === "queued") {
    return "任务已创建，等待 worker 启动。";
  }
  return "任务仍在进行。";
}

function runDurationLabel(heartbeat: TaskHeartbeatDto | undefined, run: RunDto | undefined, nowMs: number): string | undefined {
  const startedAt = parseTime(heartbeat?.startedAt ?? run?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }

  const terminal = heartbeat?.isTerminal ?? (run ? isTerminalRunStatus(run.status) : false);
  const endedAt = parseTime(heartbeat?.endedAt ?? run?.endedAt);
  const endMs = terminal && endedAt !== undefined ? endedAt : nowMs;
  const durationMs = Math.max(0, endMs - startedAt);
  return `${terminal ? "耗时" : "已运行"} ${formatDuration(durationMs)}`;
}

function postStatusLabel(status: NonNullable<PostDto["status"]>): string {
  const labels: Record<NonNullable<PostDto["status"]>, string> = {
    submitted: "已提交",
    queued: "排队中",
    accepted: "已接单",
    working: "工作中",
    long_running: "长时间运行",
    waiting_for_input: "待澄清",
    completed: "完成",
    failed: "失败",
    cancelled: "已取消"
  };
  return labels[status];
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function formatDuration(valueMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(valueMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分 ${seconds} 秒`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  return `${seconds} 秒`;
}

function formatDurationCompact(valueMs: number): string {
  const minutes = Math.max(1, Math.round(valueMs / 60000));
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours} 小时 ${restMinutes} 分钟` : `${hours} 小时`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}
