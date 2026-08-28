import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not enable a Codex turn wall-clock timeout by default", () => {
    clearAuthEnv();
    vi.stubEnv("CODEX_TURN_TIMEOUT_MS", undefined);

    expect(loadConfig().codexTurnTimeoutMs).toBeUndefined();
  });

  it("discovers Codex from PATH by default", () => {
    clearAuthEnv();
    vi.stubEnv("CODEX_BIN", undefined);

    expect(loadConfig().codexBin).toBe("codex");
  });

  it("treats CODEX_TURN_TIMEOUT_MS=0 as disabled", () => {
    clearAuthEnv();
    vi.stubEnv("CODEX_TURN_TIMEOUT_MS", "0");

    expect(loadConfig().codexTurnTimeoutMs).toBeUndefined();
  });

  it("allows an explicit positive Codex turn timeout for local debugging", () => {
    clearAuthEnv();
    vi.stubEnv("CODEX_TURN_TIMEOUT_MS", "120000");

    expect(loadConfig().codexTurnTimeoutMs).toBe(120000);
  });

  it("defaults Codex worker concurrency to the WIP cap", () => {
    clearAuthEnv();
    vi.stubEnv("CODEX_WORKER_CONCURRENCY", undefined);

    expect(loadConfig().codexWorkerConcurrency).toBe(5);
  });

  it("uses a local CORS allowlist and bounded file responses by default", () => {
    clearAuthEnv();
    vi.stubEnv("HARNESS_CORS_ORIGINS", undefined);
    vi.stubEnv("HARNESS_LOCAL_FILE_MAX_BYTES", undefined);

    const config = loadConfig();
    expect(config.corsOrigins).toEqual(["http://127.0.0.1:5173", "http://localhost:5173"]);
    expect(config.localFileMaxBytes).toBe(25 * 1024 * 1024);
  });

  it("accepts explicit CORS origins and caps local file responses", () => {
    clearAuthEnv();
    vi.stubEnv("HARNESS_CORS_ORIGINS", "https://harness.example, https://admin.example");
    vi.stubEnv("HARNESS_LOCAL_FILE_MAX_BYTES", String(200 * 1024 * 1024));

    const config = loadConfig();
    expect(config.corsOrigins).toEqual(["https://harness.example", "https://admin.example"]);
    expect(config.localFileMaxBytes).toBe(100 * 1024 * 1024);
  });

  it("allows lower Codex worker concurrency but caps it at five", () => {
    clearAuthEnv();
    vi.stubEnv("CODEX_WORKER_CONCURRENCY", "2");
    expect(loadConfig().codexWorkerConcurrency).toBe(2);

    vi.stubEnv("CODEX_WORKER_CONCURRENCY", "12");
    expect(loadConfig().codexWorkerConcurrency).toBe(5);
  });

  it("enables auth automatically when a password is configured", () => {
    vi.stubEnv("HARNESS_AUTH_ENABLED", undefined);
    vi.stubEnv("HARNESS_AUTH_PASSWORD", "secret");
    vi.stubEnv("HARNESS_AUTH_PASSWORD_HASH", undefined);

    expect(loadConfig().auth.enabled).toBe(true);
  });

  it("keeps auth disabled by default for loopback-only local development", () => {
    clearAuthEnv();

    expect(loadConfig().auth.enabled).toBe(false);
  });

  it("rejects public binding without auth", () => {
    vi.stubEnv("SERVER_HOST", "0.0.0.0");
    clearAuthEnv();

    expect(() => loadConfig()).toThrow(/Public SERVER_HOST/);
  });

  it("rejects public binding without an independent session secret", () => {
    vi.stubEnv("SERVER_HOST", "0.0.0.0");
    vi.stubEnv("HARNESS_AUTH_PASSWORD", "secret");
    vi.stubEnv("HARNESS_AUTH_PASSWORD_HASH", undefined);
    vi.stubEnv("HARNESS_SESSION_SECRET", undefined);

    expect(() => loadConfig()).toThrow(/HARNESS_SESSION_SECRET/);
  });
});

function clearAuthEnv(): void {
  vi.stubEnv("HARNESS_AUTH_ENABLED", undefined);
  vi.stubEnv("HARNESS_AUTH_PASSWORD", undefined);
  vi.stubEnv("HARNESS_AUTH_PASSWORD_HASH", undefined);
}
