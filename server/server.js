import express from "express";
import QRCode from "qrcode";
import { randomUUID, randomBytes, createHash, createHmac, scryptSync, timingSafeEqual } from "crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = process.env.DATABASE_PATH || path.join(projectRoot, "data", "campuspass.sqlite");
mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
const db = new DatabaseSync(databasePath, { timeout: 5000 });
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS guards (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance_sessions (
    token TEXT PRIMARY KEY, teacher_name TEXT NOT NULL, class_name TEXT NOT NULL,
    teacher_lat REAL NOT NULL, teacher_lon REAL NOT NULL, teacher_accuracy REAL NOT NULL,
    expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_token TEXT NOT NULL REFERENCES attendance_sessions(token),
    student_id TEXT NOT NULL, marked_at TEXT NOT NULL, distance REAL NOT NULL,
    UNIQUE(session_token, student_id)
  );
  CREATE TABLE IF NOT EXISTS attendance_device_claims (
    session_token TEXT NOT NULL REFERENCES attendance_sessions(token), device_hash TEXT NOT NULL,
    student_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(session_token, device_hash), UNIQUE(session_token, student_id)
  );
  CREATE TABLE IF NOT EXISTS visitors (
    pass_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL,
    organization TEXT NOT NULL, host_name TEXT NOT NULL, host_department TEXT NOT NULL,
    purpose TEXT NOT NULL, vehicle_number TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'outside',
    valid_from INTEGER NOT NULL, valid_until INTEGER NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS visitor_approvals (
    pass_id TEXT PRIMARY KEY REFERENCES visitors(pass_id), token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
    created_at TEXT NOT NULL, decided_at TEXT
  );
  CREATE TABLE IF NOT EXISTS visitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, pass_id TEXT NOT NULL REFERENCES visitors(pass_id),
    guard_username TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('CHECK_IN','CHECK_OUT')),
    scanned_at TEXT NOT NULL, latitude REAL, longitude REAL, qr_slot INTEGER NOT NULL, identity_verified INTEGER NOT NULL DEFAULT 0,
    UNIQUE(pass_id, qr_slot)
  );
  CREATE INDEX IF NOT EXISTS visitor_events_time_idx ON visitor_events(scanned_at DESC);
