import { MongoClient, type Collection, type Db, type Document } from "mongodb";
import { DEFAULT_TASK_ROLE } from "../shared/schemas";
import { generatePublicTaskId } from "./publicTaskId";
import type {
  AccountDoc,
  AppSettingsDoc,
  ArtifactDoc,
  BoardAutomationDoc,
  ContextRefDoc,
  EventDoc,
  PostDoc,
  RunDoc,
  ServiceAccountDoc,
  TaskDoc,
  TaskVersionDoc,
  ThreadDoc
} from "./models";

export interface Collections {
  accounts: Collection<AccountDoc>;
  serviceAccounts: Collection<ServiceAccountDoc>;
  appSettings: Collection<AppSettingsDoc>;
  boardAutomation: Collection<BoardAutomationDoc>;
  threads: Collection<ThreadDoc>;
  posts: Collection<PostDoc>;
  tasks: Collection<TaskDoc>;
  taskVersions: Collection<TaskVersionDoc>;
  runs: Collection<RunDoc>;
  events: Collection<EventDoc>;
  artifacts: Collection<ArtifactDoc>;
  contextRefs: Collection<ContextRefDoc>;
}

export interface MongoConnection {
  client: MongoClient;
  db: Db;
  collections: Collections;
}

export async function connectMongo(uri: string, dbName: string): Promise<MongoConnection> {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(dbName);
  const collections = makeCollections(db);
  await ensureIndexes(collections);
  return { client, db, collections };
}

export function makeCollections(db: Db): Collections {
  return {
    accounts: db.collection<AccountDoc>("accounts"),
    serviceAccounts: db.collection<ServiceAccountDoc>("service_accounts"),
    appSettings: db.collection<AppSettingsDoc>("app_settings"),
    boardAutomation: db.collection<BoardAutomationDoc>("board_automation"),
    threads: db.collection<ThreadDoc>("threads"),
    posts: db.collection<PostDoc>("posts"),
    tasks: db.collection<TaskDoc>("tasks"),
    taskVersions: db.collection<TaskVersionDoc>("task_versions"),
    runs: db.collection<RunDoc>("runs"),
    events: db.collection<EventDoc>("events"),
    artifacts: db.collection<ArtifactDoc>("artifacts"),
    contextRefs: db.collection<ContextRefDoc>("context_refs")
  };
}

export async function ensureIndexes(collections: Collections): Promise<void> {
  await Promise.all([
    collections.accounts.createIndex({ username: 1 }, { unique: true }),
    collections.serviceAccounts.createIndex({ name: 1 }, { unique: true }),
    collections.serviceAccounts.createIndex({ tokenFingerprint: 1 }, { unique: true }),
    collections.serviceAccounts.createIndex({ status: 1, updatedAt: -1 }),
    collections.appSettings.createIndex({ updatedAt: -1 }),
    collections.accounts.createIndex({ status: 1, updatedAt: -1 }),
    collections.boardAutomation.createIndex({ enabled: 1, updatedAt: -1 }),
    collections.threads.createIndex({ folder: 1, lastActivityAt: -1 }),
    collections.threads.createIndex({ role: 1, boardStage: 1, lastActivityAt: -1 }),
    collections.threads.createIndex({ boardStage: 1, lastActivityAt: -1 }),
    collections.threads.createIndex({ status: 1, lastActivityAt: -1 }),
    collections.threads.createIndex({ lastActivityAt: -1 }),
    collections.threads.createIndex(
      { externalTaskSource: 1, externalTaskKey: 1 },
      {
        unique: true,
        partialFilterExpression: {
          externalTaskSource: { $type: "string" },
          externalTaskKey: { $type: "string" }
        }
      }
    ),
    collections.posts.createIndex({ threadId: 1, createdAt: 1 }),
    collections.posts.createIndex({ parentPostId: 1, createdAt: 1 }),
    collections.posts.createIndex({ runId: 1, createdAt: 1 }),
    collections.posts.createIndex({ authorType: 1, createdAt: -1 }),
    collections.tasks.createIndex({ threadId: 1 }),
    collections.tasks.createIndex({ role: 1, status: 1, updatedAt: -1 }),
    collections.tasks.createIndex({ status: 1, updatedAt: -1 }),
    collections.tasks.createIndex({ assignedAgent: 1, status: 1 }),
    collections.taskVersions.createIndex({ taskId: 1, versionNumber: -1 }),
    collections.taskVersions.createIndex({ sourcePostId: 1 }),
    collections.runs.createIndex({ taskId: 1, startedAt: -1 }),
    collections.runs.createIndex({ triggerPostId: 1 }),
    collections.runs.createIndex({ status: 1, startedAt: -1 }),
    collections.runs.createIndex({ status: 1, lastEventAt: -1 }),
    collections.events.createIndex({ runId: 1, createdAt: 1 }),
    collections.events.createIndex({ threadId: 1, createdAt: 1 }),
    collections.events.createIndex({ taskId: 1, createdAt: 1 }),
    collections.artifacts.createIndex({ taskId: 1, createdAt: -1 }),
    collections.artifacts.createIndex({ runId: 1, createdAt: -1 }),
    collections.contextRefs.createIndex({ threadId: 1, createdAt: -1 }),
    collections.contextRefs.createIndex({ taskId: 1, createdAt: -1 }),
    collections.contextRefs.createIndex({ postId: 1, createdAt: -1 })
  ]);

  await ensureThreadPublicTaskIds(collections);
  await ensureTaskRoles(collections);
  await collections.threads.createIndex({ publicTaskId: 1 }, { unique: true });
}

