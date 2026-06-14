const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "camstudy-dev-secret-change-me";
const INIT_PASSWORD = "1234";
const PHOTO_BUCKET = "question-photos";

// ---- JaaS (Jitsi as a Service) 영상 설정 ----
// Render 환경변수에 넣을 값:
//   JAAS_APP_ID       vpaas-magic-cookie-... (App ID)
//   JAAS_API_KEY      vpaas-magic-cookie-.../xxxxxx (API Key = kid)
//   JAAS_PRIVATE_KEY  -----BEGIN PRIVATE KEY----- ... (다운로드한 .pk 파일 내용 전체)
//   MAX_DEVICES_PER_USER  학번당 등록 가능 기기 수 (기본 2)
const JAAS_APP_ID = process.env.JAAS_APP_ID || "";
const JAAS_API_KEY = process.env.JAAS_API_KEY || "";
// 개인키는 줄바꿈이 \n 으로 들어올 수 있어 복원
const JAAS_PRIVATE_KEY = (process.env.JAAS_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const MAX_DEVICES_PER_USER = parseInt(process.env.MAX_DEVICES_PER_USER || "2", 10);
// JaaS 무료 플랜 MAU(기기 기준) 한도 — 현황 표시용
const JAAS_MAU_LIMIT = parseInt(process.env.JAAS_MAU_LIMIT || "25", 10);
const JAAS_ROOM = "main-camstudy"; // 모두 같은 방 사용

// ---- 권한 체계 ----
const OWNER_IDS = ["teacher", "30122"];
function isOwner(studentId) { return OWNER_IDS.includes(studentId); }
function resolveRole(user) {
  if (!user) return "student";
  if (isOwner(user.student_id)) return "owner";
  return user.role === "admin" ? "admin" : "student";
}
function isStaffRole(role) { return role === "owner" || role === "admin"; }

// ---- Supabase ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("\n[설정 오류] SUPABASE_URL 과 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.\n");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ---- 학번 검증 ----
function isValidStudentId(id) { return /^\d{5}$/.test(id) || id === "teacher"; }

// 계정 생성 (시드 전용 - 로그인에서는 사용 안 함)
async function ensureUser(studentId, nickname) {
  const { data: existing } = await supabase.from("users").select("*").eq("student_id", studentId).maybeSingle();
  if (existing) return existing;
  const newUser = {
    student_id: studentId,
    password_hash: bcrypt.hashSync(INIT_PASSWORD, 10),
    nickname: nickname || studentId,
    must_change: true,
    role: "student",
    created_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from("users").insert(newUser).select().single();
  if (error) {
    const { data: again } = await supabase.from("users").select("*").eq("student_id", studentId).maybeSingle();
    return again || newUser;
  }
  return data;
}

async function seedClassAccounts() {
  for (let n = 30101; n <= 30128; n++) {
    try { await ensureUser(String(n)); } catch (e) { console.error("시드 오류:", n, e.message); }
  }
  try { await ensureUser("teacher", "이용휘 선생님"); } catch (e) { console.error("선생님 시드 오류:", e.message); }
  console.log("우리 반 계정(30101~30128) + 담임(teacher) 준비 완료");
}

// ---- Express ----
const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다." });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "세션이 만료되었습니다. 다시 로그인하세요." }); }
}
function requireStaff(req, res, next) {
  if (!isStaffRole(req.user.role)) return res.status(403).json({ error: "관리자 권한이 필요합니다." });
  next();
}
function requireOwner(req, res, next) {
  if (req.user.role !== "owner") return res.status(403).json({ error: "운영자만 가능한 기능입니다." });
  next();
}

// --- 로그인 (자동 계정 생성 없음) ---
app.post("/api/login", async (req, res) => {
  try {
    const { studentId, password } = req.body || {};
    if (!isValidStudentId(studentId || "")) {
      return res.status(400).json({ error: "학번 형식이 올바르지 않습니다. 예) 30101" });
    }
    const { data: user } = await supabase.from("users").select("*").eq("student_id", studentId).maybeSingle();
    if (!user) {
      return res.status(404).json({ error: "없는 계정입니다. 관리자에게 문의해주세요." });
    }
    if (!bcrypt.compareSync(password || "", user.password_hash)) {
      return res.status(401).json({ error: "비밀번호가 틀렸습니다." });
    }
    const role = resolveRole(user);
    const token = jwt.sign({ studentId, nickname: user.nickname, role }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, studentId, nickname: user.nickname, mustChange: !!user.must_change, role });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류" }); }
});

// --- 비밀번호 변경 ---
app.post("/api/change-password", auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const { data: user } = await supabase.from("users").select("*").eq("student_id", req.user.studentId).maybeSingle();
    if (!user || !bcrypt.compareSync(currentPassword || "", user.password_hash)) {
      return res.status(401).json({ error: "현재 비밀번호가 틀렸습니다." });
    }
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: "새 비밀번호는 4자 이상이어야 합니다." });
    }
    await supabase.from("users").update({ password_hash: bcrypt.hashSync(newPassword, 10), must_change: false }).eq("student_id", req.user.studentId);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류" }); }
});