`);

const eventColumns = db.prepare("PRAGMA table_info(visitor_events)").all().map((column) => column.name);
if (!eventColumns.includes("identity_verified")) db.exec("ALTER TABLE visitor_events ADD COLUMN identity_verified INTEGER NOT NULL DEFAULT 0");

const RADIUS_METRES = 50;
const ATTENDANCE_QR_VALIDITY = 5 * 60 * 1000;
const VISITOR_QR_SLOT_MS = 30 * 1000;
const VISITOR_QR_SKEW_SLOTS = 1;
const VISITOR_VALIDITY_MS = 12 * 60 * 60 * 1000;
const SECURITY_SESSION_MS = 12 * 60 * 60 * 1000;
const guardSessions = new Map();
const teacherSessions = new Map();
const adminSessions = new Map();
const loginAttempts = new Map();

let qrSecret = db.prepare("SELECT value FROM settings WHERE key = 'visitor_qr_secret'").get()?.value;
if (!qrSecret) {
  qrSecret = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO settings(key, value) VALUES ('visitor_qr_secret', ?)").run(qrSecret);
}

const initialUsername = process.env.SECURITY_USERNAME?.trim();
const initialPassword = process.env.SECURITY_PASSWORD;
if (initialUsername && initialPassword) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(initialPassword, salt, 64).toString("hex");
  db.prepare(`INSERT INTO guards(username, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET
    password_salt = excluded.password_salt, password_hash = excluded.password_hash`)
    .run(initialUsername, salt, hash, new Date().toISOString());
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "32kb" }));
function jsonError(res, status, message) { return res.status(status).json({ message }); }
function cleanText(value, max = 160) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function distanceMetres(lat1, lon1, lat2, lon2) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(lat2 - lat1); const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function clampAccuracy(value) { return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0; }
function qrSignature(passId, slot) { return createHmac("sha256", qrSecret).update(`${passId}:${slot}`).digest("hex"); }
function attendanceSignature(token, slot) { return createHmac("sha256", qrSecret).update(`attendance:${token}:${slot}`).digest("hex"); }
function parseAttendanceQr(value) {
  let data;
  try { data = JSON.parse(value); } catch { return null; }
  if (!data || typeof data.token !== "string" || !Number.isSafeInteger(data.slot) || typeof data.signature !== "string") return null;
  const expected = Buffer.from(attendanceSignature(data.token, data.slot), "hex");
  const received = Buffer.from(data.signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  if (Math.abs(Math.floor(Date.now() / VISITOR_QR_SLOT_MS) - data.slot) > VISITOR_QR_SKEW_SLOTS) return null;
  return data;
}
function parseVisitorQr(value) {
  let data;
  try { data = JSON.parse(value); } catch { return null; }
  if (!data || typeof data.passId !== "string" || !Number.isSafeInteger(data.slot) || typeof data.signature !== "string") return null;
  const expected = Buffer.from(qrSignature(data.passId, data.slot), "hex");
  const received = Buffer.from(data.signature, "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  const currentSlot = Math.floor(Date.now() / VISITOR_QR_SLOT_MS);
  if (Math.abs(currentSlot - data.slot) > VISITOR_QR_SKEW_SLOTS) return null;
  return data;
}
function requireGuard(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const session = token && guardSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) guardSessions.delete(token);
    return jsonError(res, 401, "Security login expired. Please sign in again.");
  }
  req.guard = session; next();
}
function requireTeacher(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const session = token && teacherSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) teacherSessions.delete(token);
    return jsonError(res, 401, "Teacher login expired. Please sign in again.");
  }
  req.teacher = session; next();
}
function requireAdmin(req, res, next) {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  const session = token && adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) adminSessions.delete(token);
    return jsonError(res, 401, "Administrator login expired. Please sign in again.");
  }
  req.admin = session; next();
}

app.get("/api/health", (_req, res) => res.json({ ok: true, database: "sqlite", time: new Date().toISOString() }));
app.post("/api/teacher/login", (req, res) => {
  const now = Date.now(); const ip = req.ip || "unknown";
  const attempts = loginAttempts.get(`teacher:${ip}`) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempts.resetAt < now) { attempts.count = 0; attempts.resetAt = now + 15 * 60 * 1000; }
  if (attempts.count >= 8) return jsonError(res, 429, "Too many login attempts. Please wait 15 minutes.");
  const username = cleanText(req.body.username, 80); const password = typeof req.body.password === "string" ? req.body.password : "";
  const expectedUsername = process.env.TEACHER_USERNAME || "";
  const expectedPassword = process.env.TEACHER_PASSWORD || "";
  const matches = username === expectedUsername && password.length === expectedPassword.length && timingSafeEqual(Buffer.from(password), Buffer.from(expectedPassword));
  if (!matches) { attempts.count += 1; loginAttempts.set(`teacher:${ip}`, attempts); return jsonError(res, 401, "Username or password is incorrect."); }
  loginAttempts.delete(`teacher:${ip}`); const token = randomBytes(32).toString("base64url");
  teacherSessions.set(token, { username, expiresAt: now + SECURITY_SESSION_MS });
  res.json({ token, username, expiresAt: now + SECURITY_SESSION_MS });
});
app.post("/api/teacher/logout", requireTeacher, (req, res) => {
  const token = req.get("authorization").replace(/^Bearer\s+/i, ""); teacherSessions.delete(token); res.json({ success: true });
});
app.post("/api/admin/login", (req, res) => {
  const now = Date.now(); const ip = req.ip || "unknown";
  const attempts = loginAttempts.get(`admin:${ip}`) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempts.resetAt < now) { attempts.count = 0; attempts.resetAt = now + 15 * 60 * 1000; }
  if (attempts.count >= 8) return jsonError(res, 429, "Too many login attempts. Please wait 15 minutes.");
  const username = cleanText(req.body.username, 80); const password = typeof req.body.password === "string" ? req.body.password : "";
  const expectedUsername = process.env.ADMIN_USERNAME || ""; const expectedPassword = process.env.ADMIN_PASSWORD || "";
  const matches = Boolean(expectedUsername && expectedPassword) && username === expectedUsername && password.length === expectedPassword.length && timingSafeEqual(Buffer.from(password), Buffer.from(expectedPassword));
  if (!matches) { attempts.count += 1; loginAttempts.set(`admin:${ip}`, attempts); return jsonError(res, 401, "Username or password is incorrect."); }
  loginAttempts.delete(`admin:${ip}`); const token = randomBytes(32).toString("base64url");
  adminSessions.set(token, { username, expiresAt: now + SECURITY_SESSION_MS });
  res.json({ token, username, expiresAt: now + SECURITY_SESSION_MS });
});
app.post("/api/admin/logout", requireAdmin, (req, res) => {
  const token = req.get("authorization").replace(/^Bearer\s+/i, ""); adminSessions.delete(token); res.json({ success: true });
});
app.post("/api/attendance/start", requireTeacher, async (req, res) => {
  const { teacherLat, teacherLon } = req.body;
  if (!Number.isFinite(teacherLat) || !Number.isFinite(teacherLon) || Math.abs(teacherLat) > 90 || Math.abs(teacherLon) > 180) return jsonError(res, 400, "Valid teacher location is required.");
  try {
    const token = randomUUID(); const expiresAt = Date.now() + ATTENDANCE_QR_VALIDITY;
    const teacherName = req.teacher.username; const className = cleanText(req.body.className, 100);
    const teacherAccuracy = clampAccuracy(req.body.teacherAccuracy);
    db.prepare(`INSERT INTO attendance_sessions(token, teacher_name, class_name, teacher_lat, teacher_lon, teacher_accuracy, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, teacherName, className, teacherLat, teacherLon, teacherAccuracy, expiresAt, new Date().toISOString());
    res.json({ message: "Attendance session started.", token, teacherName, className, expiresAt });
  } catch { jsonError(res, 500, "Could not start attendance."); }
});
app.get("/api/attendance/:token/qr", async (req, res) => {
  const session = db.prepare("SELECT expires_at FROM attendance_sessions WHERE token = ?").get(req.params.token);
  if (!session) return jsonError(res, 404, "Attendance session not found.");
  if (Date.now() > session.expires_at) return jsonError(res, 410, "Attendance QR code expired.");
  const slot = Math.floor(Date.now() / VISITOR_QR_SLOT_MS);
  const payload = JSON.stringify({ token: req.params.token, slot, signature: attendanceSignature(req.params.token, slot) });
  const qrCode = await QRCode.toDataURL(payload, { errorCorrectionLevel: "H", margin: 2, width: 320 });
  res.set("Cache-Control", "no-store");
  res.json({ qrCode, payload, rotatesAt: (slot + 1) * VISITOR_QR_SLOT_MS });
});
app.post("/api/attendance/verify", (req, res) => {
  const qr = parseAttendanceQr(req.body.payload); const token = qr?.token;
  const { studentLat, studentLon } = req.body; const studentId = cleanText(req.body.studentId, 80);
  const deviceId = typeof req.body.deviceId === "string" ? req.body.deviceId : "";
  if (!token || !studentId || !/^[a-f0-9-]{32,64}$/i.test(deviceId) || !Number.isFinite(studentLat) || !Number.isFinite(studentLon) || Math.abs(studentLat) > 90 || Math.abs(studentLon) > 180) return jsonError(res, 400, "Use a current QR, your student ID, and this device’s valid check-in key.");
  const session = db.prepare("SELECT * FROM attendance_sessions WHERE token = ?").get(token);
  if (!session) return jsonError(res, 404, "Invalid attendance QR code.");
  if (Date.now() > session.expires_at) return jsonError(res, 410, "QR code expired. Attendance not marked.");
  const distance = distanceMetres(session.teacher_lat, session.teacher_lon, studentLat, studentLon);
  const allowance = Math.min(100, session.teacher_accuracy + clampAccuracy(req.body.studentAccuracy));
  const estimatedDistance = Math.max(0, distance - allowance);
  if (estimatedDistance > RADIUS_METRES) return res.status(403).json({ success: false, message: "You are outside the class check-in area. Attendance not marked.", distance: Math.round(distance), estimatedDistance: Math.round(estimatedDistance), accuracyAllowance: Math.round(allowance) });
  const deviceHash = createHash("sha256").update(deviceId).digest("hex");
  const deviceClaim = db.prepare("SELECT student_id FROM attendance_device_claims WHERE session_token = ? AND device_hash = ?").get(token, deviceHash);
  if (deviceClaim && deviceClaim.student_id !== studentId) return jsonError(res, 403, "This device is already linked to a different student for this session.");
  const studentClaim = db.prepare("SELECT device_hash FROM attendance_device_claims WHERE session_token = ? AND student_id = ?").get(token, studentId);
  if (studentClaim && studentClaim.device_hash !== deviceHash) return jsonError(res, 409, "This student ID has already checked in from another device for this session.");
  const marked = db.prepare("SELECT 1 FROM attendance_records WHERE session_token = ? AND student_id = ?").get(token, studentId);
  if (marked) return jsonError(res, 409, "Attendance is already marked for this student in this session.");
  const markedAt = new Date().toISOString();
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO attendance_device_claims(session_token, device_hash, student_id, created_at) VALUES (?, ?, ?, ?)").run(token, deviceHash, studentId, markedAt);
    db.prepare("INSERT INTO attendance_records(session_token, student_id, marked_at, distance) VALUES (?, ?, ?, ?)").run(token, studentId, markedAt, Math.round(distance));
    db.exec("COMMIT");
    res.json({ success: true, message: "Attendance marked successfully for this device.", studentId, distance: Math.round(distance), estimatedDistance: Math.round(estimatedDistance) });
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* transaction may have failed before BEGIN */ }
    jsonError(res, 409, "This device or student ID has already been used for this session.");
  }
});
app.get("/api/attendance/:token/records", requireTeacher, (req, res) => {
  const session = db.prepare("SELECT expires_at FROM attendance_sessions WHERE token = ?").get(req.params.token);
  if (!session) return jsonError(res, 404, "Attendance session not found.");
  const records = db.prepare("SELECT student_id AS studentId, marked_at AS markedAt, distance FROM attendance_records WHERE session_token = ? ORDER BY marked_at").all(req.params.token);
  res.json({ records, expiresAt: session.expires_at });
});
app.get("/api/teacher/attendance/:token.csv", requireTeacher, (req, res) => {
  const session = db.prepare("SELECT token, teacher_name, class_name, created_at, expires_at FROM attendance_sessions WHERE token = ?").get(req.params.token);
  if (!session) return jsonError(res, 404, "Attendance session not found.");
  const rows = db.prepare("SELECT student_id, marked_at, distance FROM attendance_records WHERE session_token = ? ORDER BY marked_at").all(req.params.token);
  const columns = ["class_name", "teacher_name", "session_started_at", "session_closed_at", "student_id", "marked_at", "distance_metres"];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns.join(","), ...rows.map((row) => [session.class_name, session.teacher_name, session.created_at, new Date(session.expires_at).toISOString(), row.student_id, row.marked_at, row.distance].map(escape).join(","))].join("\r\n");
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=campuspass-${session.class_name.replace(/[^a-z0-9]+/gi, "-")}-attendance.csv` }).send(csv);
});

app.post("/api/visitors", (req, res) => {
  const visitor = {
    fullName: cleanText(req.body.fullName, 120), phone: cleanText(req.body.phone, 32), email: cleanText(req.body.email, 160).toLowerCase(),
    organization: cleanText(req.body.organization, 120), hostName: cleanText(req.body.hostName, 120),
    hostDepartment: cleanText(req.body.hostDepartment, 100), purpose: cleanText(req.body.purpose, 500), vehicleNumber: cleanText(req.body.vehicleNumber, 24).toUpperCase(),
  };
  if (!visitor.fullName || !visitor.phone || !visitor.email || !visitor.organization || !visitor.hostName || !visitor.hostDepartment || !visitor.purpose) return jsonError(res, 400, "Complete all required visitor and host details.");
  if (!/^[+0-9][0-9 +()-]{6,30}$/.test(visitor.phone)) return jsonError(res, 400, "Enter a valid phone number.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(visitor.email)) return jsonError(res, 400, "Enter a valid email address.");
  const passId = randomBytes(24).toString("base64url"); const approvalToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(approvalToken).digest("hex");
  const now = Date.now(); const validUntil = now + VISITOR_VALIDITY_MS;
  db.prepare(`INSERT INTO visitors(pass_id, full_name, phone, email, organization, host_name, host_department, purpose, vehicle_number, valid_from, valid_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(passId, visitor.fullName, visitor.phone, visitor.email, visitor.organization, visitor.hostName, visitor.hostDepartment, visitor.purpose, visitor.vehicleNumber, now, validUntil, new Date(now).toISOString());
  db.prepare("INSERT INTO visitor_approvals(pass_id, token_hash, status, created_at) VALUES (?, ?, 'pending', ?)").run(passId, tokenHash, new Date(now).toISOString());
  res.status(201).json({ passId, visitor, validUntil });
});
app.get("/api/visitors/:passId/qr", async (req, res) => {
  const visitor = db.prepare("SELECT pass_id, full_name, host_name, host_department, purpose, organization, vehicle_number, status, valid_from, valid_until, (SELECT status FROM visitor_approvals WHERE pass_id = visitors.pass_id) AS approval_status FROM visitors WHERE pass_id = ?").get(req.params.passId);
  if (!visitor) return jsonError(res, 404, "Visitor pass not found.");
  const visitorDetails = { fullName: visitor.full_name, hostName: visitor.host_name, hostDepartment: visitor.host_department, purpose: visitor.purpose, organization: visitor.organization, vehicleNumber: visitor.vehicle_number, status: visitor.status, approvalStatus: visitor.approval_status, validUntil: visitor.valid_until };
  if (visitor.approval_status !== "approved") return res.json({ qrCode: null, visitor: visitorDetails });
  if (Date.now() > visitor.valid_until && visitor.status !== "inside") return jsonError(res, 410, "This visitor pass has expired.");
  const slot = Math.floor(Date.now() / VISITOR_QR_SLOT_MS);
  const payload = JSON.stringify({ passId: visitor.pass_id, slot, signature: qrSignature(visitor.pass_id, slot) });
  const qrCode = await QRCode.toDataURL(payload, { errorCorrectionLevel: "H", margin: 2, width: 320 });
  res.set("Cache-Control", "no-store");
  res.json({ qrCode, payload, rotatesAt: (slot + 1) * VISITOR_QR_SLOT_MS, visitor: visitorDetails });
});