async function ensureThreadPublicTaskIds(collections: Collections): Promise<void> {
  const cursor = collections.threads
    .find({ publicTaskId: { $exists: false } })
    .project<Pick<ThreadDoc, "_id" | "createdAt">>({ _id: 1, createdAt: 1 });

  for await (const thread of cursor) {
    let assigned = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const publicTaskId = generatePublicTaskId(thread.createdAt ?? new Date());
      const existing = await collections.threads.findOne({ publicTaskId }, { projection: { _id: 1 } });
      if (existing) {
        continue;
      }

      const updated = await collections.threads.updateOne(
        { _id: thread._id, publicTaskId: { $exists: false } },
        { $set: { publicTaskId } }
      );
      if (updated.modifiedCount === 1 || updated.matchedCount === 0) {
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      throw new Error(`Cannot allocate a unique public task id for thread ${thread._id.toHexString()}`);
    }
  }
}

async function ensureTaskRoles(collections: Collections): Promise<void> {
  await Promise.all([
    collections.threads.updateMany(
      { $or: [{ role: { $exists: false } }, { role: "program" }] } as Document,
      [
        {
          $set: {
            role: {
              $cond: [{ $eq: ["$role", "program"] }, "se", { $ifNull: ["$role", DEFAULT_TASK_ROLE] }]
            }
          }
        }
      ]
    ),
    collections.tasks.updateMany(
      {
        $or: [{ role: { $exists: false } }, { role: "program" }, { "taskSpec.role": { $exists: false } }, { "taskSpec.role": "program" }]
      } as Document,
      [
        {
          $set: {
            role: {
              $cond: [{ $eq: ["$role", "program"] }, "se", { $ifNull: ["$role", DEFAULT_TASK_ROLE] }]
            },
            taskSpec: {
              $mergeObjects: [
                "$taskSpec",
                {
                  role: {
                    $cond: [
                      { $eq: ["$taskSpec.role", "program"] },
                      "se",
                      { $ifNull: ["$taskSpec.role", { $ifNull: ["$role", DEFAULT_TASK_ROLE] }] }
                    ]
                  }
                }
              ]
            }
          }
        }
      ]
    ),
    collections.taskVersions.updateMany(
      { $or: [{ "spec.role": { $exists: false } }, { "spec.role": "program" }] },
      [
        {
          $set: {
            spec: {
              $mergeObjects: [
                "$spec",
                {
                  role: {
                    $cond: [{ $eq: ["$spec.role", "program"] }, "se", { $ifNull: ["$spec.role", DEFAULT_TASK_ROLE] }]
                  }
                }
              ]
            }
          }
        }
      ]
    ),
    collections.runs.updateMany({ "metadata.role": "program" }, { $set: { "metadata.role": "se" } }),
    collections.events.updateMany({ "payload.role": "program" }, { $set: { "payload.role": "se" } })
  ]);
}