// --- 질문 목록 ---
app.get("/api/questions", auth, async (req, res) => {
  try {
    const { data: questions, error } = await supabase.from("questions").select("*").order("id", { ascending: false }).limit(100);
    if (error) throw error;
    const { data: answers } = await supabase.from("answers").select("question_id");
    const counts = {};
    (answers || []).forEach(a => { counts[a.question_id] = (counts[a.question_id] || 0) + 1; });
    res.json((questions || []).map(q => ({ ...q, answer_count: counts[q.id] || 0 })));
  } catch (e) { console.error(e); res.status(500).json({ error: "질문을 불러오지 못했습니다." }); }
});

// --- 질문 작성 ---
app.post("/api/questions", auth, upload.single("image"), async (req, res) => {
  try {
    const { subject, body } = req.body || {};
    if (!subject) return res.status(400).json({ error: "과목을 입력하세요." });
    let imagePath = null;
    if (req.file) {
      const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
      const fileName = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(fileName);
      imagePath = pub.publicUrl;
    }
    const { data, error } = await supabase.from("questions").insert({ student_id: req.user.studentId, subject, body: body || "", image_path: imagePath, created_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "질문 등록에 실패했습니다." }); }
});

// --- 질문 상세 + 답변 ---
app.get("/api/questions/:id", auth, async (req, res) => {
  try {
    const qid = Number(req.params.id);
    const { data: question } = await supabase.from("questions").select("*").eq("id", qid).maybeSingle();
    if (!question) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    const { data: answers } = await supabase.from("answers").select("*").eq("question_id", qid).order("id", { ascending: true });
    res.json({ question, answers: answers || [] });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류" }); }
});

// --- 답변 작성 (사진 첨부 가능) ---
app.post("/api/questions/:id/answers", auth, upload.single("image"), async (req, res) => {
  try {
    const { body } = req.body || {};
    const qid = Number(req.params.id);
    if (!body && !req.file) return res.status(400).json({ error: "답변 내용 또는 사진을 넣어주세요." });
    const { data: q } = await supabase.from("questions").select("id").eq("id", qid).maybeSingle();
    if (!q) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    let imagePath = null;
    if (req.file) {
      const ext = (req.file.originalname.split(".").pop() || "jpg").toLowerCase();
      const fileName = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr } = await supabase.storage.from(PHOTO_BUCKET).upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(fileName);
      imagePath = pub.publicUrl;
    }
    const { data, error } = await supabase.from("answers").insert({ question_id: qid, student_id: req.user.studentId, body: body || "", image_path: imagePath, created_at: new Date().toISOString() }).select().single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (e) { console.error(e); res.status(500).json({ error: "답변 등록에 실패했습니다." }); }
});

// --- 질문 삭제 ---
app.delete("/api/questions/:id", auth, async (req, res) => {
  try {
    const qid = Number(req.params.id);
    const { data: q } = await supabase.from("questions").select("*").eq("id", qid).maybeSingle();
    if (!q) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    if (q.student_id !== req.user.studentId && !isStaffRole(req.user.role)) {
      return res.status(403).json({ error: "본인이 올린 질문만 삭제할 수 있습니다." });
    }
    if (q.image_path) {
      const fileName = q.image_path.split("/").pop();
      if (fileName) await supabase.storage.from(PHOTO_BUCKET).remove([fileName]);
    }
    await supabase.from("answers").delete().eq("question_id", qid);
    await supabase.from("questions").delete().eq("id", qid);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "삭제에 실패했습니다." }); }
});

