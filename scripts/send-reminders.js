const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();
const fcm = admin.messaging();

const HOUR = 36e5;
const GRACE = 3 * HOUR;                
const DEFAULT_TZ = "Asia/Jakarta";
const SITE_URL = process.env.SITE_URL || "";
const APP_NAME = "studyeazily";
const MAX_EMAILS_PER_RUN = Number(process.env.MAX_EMAILS_PER_RUN || 50);
const DRY_RUN = process.env.DRY_RUN === "1";
const DEFAULTS = { assignmentHours: [24, 12], examHours: [24], eventHours: [1] };

const GROUPS = [
  { col: "events", label: "Event", prefix: "Event starts in ", key: "eventHours", checkDone: false },
  { col: "exams", label: "Exam", prefix: "Exam in ", key: "examHours", checkDone: false },
  { col: "tasks", label: "Assignment", prefix: "Assignment due in ", key: "assignmentHours", checkDone: true }
];

function offsetAt(ts, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = {};
  dtf.formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - ts;
}

function dueTs(date, time, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [H, M] = (time || "23:59").split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, H, M);
  try {
    const off = offsetAt(guess, tz);
    let t = guess - off;
    const off2 = offsetAt(t, tz);
    if (off2 !== off) t = guess - off2;
    return t;
  } catch (e) {
    return tz === DEFAULT_TZ ? guess : dueTs(date, time, DEFAULT_TZ);
  }
}

function hoursText(h) {
  if (h >= 168 && h % 168 === 0) return h / 168 === 1 ? "1 week" : h / 168 + " weeks";
  if (h >= 24 && h % 24 === 0) return h / 24 === 1 ? "1 day" : h / 24 + " days";
  return h === 1 ? "1 hour" : h + " hours";
}

function whenText(ts, tz) {
  const opts = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return new Date(ts).toLocaleString("en-US", Object.assign({ timeZone: tz }, opts));
  } catch (e) {
    return new Date(ts).toLocaleString("en-US", Object.assign({ timeZone: DEFAULT_TZ }, opts));
  }
}

const ymd = (ts) => new Date(ts).toISOString().slice(0, 10);

const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const validEmail = (v) => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());


function emailProvider() {
  if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) return "brevo";
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return "gmail";
  return null;
}

let mailer = null;
async function sendEmail(to, subject, text, html) {
  const provider = emailProvider();
  if (DRY_RUN) { console.log("[dry-run] email to", to, "|", subject); return; }

  if (provider === "brevo") {
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: APP_NAME, email: process.env.BREVO_SENDER_EMAIL },
        to: [{ email: to }],
        subject: subject,
        textContent: text,
        htmlContent: html
      })
    });
    if (!res.ok) throw new Error("Brevo " + res.status + ": " + (await res.text()).slice(0, 200));
    return;
  }

  if (provider === "gmail") {
    if (!mailer) {
      const nodemailer = require("nodemailer");
      mailer = nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
      });
    }
    await mailer.sendMail({
      from: '"' + APP_NAME + '" <' + process.env.GMAIL_USER + ">",
      to: to, subject: subject, text: text, html: html
    });
    return;
  }

  throw new Error("No email provider configured");
}

function emailBody(job) {
  const when = whenText(job.due, job.sub.tz);
  const title = job.item.title || "Untitled";
  const extra = [job.item.subject, job.item.place].filter(Boolean).join(" · ");
  const link = SITE_URL ? '<p><a href="' + esc(SITE_URL) + '">Open ' + APP_NAME + "</a></p>" : "";
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:520px;line-height:1.5;color:#111">' +
    '<p style="margin:0 0 4px;color:#666">' + esc(job.g.label) + " reminder</p>" +
    '<h2 style="margin:0 0 12px">' + esc(title) + "</h2>" +
    "<p><b>" + esc(job.g.prefix + hoursText(job.h)) + "</b><br>" + esc(when) +
    (extra ? "<br>" + esc(extra) : "") + "</p>" + link +
    '<p style="color:#888;font-size:12px">You get this because email reminders are on in ' + APP_NAME +
    ". You can change this on the Reminders page.</p></div>";
  const text = job.g.prefix + hoursText(job.h) + "\n" + title + "\n" + when +
    (extra ? "\n" + extra : "") + (SITE_URL ? "\n\n" + SITE_URL : "");
  return { subject: job.g.prefix + hoursText(job.h) + ": " + title, text: text, html: html };
}

