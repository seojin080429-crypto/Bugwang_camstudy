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
    const token = jwt.sign({ studentId, nickname: user.nickname, role }, JWT_SECRET, { expiresIn: "12h" });
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
    // 내용이나 사진 중 하나는 있어야 함
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
    // 사진이 있으면 Storage에서도 삭제
    if (a.image_path) {
      const fileName = a.image_path.split("/").pop();
      if (fileName) await supabase.storage.from(PHOTO_BUCKET).remove([fileName]);
    }
    await supabase.from("answers").delete().eq("id", aid);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "삭제에 실패했습니다." }); }
});

// ---- 관리자 API ----

// 계정 목록
app.get("/api/admin/users", auth, requireStaff, async (req, res) => {
  try {
    const { data } = await supabase.from("users").select("student_id, nickname, role, must_change, created_at").order("student_id", { ascending: true });
    const list = (data || []).map(u => ({ student_id: u.student_id, nickname: u.nickname, role: resolveRole(u), must_change: !!u.must_change, created_at: u.created_at }));
    res.json(list);
  } catch (e) { console.error(e); res.status(500).json({ error: "계정 목록을 불러오지 못했습니다." }); }
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

// 계정 삭제
app.delete("/api/admin/users/:id", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    if (isOwner(target)) return res.status(403).json({ error: "운영자 계정은 삭제할 수 없습니다." });
    const { data: tu } = await supabase.from("users").select("*").eq("student_id", target).maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    if (resolveRole(tu) === "admin" && req.user.role !== "owner") {
      return res.status(403).json({ error: "관리자 계정은 운영자만 삭제할 수 있습니다." });
    }
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

// 닉네임(이름) 변경 - 관리자가 학생 이름 수정
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

// SPA fallback
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

// ---- Socket.IO ----
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

  socket.on("join-study", ({ camOn }) => {
    // ── 같은 학번이 다른 기기로 이미 방에 있으면 그 기기를 내보냄 (1인 1기기) ──
    for (const [otherId, p] of participants.entries()) {
      if (otherId !== socket.id && p.studentId === socket.user.studentId) {
        const oldSocket = io.sockets.sockets.get(otherId);
        // 기존 기기에 알림 후 방에서 제거
        if (oldSocket) {
          oldSocket.emit("force-leave-study", { reason: "다른 기기에서 캠스터디에 입장했어요." });
          oldSocket.leave(ROOM);
        }
        participants.delete(otherId);
        socket.to(ROOM).emit("user-left", { id: otherId });
      }
    }

    socket.join(ROOM);
    participants.set(socket.id, { studentId: socket.user.studentId, nickname: socket.user.nickname || socket.user.studentId, camOn: !!camOn });
    const others = [...participants.entries()].filter(([id]) => id !== socket.id).map(([id, p]) => ({ id, ...p }));
    socket.emit("existing-participants", others);
    socket.to(ROOM).emit("user-joined", { id: socket.id, ...participants.get(socket.id) });
    broadcastCount();
    io.to(ROOM).emit("chat", { system: true, text: `${participants.get(socket.id).nickname} 님이 입장했습니다.`, ts: Date.now() });
  });

  socket.on("cam-state", ({ camOn }) => {
    const p = participants.get(socket.id);
    if (p) { p.camOn = !!camOn; socket.to(ROOM).emit("peer-cam-state", { id: socket.id, camOn: p.camOn }); broadcastCount(); }
  });

  socket.on("webrtc-offer", ({ to, sdp }) => io.to(to).emit("webrtc-offer", { from: socket.id, sdp }));
  socket.on("webrtc-answer", ({ to, sdp }) => io.to(to).emit("webrtc-answer", { from: socket.id, sdp }));
  socket.on("webrtc-ice", ({ to, candidate }) => io.to(to).emit("webrtc-ice", { from: socket.id, candidate }));

  socket.on("chat", ({ text }) => {
    const p = participants.get(socket.id);
    if (!p || !text) return;
    io.to(ROOM).emit("chat", { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, studentId: p.studentId, nickname: p.nickname, text: String(text).slice(0, 500), ts: Date.now() });
  });

  socket.on("delete-chat", ({ id }) => {
    if (!isStaffRole(socket.user.role) || !id) return;
    io.to(ROOM).emit("chat-deleted", { id });
  });

  // ── 관리자: 특정 참가자 카메라 강제 끄기 ──
  socket.on("admin-mute-cam", ({ targetId }) => {
    if (!isStaffRole(socket.user.role) || !targetId) return;
    const target = participants.get(targetId);
    if (!target) return;
    // 대상 본인에게 카메라 끄라고 지시
    io.to(targetId).emit("force-cam-off", { by: socket.user.nickname || socket.user.studentId });
    // 참가자 상태도 즉시 반영 + 모두에게 알림
    target.camOn = false;
    io.to(ROOM).emit("peer-cam-state", { id: targetId, camOn: false });
    io.to(ROOM).emit("chat", { system: true, text: `${target.nickname} 님의 카메라가 관리자에 의해 꺼졌습니다.`, ts: Date.now() });
    broadcastCount();
  });

  // ── 관리자: 특정 참가자를 캠스터디에서 추방 ──
  socket.on("admin-kick-study", ({ targetId }) => {
    if (!isStaffRole(socket.user.role) || !targetId) return;
    const target = participants.get(targetId);
    if (!target) return;
    // 운영자는 추방 불가
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket && OWNER_IDS.includes(targetSocket.user.studentId)) {
      io.to(socket.id).emit("admin-action-denied", { reason: "운영자는 추방할 수 없습니다." });
      return;
    }
    // 대상에게 추방 통지 후 방에서 제거
    if (targetSocket) {
      targetSocket.emit("kicked-from-study", { by: socket.user.nickname || socket.user.studentId });
      targetSocket.leave(ROOM);
    }
    participants.delete(targetId);
    socket.to(ROOM).emit("user-left", { id: targetId });
    io.to(ROOM).emit("chat", { system: true, text: `${target.nickname} 님이 관리자에 의해 캠스터디에서 내보내졌습니다.`, ts: Date.now() });
    broadcastCount();
  });

  function leave() {
    const p = participants.get(socket.id);
    if (p) {
      participants.delete(socket.id);
      socket.to(ROOM).emit("user-left", { id: socket.id });
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
