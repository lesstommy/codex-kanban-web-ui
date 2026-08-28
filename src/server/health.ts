import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "mongodb";
import type { HealthDto } from "../shared/types";
import type { AppConfig } from "./config";

const execFileAsync = promisify(execFile);

export async function checkHealth(db: Db, config: AppConfig): Promise<HealthDto> {
  const [mongo, codex] = await Promise.all([checkMongo(db), checkCodex(config)]);
  return {
    ok: mongo.ok && codex.ok,
    mongo,
    codex
  };
}

async function checkMongo(db: Db): Promise<HealthDto["mongo"]> {
  try {
    await db.admin().ping();
    return { ok: true, message: "MongoDB connected" };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "MongoDB check failed"
    };
  }
}

async function checkCodex(config: AppConfig): Promise<HealthDto["codex"]> {
  try {
    if (path.isAbsolute(config.codexBin) || config.codexBin.includes("/") || config.codexBin.includes("\\")) {
      await fs.access(config.codexBin);
    }
    const [version, login] = await Promise.all([
      execFileAsync(config.codexBin, ["--version"], { timeout: 5000 }),
      execFileAsync(config.codexBin, ["login", "status"], { timeout: 5000 })
    ]);

    return {
      ok: true,
      bin: config.codexBin,
      mode: "app-server",
      version: version.stdout.trim(),
      login: login.stdout.trim(),
      message: "Codex app-server available"
    };
  } catch (error) {
    return {
      ok: false,
      bin: config.codexBin,
      mode: "app-server",
      message: error instanceof Error ? error.message : "Codex app-server check failed"
    };
  }
}
