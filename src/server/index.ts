import { loadConfig } from "./config";
import { connectMongo } from "./db";
import { AppServerCodexRunner } from "./codexRunner";
import { ThreadEventBus } from "./eventBus";
import { HarnessRepository } from "./repository";
import { AgentWorker } from "./worker";
import { buildServer } from "./app";

async function main(): Promise<void> {
  const config = loadConfig();
  const mongo = await connectMongo(config.mongoUri, config.mongoDb);
  const bus = new ThreadEventBus();
  const repo = new HarnessRepository(mongo.client, mongo.collections);
  const appSettings = await repo.getAppSettings();
  await repo.syncBoardAutomationConfigFromAppSettings(appSettings);
  const runner = new AppServerCodexRunner(config);
  const worker = new AgentWorker(repo, runner, bus, config);
  worker.setConcurrency(appSettings.maxConcurrentTasks);
  const app = await buildServer({
    config,
    db: mongo.db,
    repo,
    worker,
    bus,
    accounts: mongo.collections.accounts,
    serviceAccounts: mongo.collections.serviceAccounts
  });
  const interruptedRuns = await worker.recoverInterruptedRunningRuns();
  if (interruptedRuns > 0) {
    app.log.warn({ interruptedRuns }, "Recovered interrupted running WIP runs");
  }
  const recoveredRuns = await worker.recoverQueuedWipRuns();
  if (recoveredRuns > 0) {
    app.log.info({ recoveredRuns }, "Recovered queued WIP runs");
  }

  const close = async () => {
    await app.close();
    await mongo.client.close();
  };

  process.on("SIGINT", () => {
    void close().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void close().finally(() => process.exit(0));
  });

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