// --- 답변 삭제 ---
app.delete("/api/answers/:id", auth, async (req, res) => {
  try {
    const aid = Number(req.params.id);
    const { data: a } = await supabase.from("answers").select("*").eq("id", aid).maybeSingle();
    if (!a) return res.status(404).json({ error: "답변을 찾을 수 없습니다." });
    if (a.student_id !== req.user.studentId && !isStaffRole(req.user.role)) {
      return res.status(403).json({ error: "본인이 쓴 답변만 삭제할 수 있습니다." });
    }
    if (a.image_path) {
      const fileName = a.image_path.split("/").pop();
      if (fileName) await supabase.storage.from(PHOTO_BUCKET).remove([fileName]);
    }
    await supabase.from("answers").delete().eq("id", aid);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "삭제에 실패했습니다." }); }
});

// ============================================================
// JaaS (Jitsi) 영상 토큰 발급 + 기기 등록
// ============================================================

// JaaS JWT(입장권) 생성 — RS256, Private Key로 서명
function makeJaasToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const moderator = isStaffRole(user.role); // 관리자/운영자는 moderator 권한
  const payload = {
    aud: "jitsi",
    iss: "chat",
    sub: JAAS_APP_ID,
    room: "*",
    exp: now + 3 * 60 * 60, // 3시간
    nbf: now - 10,
    context: {
      user: {
        id: user.studentId,                 // 학번을 고유 id로
        name: user.nickname || user.studentId,
        avatar: "",
        email: "",
        moderator: moderator ? "true" : "false",
      },
      features: {
        livestreaming: "false",
        recording: "false",
        transcription: "false",
        "outbound-call": "false",
      },
    },
  };
  return jwt.sign(payload, JAAS_PRIVATE_KEY, {
    algorithm: "RS256",
    header: { kid: JAAS_API_KEY, typ: "JWT" },
  });
}

// 기기 식별자 정규화
function cleanDeviceId(d) {
  return String(d || "").trim().slice(0, 64);
}

// --- 캠스터디 입장: 기기 검증 + JaaS 토큰 발급 ---
// body: { deviceId, deviceName }
app.post("/api/study/join", auth, async (req, res) => {
  try {
    if (!JAAS_APP_ID || !JAAS_API_KEY || !JAAS_PRIVATE_KEY) {
      return res.status(500).json({ error: "영상 서버 설정이 아직 안 됐어요. 관리자에게 문의해주세요." });
    }
    const studentId = req.user.studentId;
    const deviceId = cleanDeviceId(req.body && req.body.deviceId);
    const deviceName = String((req.body && req.body.deviceName) || "").slice(0, 40);
    if (!deviceId) return res.status(400).json({ error: "기기 식별 정보가 없습니다." });

    // 이 학번의 등록 기기 목록
    const { data: devices } = await supabase
      .from("devices").select("*").eq("student_id", studentId);
    const list = devices || [];
    const existing = list.find(d => d.device_id === deviceId);

    if (existing) {
      // 이미 등록된 기기 → last_seen 갱신
      await supabase.from("devices").update({ last_seen: new Date().toISOString() }).eq("id", existing.id);
    } else {
      // 새 기기 → 한도 체크
      if (list.length >= MAX_DEVICES_PER_USER) {
        return res.status(403).json({
          error: `등록된 기기가 가득 찼어요 (최대 ${MAX_DEVICES_PER_USER}대). 관리자에게 기기 초기화를 요청하세요.`,
          code: "DEVICE_LIMIT",
        });
      }
      await supabase.from("devices").insert({
        student_id: studentId,
        device_id: deviceId,
        device_name: deviceName || "기기",
        last_seen: new Date().toISOString(),
        created_at: new Date().toISOString(),
      });
    }

    const videoToken = makeJaasToken({
      studentId,
      nickname: req.user.nickname,
      role: req.user.role,
    });
    res.json({
      token: videoToken,
      appId: JAAS_APP_ID,
      room: JAAS_ROOM,
      moderator: isStaffRole(req.user.role),
    });
  } catch (e) { console.error("study/join 오류:", e); res.status(500).json({ error: "입장 처리에 실패했습니다." }); }
});

