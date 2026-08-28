import { MongoClient } from "mongodb";

const port = process.env.MONGO_PORT || "27017";
const uri = `mongodb://127.0.0.1:${port}/admin?directConnection=true`;
const client = new MongoClient(uri);

try {
  await client.connect();
  const admin = client.db("admin");

  try {
    const status = await admin.command({ replSetGetStatus: 1 });
    if (status.ok === 1) {
      console.log("Replica set already initialized.");
      process.exit(0);
    }
  } catch {
    await admin.command({
      replSetInitiate: {
        _id: "rs0",
        members: [{ _id: 0, host: `127.0.0.1:${port}` }]
      }
    });
    console.log("Replica set rs0 initialized.");
  }
} finally {
  await client.close();
}
