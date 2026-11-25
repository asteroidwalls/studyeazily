const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

const DAY = 24 * 36e5;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const DRY_RUN = process.env.DRY_RUN === "1";
const COLLECTIONS = ["events", "exams", "tasks"];

const ymd = (ts) => new Date(ts).toISOString().slice(0, 10);

async function main() {
  const cutoff = ymd(Date.now() - RETENTION_DAYS * DAY);
  console.log("Menghapus item dengan date <", cutoff, DRY_RUN ? "(dry-run)" : "");

  const expiredTaskIds = [];
  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    console.error("Gagal hapus", err.documentRef.path, "-", err.message);
    return err.failedAttempts < 3; 
  });

  for (const col of COLLECTIONS) {
    const snap = await db.collection(col).where("date", "<", cutoff).get();
    console.log(col + ":", snap.size, "item kadaluarsa");
    snap.docs.forEach((d) => {
      if (col === "tasks") expiredTaskIds.push(d.id);
      if (!DRY_RUN) writer.delete(d.ref);
    });
  }

  if (expiredTaskIds.length) {
    const users = await db.collection("users").listDocuments();
    let doneCount = 0;
    for (const u of users) {
      const refs = expiredTaskIds.map((id) => u.collection("done").doc(id));
      for (let i = 0; i < refs.length; i += 300) {
        const snaps = await db.getAll(...refs.slice(i, i + 300));
        snaps.forEach((s) => {
          if (!s.exists) return;
          doneCount++;
          if (!DRY_RUN) writer.delete(s.ref);
        });
      }
    }
    console.log("done docs:", doneCount);
  }

  await writer.close();
  console.log("Selesai.");
}

main().catch((e) => { console.error(e); process.exit(1); });