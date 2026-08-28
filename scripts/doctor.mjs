#!/usr/bin/env node

import "dotenv/config";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { MongoClient } from "mongodb";

const checks = [];

function record(name, ok, detail) {
  checks.push({ name, ok, detail });
}

function run(command, args) {
  return spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 10_000
  });
}

function commandOutput(result) {
  return result.stdout.trim() || result.stderr.trim() || result.error?.message || "no output";
}

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const nodeSupported =
  (nodeMajor === 20 && nodeMinor >= 19) || (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor >= 23;
record("Node.js", nodeSupported, `v${process.versions.node}`);

const codexBin = process.env.CODEX_BIN?.trim() || "codex";
const codexVersion = run(codexBin, ["--version"]);
record(
  "Codex CLI",
  codexVersion.status === 0,
  commandOutput(codexVersion)
);

if (codexVersion.status === 0) {
  const login = run(codexBin, ["login", "status"]);
  record("Codex login", login.status === 0, commandOutput(login));
}

const localDir = path.resolve(process.env.HARNESS_LOCAL_DIR || ".local");
try {
  await fs.mkdir(localDir, { recursive: true });
  await fs.access(localDir, fsConstants.R_OK | fsConstants.W_OK);
  record("Local data directory", true, localDir);
} catch (error) {
  record("Local data directory", false, error instanceof Error ? error.message : "unavailable");
}

const mongoUri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/harness?replicaSet=rs0";
const mongoDb = process.env.MONGO_DB || "harness";
const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 3_000 });
try {
  await mongo.connect();
  await mongo.db(mongoDb).admin().ping();
  record("MongoDB", true, `${mongoDb} is reachable`);
} catch (error) {
  record("MongoDB", false, error instanceof Error ? error.message : "unavailable");
} finally {
  await mongo.close();
}

for (const check of checks) {
  console.log(`${check.ok ? "OK  " : "FAIL"} ${check.name}: ${check.detail}`);
}

if (checks.some((check) => !check.ok)) {
  process.exitCode = 1;
}
