const port = process.env.MONGO_PORT || "27017";
const host = `127.0.0.1:${port}`;

const status = (() => {
  try {
    return rs.status();
  } catch {
    return null;
  }
})();

if (status && status.ok === 1) {
  print("Replica set already initialized.");
} else {
  rs.initiate({
    _id: "rs0",
    members: [{ _id: 0, host }]
  });
  print("Replica set rs0 initialized.");
}