// --- 내 등록 기기 목록 보기 ---
app.get("/api/study/my-devices", auth, async (req, res) => {
  try {
    const { data } = await supabase.from("devices")
      .select("id, device_name, last_seen, created_at")
      .eq("student_id", req.user.studentId)
      .order("created_at", { ascending: true });
    res.json({ devices: data || [], max: MAX_DEVICES_PER_USER });
  } catch (e) { console.error(e); res.status(500).json({ error: "기기 목록을 불러오지 못했습니다." }); }
});

// ============================================================
// 출석 / 공부시간 / 랭킹
// ============================================================

// 한국 시간(KST) 기준 날짜/주/월 경계 계산
function kstNow() { return new Date(Date.now() + 9 * 3600 * 1000); }
function kstWeekStart() {
  // 이번 주 월요일 0시(KST)의 UTC 시각
  const k = kstNow();
  const day = (k.getUTCDay() + 6) % 7; // 월=0
  const monday = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - day, 0, 0, 0));
  return new Date(monday.getTime() - 9 * 3600 * 1000); // KST→UTC
}
function kstMonthStart() {
  const k = kstNow();
  const first = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1, 0, 0, 0));
  return new Date(first.getTime() - 9 * 3600 * 1000);
}

// 출석 시작 (이미 진행 중이면 그걸 반환)
app.post("/api/attend/start", auth, async (req, res) => {
  try {
    const sid = req.user.studentId;
    // 진행 중인 세션이 있으면 재사용 (중복 방지)
    const { data: act } = await supabase.from("study_sessions")
      .select("*").eq("student_id", sid).eq("active", true).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (act) return res.json({ ok: true, sessionId: act.id, startedAt: act.started_at, resumed: true });
    const { data, error } = await supabase.from("study_sessions").insert({
      student_id: sid, nickname: req.user.nickname || sid,
      started_at: new Date().toISOString(), minutes: 0, active: true,
    }).select().single();
    if (error) throw error;
    res.json({ ok: true, sessionId: data.id, startedAt: data.started_at });
  } catch (e) { console.error("attend/start:", e); res.status(500).json({ error: "출석 처리에 실패했습니다." }); }
});

// 진행 중 갱신 (heartbeat) — 클라이언트가 1분마다 호출, 닫혀도 시간 보존
app.post("/api/attend/heartbeat", auth, async (req, res) => {
  try {
    const sid = req.user.studentId;
    const { data: act } = await supabase.from("study_sessions")
      .select("*").eq("student_id", sid).eq("active", true).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (!act) return res.json({ ok: false, active: false });
    const mins = Math.max(0, Math.floor((Date.now() - new Date(act.started_at).getTime()) / 60000));
    await supabase.from("study_sessions").update({ minutes: mins }).eq("id", act.id);
    res.json({ ok: true, minutes: mins });
  } catch (e) { console.error("attend/heartbeat:", e); res.status(500).json({ error: "갱신 실패" }); }
});