app.post("/api/security/login", (req, res) => {
  const now = Date.now(); const ip = req.ip || "unknown";
  const attempts = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (attempts.resetAt < now) { attempts.count = 0; attempts.resetAt = now + 15 * 60 * 1000; }
  if (attempts.count >= 8) return jsonError(res, 429, "Too many login attempts. Please wait 15 minutes.");
  const username = cleanText(req.body.username, 80); const password = typeof req.body.password === "string" ? req.body.password : "";
  const guard = db.prepare("SELECT id, username, password_salt, password_hash FROM guards WHERE username = ?").get(username);
  const givenHash = guard ? scryptSync(password, guard.password_salt, 64) : scryptSync(password || "invalid", "campuspass-invalid", 64);
  const savedHash = guard ? Buffer.from(guard.password_hash, "hex") : Buffer.alloc(64);
  if (!guard || !timingSafeEqual(givenHash, savedHash)) { attempts.count += 1; loginAttempts.set(ip, attempts); return jsonError(res, 401, "Username or password is incorrect."); }
  loginAttempts.delete(ip); const token = randomBytes(32).toString("base64url");
  guardSessions.set(token, { guardId: guard.id, username: guard.username, expiresAt: now + SECURITY_SESSION_MS });
  res.json({ token, username: guard.username, expiresAt: now + SECURITY_SESSION_MS });
});
app.post("/api/security/logout", requireGuard, (req, res) => {
  const token = req.get("authorization").replace(/^Bearer\s+/i, ""); guardSessions.delete(token); res.json({ success: true });
});
app.get("/api/security/dashboard", requireGuard, (req, res) => {
  const inside = db.prepare(`SELECT pass_id AS passId, full_name AS fullName, phone, email, organization, host_name AS hostName, host_department AS hostDepartment, purpose, vehicle_number AS vehicleNumber, created_at AS createdAt FROM visitors WHERE status = 'inside' ORDER BY full_name`).all();
  const recentEvents = db.prepare(`SELECT e.id, e.event_type AS eventType, e.scanned_at AS scannedAt, e.guard_username AS guardUsername, e.latitude, e.longitude, e.identity_verified AS identityVerified, v.full_name AS fullName, v.organization, v.host_name AS hostName, v.purpose, v.vehicle_number AS vehicleNumber FROM visitor_events e JOIN visitors v ON v.pass_id = e.pass_id ORDER BY e.id DESC LIMIT 40`).all();
  const insideCount = db.prepare("SELECT COUNT(*) AS count FROM visitors WHERE status = 'inside'").get().count;
  const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();
  const visitorsToday = db.prepare("SELECT COUNT(*) AS count FROM visitor_events WHERE scanned_at >= ? AND event_type = 'CHECK_IN'").get(todayIso).count;
  const attendanceToday = db.prepare("SELECT COUNT(*) AS count FROM attendance_records WHERE marked_at >= ?").get(todayIso).count;
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS count FROM visitor_approvals WHERE status = 'pending'").get().count;
  const approvalQueue = db.prepare(`SELECT v.pass_id AS passId, v.full_name AS fullName, v.phone, v.email, v.organization, v.host_name AS hostName, v.host_department AS hostDepartment, v.purpose, v.vehicle_number AS vehicleNumber, v.created_at AS createdAt, v.valid_until AS validUntil FROM visitors v JOIN visitor_approvals a ON a.pass_id = v.pass_id WHERE a.status = 'pending' ORDER BY v.created_at`).all();
  const presentStudents = db.prepare("SELECT s.class_name AS className, s.teacher_name AS teacherName, r.student_id AS studentId, r.marked_at AS markedAt FROM attendance_records r JOIN attendance_sessions s ON s.token = r.session_token WHERE r.marked_at >= ? ORDER BY s.class_name, r.marked_at").all(todayIso);
  res.json({ inside, insideCount, recentEvents, guard: req.guard.username, visitorsToday, attendanceToday, pendingApprovals, approvalQueue, presentStudents });
});
app.post("/api/security/visitor-approvals/:passId", requireGuard, (req, res) => {
  const decision = req.body.decision;
  if (!["approved", "denied"].includes(decision)) return jsonError(res, 400, "Choose approve or decline.");
  const result = db.prepare("UPDATE visitor_approvals SET status = ?, decided_at = ? WHERE pass_id = ? AND status = 'pending'").run(decision, new Date().toISOString(), req.params.passId);
  if (!result.changes) return jsonError(res, 409, "This visitor request has already been decided or no longer exists.");
  res.json({ approvalStatus: decision });
});
app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  const now = Date.now(); const today = new Date(); today.setUTCHours(0, 0, 0, 0); const todayIso = today.toISOString();
  const totalStudents = db.prepare("SELECT COUNT(DISTINCT student_id) AS count FROM attendance_records").get().count;
  const totalVisitors = db.prepare("SELECT COUNT(*) AS count FROM visitors").get().count;
  const studentsCheckedInToday = db.prepare("SELECT COUNT(DISTINCT student_id) AS count FROM attendance_records WHERE marked_at >= ?").get(todayIso).count;
  const visitorsInside = db.prepare("SELECT COUNT(*) AS count FROM visitors WHERE status = 'inside'").get().count;
  const activeSessions = db.prepare("SELECT COUNT(*) AS count FROM attendance_sessions WHERE expires_at > ?").get(now).count;
  const pendingApprovals = db.prepare("SELECT COUNT(*) AS count FROM visitor_approvals WHERE status = 'pending'").get().count;
  const visitorRequestsToday = db.prepare("SELECT COUNT(*) AS count FROM visitors WHERE created_at >= ?").get(todayIso).count;
  const attendanceToday = db.prepare("SELECT s.class_name AS className, s.teacher_name AS teacherName, r.student_id AS studentId, r.marked_at AS markedAt FROM attendance_records r JOIN attendance_sessions s ON s.token = r.session_token WHERE r.marked_at >= ? ORDER BY r.marked_at DESC LIMIT 60").all(todayIso);
  const visitorEvents = db.prepare("SELECT e.id, e.event_type AS eventType, e.scanned_at AS scannedAt, e.guard_username AS guardUsername, v.full_name AS fullName, v.organization, v.host_name AS hostName FROM visitor_events e JOIN visitors v ON v.pass_id = e.pass_id ORDER BY e.id DESC LIMIT 30").all();
  const activeAttendanceSessions = db.prepare("SELECT token, class_name AS className, teacher_name AS teacherName, created_at AS createdAt, expires_at AS expiresAt, (SELECT COUNT(*) FROM attendance_records r WHERE r.session_token = attendance_sessions.token) AS attendanceCount FROM attendance_sessions WHERE expires_at > ? ORDER BY created_at DESC").all(now);
  res.json({ admin: req.admin.username, totalStudents, totalVisitors, studentsCheckedInToday, visitorsInside, campusPresenceRecorded: studentsCheckedInToday + visitorsInside, activeSessions, pendingApprovals, visitorRequestsToday, attendanceToday, visitorEvents, activeAttendanceSessions });
});
app.get("/api/security/events.csv", requireGuard, (_req, res) => {
  const rows = db.prepare(`SELECT e.scanned_at, e.event_type, v.full_name, v.phone, v.email, v.organization, v.host_name, v.host_department, v.purpose, v.vehicle_number, e.guard_username, e.latitude, e.longitude, e.identity_verified FROM visitor_events e JOIN visitors v ON v.pass_id = e.pass_id ORDER BY e.id DESC`).all();
  const columns = ["scanned_at", "event_type", "full_name", "phone", "email", "organization", "host_name", "host_department", "purpose", "vehicle_number", "guard_username", "latitude", "longitude", "identity_verified"];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n");
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=campuspass-visitor-log.csv" }).send(csv);
});
app.get("/api/security/attendance.csv", requireGuard, (_req, res) => {
  const rows = db.prepare("SELECT s.class_name, s.teacher_name, r.student_id, r.marked_at, r.distance FROM attendance_records r JOIN attendance_sessions s ON s.token = r.session_token ORDER BY r.marked_at DESC").all();
  const columns = ["class_name", "teacher_name", "student_id", "marked_at", "distance"];
  const escape = (value) => '"' + String(value ?? "").replaceAll('"', '""') + '"';
  const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\r\n");
  res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=campuspass-attendance.csv" }).send(csv);
});
app.post("/api/security/scan", requireGuard, (req, res) => {
  const data = parseVisitorQr(req.body.payload);
  if (!data) return jsonError(res, 400, "QR code is invalid or has expired. Ask the visitor to refresh their code.");
  const visitor = db.prepare("SELECT v.*, a.status AS approval_status FROM visitors v JOIN visitor_approvals a ON a.pass_id = v.pass_id WHERE v.pass_id = ?").get(data.passId);
  if (!visitor) return jsonError(res, 404, "Visitor pass not found.");
  if (visitor.approval_status !== "approved") return jsonError(res, 403, "Host approval is required before this pass can be used.");
  const now = Date.now();
  if (visitor.status !== "inside" && (now < visitor.valid_from || now > visitor.valid_until)) return jsonError(res, 410, "Visitor pass is outside its valid check-in time.");
  const eventType = visitor.status === "inside" ? "CHECK_OUT" : "CHECK_IN";
  const identityVerified = req.body.identityVerified === true;
  if (eventType === "CHECK_IN" && !identityVerified) return jsonError(res, 403, "Confirm the visitor photo ID before checking them in.");
  const latitude = Number.isFinite(req.body.latitude) && Math.abs(req.body.latitude) <= 90 ? req.body.latitude : null;
  const longitude = Number.isFinite(req.body.longitude) && Math.abs(req.body.longitude) <= 180 ? req.body.longitude : null;
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("INSERT INTO visitor_events(pass_id, guard_username, event_type, scanned_at, latitude, longitude, qr_slot, identity_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(visitor.pass_id, req.guard.username, eventType, new Date(now).toISOString(), latitude, longitude, data.slot, identityVerified ? 1 : 0);
    db.prepare("UPDATE visitors SET status = ? WHERE pass_id = ?").run(eventType === "CHECK_IN" ? "inside" : "outside", visitor.pass_id);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction may have failed before BEGIN */ }
    if (String(error.message).includes("UNIQUE constraint failed")) return jsonError(res, 409, "This QR has already been scanned. Wait for the visitor's next rotating code.");
    return jsonError(res, 500, "Could not save the security scan.");
  }
  res.json({ success: true, eventType, message: eventType === "CHECK_IN" ? "Visitor checked in." : "Visitor checked out.", visitor: { fullName: visitor.full_name, phone: visitor.phone, email: visitor.email, organization: visitor.organization, hostName: visitor.host_name, hostDepartment: visitor.host_department, purpose: visitor.purpose, vehicleNumber: visitor.vehicle_number }, scannedAt: new Date(now).toISOString() });
});

const distPath = path.join(projectRoot, "dist");
app.use(express.static(distPath));
app.use((req, res, next) => {
  if (req.method === "GET" && req.accepts("html")) return res.sendFile(path.join(distPath, "index.html"));
  next();
});
const port = Number(process.env.PORT || 5000);
app.listen(port, "0.0.0.0", () => console.log(`CampusPass listening on port ${port}; SQLite database: ${databasePath}`));

