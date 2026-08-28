import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AppConfig {
  host: string;
  port: number;
  corsOrigins: string[];
  mongoUri: string;
  mongoDb: string;
  codexBin: string;
  codexWorkspace: string;
  codexSandbox: "read-only" | "workspace-write" | "danger-full-access";
  codexApproval: "untrusted" | "on-request" | "never";
  codexModel?: string;
  codexReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  codexTurnTimeoutMs?: number;
  codexWorkerConcurrency: number;
  localFileMaxBytes: number;
  localDir: string;
  auth: AuthConfig;
  serviceAuth: ServiceAuthConfig;
}

export interface AuthConfig {
  enabled: boolean;
  username: string;
  password?: string;
  passwordHash?: string;
  sessionSecret?: string;
  sessionTtlMs: number;
  cookieName: string;
  cookieSecure: boolean;
  loginMaxAttempts: number;
  loginWindowMs: number;
}

export interface ServiceAuthConfig {
  bootstrapToken?: string;
  bootstrapName: string;
}

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function readEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return value && allowed.includes(value as T) ? (value as T) : fallback;
}

function readOptionalEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && allowed.includes(value as T) ? (value as T) : undefined;
}

function readOptionalPositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readCappedPositiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = readOptionalPositiveInt(value);
  return parsed ? Math.min(parsed, max) : fallback;
}

function readOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function readCommaSeparatedList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? [...new Set(entries)] : fallback;
}

function isPublicBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return !["127.0.0.1", "localhost", "::1", "[::1]"].includes(normalized) && !normalized.startsWith("127.");
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const authPassword = process.env.HARNESS_AUTH_PASSWORD;
  const authPasswordHash = process.env.HARNESS_AUTH_PASSWORD_HASH;
  const authEnabled = readOptionalBoolean(process.env.HARNESS_AUTH_ENABLED) ?? Boolean(authPassword || authPasswordHash);

  const config: AppConfig = {
    host: process.env.SERVER_HOST ?? "127.0.0.1",
    port: readPort(process.env.SERVER_PORT, 4317),
    corsOrigins: readCommaSeparatedList(process.env.HARNESS_CORS_ORIGINS, [
      "http://127.0.0.1:5173",
      "http://localhost:5173"
    ]),
    mongoUri: process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/harness?replicaSet=rs0",
    mongoDb: process.env.MONGO_DB ?? "harness",
    codexBin: process.env.CODEX_BIN ?? "codex",
    codexWorkspace: process.env.CODEX_WORKSPACE ?? projectRoot,
    codexSandbox: readEnum(
      process.env.CODEX_SANDBOX,
      ["read-only", "workspace-write", "danger-full-access"] as const,
      "workspace-write"
    ),
    codexApproval: readEnum(process.env.CODEX_APPROVAL, ["untrusted", "on-request", "never"] as const, "never"),
    codexModel: process.env.CODEX_MODEL,
    codexReasoningEffort: readOptionalEnum(
      process.env.CODEX_REASONING_EFFORT,
      ["none", "minimal", "low", "medium", "high", "xhigh"] as const
    ),
    codexTurnTimeoutMs: readOptionalPositiveInt(process.env.CODEX_TURN_TIMEOUT_MS),
    codexWorkerConcurrency: readCappedPositiveInt(process.env.CODEX_WORKER_CONCURRENCY, 5, 5),
    localFileMaxBytes: readCappedPositiveInt(
      process.env.HARNESS_LOCAL_FILE_MAX_BYTES,
      25 * 1024 * 1024,
      100 * 1024 * 1024
    ),
    localDir: process.env.HARNESS_LOCAL_DIR ?? path.join(projectRoot, ".local"),
    auth: {
      enabled: authEnabled,
      username: process.env.HARNESS_AUTH_USERNAME ?? "admin",
      password: authPassword,
      passwordHash: authPasswordHash,
      sessionSecret: process.env.HARNESS_SESSION_SECRET,
      sessionTtlMs: readOptionalPositiveInt(process.env.HARNESS_SESSION_TTL_MS) ?? 7 * 24 * 60 * 60 * 1000,
      cookieName: process.env.HARNESS_AUTH_COOKIE_NAME ?? "harness_session",
      cookieSecure: readOptionalBoolean(process.env.HARNESS_COOKIE_SECURE) ?? false,
      loginMaxAttempts: readOptionalPositiveInt(process.env.HARNESS_LOGIN_MAX_ATTEMPTS) ?? 8,
      loginWindowMs: readOptionalPositiveInt(process.env.HARNESS_LOGIN_WINDOW_MS) ?? 5 * 60 * 1000
    },
    serviceAuth: {
      bootstrapToken: process.env.HARNESS_API_TOKEN,
      bootstrapName: process.env.HARNESS_API_TOKEN_NAME?.trim() || "codex-cli"
    }
  };

  const merged = { ...config, ...overrides };
  if (isPublicBindHost(merged.host) && !merged.auth.enabled) {
    throw new Error("Public SERVER_HOST requires HARNESS_AUTH_PASSWORD or HARNESS_AUTH_PASSWORD_HASH.");
  }
  if (isPublicBindHost(merged.host) && !merged.auth.sessionSecret) {
    throw new Error("Public SERVER_HOST requires an independent HARNESS_SESSION_SECRET.");
  }
  return merged;
}