// 출석 종료
app.post("/api/attend/stop", auth, async (req, res) => {
  try {
    const sid = req.user.studentId;
    const { data: act } = await supabase.from("study_sessions")
      .select("*").eq("student_id", sid).eq("active", true).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (!act) return res.json({ ok: true, minutes: 0 });
    const mins = Math.max(0, Math.floor((Date.now() - new Date(act.started_at).getTime()) / 60000));
    await supabase.from("study_sessions").update({
      minutes: mins, ended_at: new Date().toISOString(), active: false,
    }).eq("id", act.id);
    res.json({ ok: true, minutes: mins });
  } catch (e) { console.error("attend/stop:", e); res.status(500).json({ error: "종료 실패" }); }
});

// 내 출석 상태
app.get("/api/attend/status", auth, async (req, res) => {
  try {
    const sid = req.user.studentId;
    const { data: act } = await supabase.from("study_sessions")
      .select("*").eq("student_id", sid).eq("active", true).order("started_at", { ascending: false }).limit(1).maybeSingle();
    if (!act) return res.json({ active: false });
    const mins = Math.max(0, Math.floor((Date.now() - new Date(act.started_at).getTime()) / 60000));
    res.json({ active: true, startedAt: act.started_at, minutes: mins });
  } catch (e) { console.error(e); res.status(500).json({ error: "상태 조회 실패" }); }
});

// 랭킹 (period=week|month) — 누적 공부시간 기준
app.get("/api/ranking", auth, async (req, res) => {
  try {
    const period = req.query.period === "month" ? "month" : "week";
    const since = period === "month" ? kstMonthStart() : kstWeekStart();
    // 기간 내 세션들 합산
    const { data: rows } = await supabase.from("study_sessions")
      .select("student_id, nickname, minutes, started_at, active")
      .gte("started_at", since.toISOString());
    const agg = {};
    (rows || []).forEach(r => {
      let m = r.minutes || 0;
      // 진행 중 세션은 현재까지 시간으로 보정
      if (r.active) m = Math.max(m, Math.floor((Date.now() - new Date(r.started_at).getTime()) / 60000));
      if (!agg[r.student_id]) agg[r.student_id] = { student_id: r.student_id, nickname: r.nickname || r.student_id, minutes: 0 };
      agg[r.student_id].minutes += m;
      if (r.nickname) agg[r.student_id].nickname = r.nickname;
    });
    const list = Object.values(agg).sort((a, b) => b.minutes - a.minutes);
    // 내 순위도 표시용으로
    const myId = req.user.studentId;
    const myRank = list.findIndex(x => x.student_id === myId);
    res.json({
      period,
      ranking: list.slice(0, 50),
      me: { rank: myRank >= 0 ? myRank + 1 : null, minutes: myRank >= 0 ? list[myRank].minutes : 0 },
    });
  } catch (e) { console.error("ranking:", e); res.status(500).json({ error: "랭킹을 불러오지 못했습니다." }); }
});

// ---- 관리자 API ----

// 계정 목록 (+ 기기 수 포함)
app.get("/api/admin/users", auth, requireStaff, async (req, res) => {
  try {
    const { data } = await supabase.from("users").select("student_id, nickname, role, must_change, created_at").order("student_id", { ascending: true });
    const { data: devs } = await supabase.from("devices").select("student_id");
    const devCount = {};
    (devs || []).forEach(d => { devCount[d.student_id] = (devCount[d.student_id] || 0) + 1; });
    const list = (data || []).map(u => ({
      student_id: u.student_id, nickname: u.nickname, role: resolveRole(u),
      must_change: !!u.must_change, created_at: u.created_at,
      device_count: devCount[u.student_id] || 0,
    }));
    res.json(list);
  } catch (e) { console.error(e); res.status(500).json({ error: "계정 목록을 불러오지 못했습니다." }); }
});

// 전체 기기 등록 현황 (관리자) — MAU 한도 관리용
app.get("/api/admin/device-stats", auth, requireStaff, async (req, res) => {
  try {
    const { data: devs } = await supabase.from("devices").select("student_id");
    const total = (devs || []).length;
    const uniqueUsers = new Set((devs || []).map(d => d.student_id)).size;
    res.json({ total, uniqueUsers, limit: JAAS_MAU_LIMIT });
  } catch (e) { console.error(e); res.status(500).json({ error: "기기 현황을 불러오지 못했습니다." }); }
});