async function sendPush(j) {
  if (DRY_RUN) { console.log("[dry-run] push to", j.sub.uid, "|", j.g.prefix + hoursText(j.h), j.item.title); return true; }

  const res = await fcm.sendEachForMulticast({
    tokens: j.sub.tokens,
    data: {
      title: j.g.prefix + hoursText(j.h),
      body: (j.item.title || "Untitled") + " (" + whenText(j.due, j.sub.tz) + ")",
      tag: j.item.id + "_" + j.h,
      url: SITE_URL || "./"
    },
    webpush: { headers: { Urgency: "high", TTL: "7200" } }
  });

  const dead = [];
  res.responses.forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
      dead.push(j.sub.tokens[i]);
    }
  });
  if (dead.length) {
    const left = j.sub.tokens.filter((t) => dead.indexOf(t) === -1);
    await db.collection("prefs").doc(j.sub.uid).set({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...dead),
      pushOn: left.length > 0
    }, { merge: true });
  }

  if (res.successCount > 0) return true;
  if (dead.length === j.sub.tokens.length) return false;
  console.log("Push failed for", j.sub.uid, "- will retry");
  return null;
}

async function main() {
  const now = Date.now();
  const provider = emailProvider();
  console.log("Email provider:", provider || "none (email reminders disabled)");

  const byId = {};
  const [pushSnap, mailSnap] = await Promise.all([
    db.collection("prefs").where("pushOn", "==", true).get(),
    db.collection("prefs").where("emailOn", "==", true).get()
  ]);
  pushSnap.docs.concat(mailSnap.docs).forEach((d) => { byId[d.id] = d; });
  const prefDocs = Object.keys(byId).map((id) => byId[id]);
  if (!prefDocs.length) { console.log("Nobody has reminders turned on."); return; }

  // Class memberships: uid -> Set of classIds (for class-only items)
  // and uid -> Set of subjectIds (for subject-restricted shared items)
  const [memSnap, classSnap] = await Promise.all([
    db.collection("memberships").get(),
    db.collection("classes").get()
  ]);
  const subjectOfClass = {};
  classSnap.docs.forEach((d) => { subjectOfClass[d.id] = d.data().subjectId || ""; });
  const classesOf = {};
  const subjectsOf = {};
  memSnap.docs.forEach((d) => {
    const x = d.data();
    if (!x.uid || !x.classId) return;
    (classesOf[x.uid] = classesOf[x.uid] || new Set()).add(x.classId);
    const sid = subjectOfClass[x.classId];
    if (sid) (subjectsOf[x.uid] = subjectsOf[x.uid] || new Set()).add(sid);
  });

  const userSnaps = await db.getAll(...prefDocs.map((d) => db.collection("users").doc(d.id)));
  const subs = [];
  for (let i = 0; i < prefDocs.length; i++) {
    const d = prefDocs[i];
    const u = userSnaps[i];
    if (!u.exists || u.data().status !== "approved") continue;
    const p = d.data();
    const tokens = Array.isArray(p.fcmTokens) ? p.fcmTokens : [];

    let address = "";
    if (p.emailOn === true && provider) {
      try {
        const rec = await admin.auth().getUser(d.id);
        if (validEmail(rec.email)) address = rec.email;
      } catch (e) {
        console.error("Could not look up account email for", d.id, "-", e.message);
      }
    }
    const hours = {
      assignmentHours: p.assignmentHours || DEFAULTS.assignmentHours,
      examHours: p.examHours || DEFAULTS.examHours,
      eventHours: p.eventHours || DEFAULTS.eventHours
    };
    const base = { uid: d.id, tz: p.tz || DEFAULT_TZ, hours: hours, classes: classesOf[d.id] || new Set(), subjects: subjectsOf[d.id] || new Set() };

    if (p.pushOn === true && tokens.length) {
      subs.push(Object.assign({ channel: "push", tokens: tokens, since: p.pushSince || 0 }, base));
    }
    if (p.emailOn === true && address && provider) {
      subs.push(Object.assign({ channel: "email", address: address, since: p.emailSince || 0 }, base));
    }
  }
  if (!subs.length) { console.log("No usable subscribers."); return; }

  const from = ymd(now - 2 * 24 * HOUR);
  const to = ymd(now + 9 * 24 * HOUR);
  const items = {};
  for (const g of GROUPS) {
    const snap = await db.collection(g.col).where("date", ">=", from).where("date", "<=", to).get();
    items[g.col] = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  }

  const logSnap = await db.collection("reminderLog").where("fireAt", ">=", now - GRACE - HOUR).get();
  const logged = new Set(logSnap.docs.map((d) => d.id));

  const jobs = [];
  for (const sub of subs) {
    for (const g of GROUPS) {
      for (const item of items[g.col]) {
        if (!item.date) continue;
        // "public" = everyone. "shared" with a subject = only people who joined a class in that subject.
        const visible = item.scope === "public" ||
          (item.scope === "shared" && (!item.subjectId || sub.subjects.has(item.subjectId))) ||
          item.ownerId === sub.uid ||
          (item.scope === "class" && item.classId && sub.classes.has(item.classId));
        if (!visible) continue;

        const due = dueTs(item.date, item.time, sub.tz);
        if (due <= now) continue;

        const minFire = Math.max(now - GRACE, sub.since);
        const eligible = (sub.hours[g.key] || [])
          .filter((h) => { const f = due - h * HOUR; return f <= now && f >= minFire; })
          .sort((a, b) => a - b);
        if (!eligible.length) continue;

        const h = eligible[0];
        const logId = sub.uid + "_" + item.id + "_" + h + "_" + sub.channel;
        if (logged.has(logId)) continue;

        jobs.push({ sub: sub, g: g, item: item, due: due, h: h, eligible: eligible });
      }
    }
  }

  const taskJobs = jobs.filter((j) => j.g.checkDone);
  const finished = new Set();
  if (taskJobs.length) {
    const refs = taskJobs.map((j) => db.collection("users").doc(j.sub.uid).collection("done").doc(j.item.id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap, i) => { if (snap.exists) finished.add(taskJobs[i]); });
  }

  let pushSent = 0;
  let mailSent = 0;
  for (const j of jobs) {
    const logs = j.eligible.map((h) => ({
      id: j.sub.uid + "_" + j.item.id + "_" + h + "_" + j.sub.channel,
      fireAt: j.due - h * HOUR
    }));

    if (!finished.has(j)) {
      if (j.sub.channel === "push") {
        const ok = await sendPush(j);
        if (ok === null) continue;                   
        if (ok) pushSent++;
      } else {
        if (mailSent >= MAX_EMAILS_PER_RUN) continue; 
        try {
          const mail = emailBody(j);
          await sendEmail(j.sub.address, mail.subject, mail.text, mail.html);
          mailSent++;
        } catch (err) {
          console.error("Email failed for", j.sub.uid, "-", err.message);
          continue;                             
        }
      }
    }

    if (!DRY_RUN) {
      const batch = db.batch();
      logs.forEach((l) => batch.set(db.collection("reminderLog").doc(l.id), { fireAt: l.fireAt, sentAt: now }));
      await batch.commit();
    }
  }

  if (!DRY_RUN) {
    const old = await db.collection("reminderLog").where("fireAt", "<", now - 3 * 24 * HOUR).limit(200).get();
    if (!old.empty) {
      const batch = db.batch();
      old.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }

  console.log("Done. Candidates:", jobs.length, "| push sent:", pushSent, "| emails sent:", mailSent);
}

main().catch((err) => { console.error(err); process.exit(1); });