// 계정 추가
app.post("/api/admin/users", auth, requireStaff, async (req, res) => {
  try {
    const { studentId, nickname } = req.body || {};
    if (!/^\d{5}$/.test(studentId || "") && studentId !== "teacher") {
      return res.status(400).json({ error: "아이디는 5자리 학번이어야 합니다." });
    }
    const { data: existing } = await supabase.from("users").select("student_id").eq("student_id", studentId).maybeSingle();
    if (existing) return res.status(409).json({ error: "이미 존재하는 계정입니다." });
    await supabase.from("users").insert({ student_id: studentId, password_hash: bcrypt.hashSync(INIT_PASSWORD, 10), nickname: nickname || studentId, must_change: true, role: "student", created_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "계정 추가에 실패했습니다." }); }
});

// 계정 삭제 (기기도 함께 삭제)
app.delete("/api/admin/users/:id", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    if (isOwner(target)) return res.status(403).json({ error: "운영자 계정은 삭제할 수 없습니다." });
    const { data: tu } = await supabase.from("users").select("*").eq("student_id", target).maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    if (resolveRole(tu) === "admin" && req.user.role !== "owner") {
      return res.status(403).json({ error: "관리자 계정은 운영자만 삭제할 수 있습니다." });
    }
    await supabase.from("devices").delete().eq("student_id", target);
    await supabase.from("users").delete().eq("student_id", target);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "계정 삭제에 실패했습니다." }); }
});

// 비밀번호 초기화
app.post("/api/admin/users/:id/reset-password", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    const { data: tu } = await supabase.from("users").select("student_id").eq("student_id", target).maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    await supabase.from("users").update({ password_hash: bcrypt.hashSync(INIT_PASSWORD, 10), must_change: true }).eq("student_id", target);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "비밀번호 초기화에 실패했습니다." }); }
});

// 닉네임(이름) 변경
app.post("/api/admin/users/:id/nickname", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    const { nickname } = req.body || {};
    if (!nickname || nickname.trim().length === 0 || nickname.length > 20) {
      return res.status(400).json({ error: "이름은 1~20자로 입력하세요." });
    }
    const { data: tu } = await supabase.from("users").select("student_id").eq("student_id", target).maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    await supabase.from("users").update({ nickname: nickname.trim() }).eq("student_id", target);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "이름 변경에 실패했습니다." }); }
});

// 관리자 임명/박탈
app.post("/api/admin/users/:id/role", auth, requireOwner, async (req, res) => {
  try {
    const target = req.params.id;
    const { role } = req.body || {};
    if (!["admin", "student"].includes(role)) return res.status(400).json({ error: "잘못된 역할입니다." });
    if (isOwner(target)) return res.status(403).json({ error: "운영자의 역할은 변경할 수 없습니다." });
    const { data: tu } = await supabase.from("users").select("student_id").eq("student_id", target).maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    await supabase.from("users").update({ role }).eq("student_id", target);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "역할 변경에 실패했습니다." }); }
});

// 관리자: 특정 학생 등록 기기 초기화(전부 삭제)
app.delete("/api/admin/users/:id/devices", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    const { data: tu } = await supabase.from("users").select("student_id").eq("student_id", target).maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    await supabase.from("devices").delete().eq("student_id", target);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "기기 초기화에 실패했습니다." }); }
});

// SPA fallback
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

// ---- Socket.IO (채팅 + 인원수 + 관리자 제어) ----
// 영상은 JaaS가 담당. Socket.IO는 채팅/인원수/관리자 신호만.
const ROOM = "main-camstudy";
const participants = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  try { socket.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { next(new Error("인증 실패")); }
});

function broadcastCount() {
  io.to(ROOM).emit("participant-count", participants.size);
  io.to(ROOM).emit("participant-list", [...participants.entries()].map(([id, p]) => ({ id, ...p })));
}

io.on("connection", (socket) => {
  socket.emit("participant-count", participants.size);

  socket.on("join-study", () => {
    // 같은 학번 다른 기기는 채팅방에서 내보냄(1세션)
    for (const [otherId, p] of participants.entries()) {
      if (otherId !== socket.id && p.studentId === socket.user.studentId) {
        const oldSocket = io.sockets.sockets.get(otherId);
        if (oldSocket) { oldSocket.emit("force-leave-study", { reason: "다른 기기에서 입장했어요." }); oldSocket.leave(ROOM); }
        participants.delete(otherId);
      }
    }
    socket.join(ROOM);
    participants.set(socket.id, { studentId: socket.user.studentId, nickname: socket.user.nickname || socket.user.studentId });
    broadcastCount();
    io.to(ROOM).emit("chat", { system: true, text: `${participants.get(socket.id).nickname} 님이 입장했습니다.`, ts: Date.now() });
  });

  socket.on("chat", ({ text }) => {
    const p = participants.get(socket.id);
    if (!p || !text) return;
    io.to(ROOM).emit("chat", { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, studentId: p.studentId, nickname: p.nickname, text: String(text).slice(0, 500), ts: Date.now() });
  });

  socket.on("delete-chat", ({ id }) => {
    if (!isStaffRole(socket.user.role) || !id) return;
    io.to(ROOM).emit("chat-deleted", { id });
  });

  // 관리자: 시스템 공지를 채팅에 표시 (Jitsi 추방/카메라끄기 등 알림용)
  socket.on("system-notice", ({ text }) => {
    if (!isStaffRole(socket.user.role) || !text) return;
    io.to(ROOM).emit("chat", { system: true, text: String(text).slice(0, 200), ts: Date.now() });
  });

  // ── 오목 이스터에그: 신호를 상대에게 중계 (게임 로직은 클라이언트) ──
  // 오목 신청 (학번으로 상대를 찾음)
  socket.on("omok-invite", ({ studentId }) => {
    const target = String(studentId || "").trim();
    if (!target) return socket.emit("omok-notfound", { studentId: target });
    if (target === socket.user.studentId) return socket.emit("omok-notfound", { studentId: target, self: true });
    // 채팅방(캠스터디)에 있는 같은 학번의 소켓 찾기
    let foundId = null;
    for (const [sid, p] of participants.entries()) {
      if (p.studentId === target) { foundId = sid; break; }
    }
    if (!foundId) return socket.emit("omok-notfound", { studentId: target });
    io.to(foundId).emit("omok-invite", { from: socket.id, nickname: socket.user.nickname || socket.user.studentId });
  });
  // 신청 수락 (수락자가 후공=백, 신청자가 선공=흑)
  socket.on("omok-accept", ({ to }) => {
    if (!to) return;
    io.to(to).emit("omok-accept", { from: socket.id, nickname: socket.user.nickname || socket.user.studentId });
  });
  // 신청 거절
  socket.on("omok-decline", ({ to }) => {
    if (!to) return;
    io.to(to).emit("omok-decline", { from: socket.id });
  });
  // 돌 두기
  socket.on("omok-move", ({ to, x, y }) => {
    if (!to) return;
    io.to(to).emit("omok-move", { from: socket.id, x, y });
  });
  // 항복/나가기
  socket.on("omok-resign", ({ to }) => {
    if (!to) return;
    io.to(to).emit("omok-resign", { from: socket.id });
  });

  function leave() {
    const p = participants.get(socket.id);
    if (p) {
      participants.delete(socket.id);
      io.to(ROOM).emit("chat", { system: true, text: `${p.nickname} 님이 퇴장했습니다.`, ts: Date.now() });
      broadcastCount();
    }
  }
  socket.on("leave-study", leave);
  socket.on("disconnect", leave);
});

// ---- 시작 ----
seedClassAccounts().finally(() => {
  server.listen(PORT, () => { console.log(`캠스터디 서버 실행중: http://localhost:${PORT}`); });
});
