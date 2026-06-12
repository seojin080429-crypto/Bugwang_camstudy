/**
 * 캠스터디 + 질문방 서버 (Supabase 영구저장 버전)
 * - Express: 정적 파일 + REST API (로그인/비번변경/질문/답변)
 * - Socket.IO: 캠스터디 입장/퇴장, WebRTC 시그널링(마이크 없이 비디오만), 채팅, 실시간 인원수
 * - Supabase: 계정/질문/답변(DB 테이블) + 질문 사진(Storage 버킷)
 *
 * 필요한 환경변수 (Render의 Environment에 입력):
 *   SUPABASE_URL          예) https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  Supabase 프로젝트의 service_role 키 (비밀!)
 *   JWT_SECRET            아무 긴 랜덤 문자열 (로그인 토큰 서명용)
 */

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

// ---- 역할(권한) 체계 ----
// owner(운영자): 최고권한, 관리자 임명/박탈 가능. 코드로 고정.
// admin(관리자): 운영자가 임명. 채팅/게시물 삭제 + 계정 관리.
// student(학생): 일반.
const OWNER_IDS = ["teacher", "30122"]; // 운영자 고정 (담임 + 제작자 본인)
function isOwner(studentId) {
  return OWNER_IDS.includes(studentId);
}
// 실제 역할 판정: 운영자 고정 목록 우선, 그 외에는 DB의 role 값
function resolveRole(user) {
  if (!user) return "student";
  if (isOwner(user.student_id)) return "owner";
  return user.role === "admin" ? "admin" : "student";
}
// 관리자 이상(운영자 포함)인지
function isStaffRole(role) {
  return role === "owner" || role === "admin";
}

// ---- Supabase 연결 ----
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error(
    "\n[설정 오류] SUPABASE_URL 과 SUPABASE_SERVICE_KEY 환경변수가 필요합니다.\n" +
      "Render의 Environment 또는 로컬 환경변수에 설정해주세요.\n"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---- 학번 검증 / 계정 생성 ----
function isValidStudentId(id) {
  // 학생: 5자리 숫자(예 30101) / 선생님: teacher
  return /^\d{5}$/.test(id) || id === "teacher";
}

async function ensureUser(studentId, nickname) {
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("student_id", studentId)
    .maybeSingle();
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
    const { data: again } = await supabase
      .from("users")
      .select("*")
      .eq("student_id", studentId)
      .maybeSingle();
    return again || newUser;
  }
  return data;
}

async function seedClassAccounts() {
  for (let n = 30101; n <= 30128; n++) {
    try {
      await ensureUser(String(n));
    } catch (e) {
      console.error("계정 시드 오류:", n, e.message);
    }
  }
  // 담임 선생님 계정 (아이디: teacher, 초기비번 1234)
  try {
    await ensureUser("teacher", "이용휘 선생님");
  } catch (e) {
    console.error("선생님 계정 시드 오류:", e.message);
  }
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
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "세션이 만료되었습니다. 다시 로그인하세요." });
  }
}

// --- 로그인 ---
app.post("/api/login", async (req, res) => {
  try {
    const { studentId, password } = req.body || {};
    if (!isValidStudentId(studentId || "")) {
      return res.status(400).json({ error: "학번 형식이 올바르지 않습니다. 예) 30101" });
    }
    const user = await ensureUser(studentId);
    if (!bcrypt.compareSync(password || "", user.password_hash)) {
      return res.status(401).json({ error: "비밀번호가 틀렸습니다." });
    }
    const role = resolveRole(user);
    const token = jwt.sign(
      { studentId, nickname: user.nickname, role },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    res.json({
      token,
      studentId,
      nickname: user.nickname,
      mustChange: !!user.must_change,
      role,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "서버 오류" });
  }
});

// --- 비밀번호 변경 ---
app.post("/api/change-password", auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const { data: user } = await supabase
      .from("users")
      .select("*")
      .eq("student_id", req.user.studentId)
      .maybeSingle();
    if (!user || !bcrypt.compareSync(currentPassword || "", user.password_hash)) {
      return res.status(401).json({ error: "현재 비밀번호가 틀렸습니다." });
    }
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ error: "새 비밀번호는 4자 이상이어야 합니다." });
    }
    await supabase
      .from("users")
      .update({ password_hash: bcrypt.hashSync(newPassword, 10), must_change: false })
      .eq("student_id", req.user.studentId);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "서버 오류" });
  }
});

// --- 닉네임 변경 ---
app.post("/api/nickname", auth, async (req, res) => {
  const { nickname } = req.body || {};
  if (!nickname || nickname.length > 20) return res.status(400).json({ error: "닉네임 오류" });
  await supabase.from("users").update({ nickname }).eq("student_id", req.user.studentId);
  res.json({ ok: true });
});

// --- 질문 목록 ---
app.get("/api/questions", auth, async (req, res) => {
  try {
    const { data: questions, error } = await supabase
      .from("questions")
      .select("*")
      .order("id", { ascending: false })
      .limit(100);
    if (error) throw error;
    const { data: answers } = await supabase.from("answers").select("question_id");
    const counts = {};
    (answers || []).forEach((a) => {
      counts[a.question_id] = (counts[a.question_id] || 0) + 1;
    });
    res.json((questions || []).map((q) => ({ ...q, answer_count: counts[q.id] || 0 })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "질문을 불러오지 못했습니다." });
  }
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
      const { error: upErr } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(fileName);
      imagePath = pub.publicUrl;
    }

    const { data, error } = await supabase
      .from("questions")
      .insert({
        student_id: req.user.studentId,
        subject,
        body: body || "",
        image_path: imagePath,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "질문 등록에 실패했습니다." });
  }
});

// --- 질문 상세 + 답변 ---
app.get("/api/questions/:id", auth, async (req, res) => {
  try {
    const qid = Number(req.params.id);
    const { data: question } = await supabase
      .from("questions")
      .select("*")
      .eq("id", qid)
      .maybeSingle();
    if (!question) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    const { data: answers } = await supabase
      .from("answers")
      .select("*")
      .eq("question_id", qid)
      .order("id", { ascending: true });
    res.json({ question, answers: answers || [] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "서버 오류" });
  }
});

// --- 답변 작성 ---
app.post("/api/questions/:id/answers", auth, async (req, res) => {
  try {
    const { body } = req.body || {};
    if (!body) return res.status(400).json({ error: "답변 내용을 입력하세요." });
    const qid = Number(req.params.id);
    const { data: q } = await supabase.from("questions").select("id").eq("id", qid).maybeSingle();
    if (!q) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    const { data, error } = await supabase
      .from("answers")
      .insert({
        question_id: qid,
        student_id: req.user.studentId,
        body,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ id: data.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "답변 등록에 실패했습니다." });
  }
});

// --- 질문 삭제 (본인 글 또는 관리자) ---
app.delete("/api/questions/:id", auth, async (req, res) => {
  try {
    const qid = Number(req.params.id);
    const { data: q } = await supabase
      .from("questions")
      .select("*")
      .eq("id", qid)
      .maybeSingle();
    if (!q) return res.status(404).json({ error: "질문을 찾을 수 없습니다." });
    if (q.student_id !== req.user.studentId && !isStaffRole(req.user.role)) {
      return res.status(403).json({ error: "본인이 올린 질문만 삭제할 수 있습니다." });
    }
    // 사진이 있으면 Storage에서도 삭제
    if (q.image_path) {
      const fileName = q.image_path.split("/").pop();
      if (fileName) {
        await supabase.storage.from(PHOTO_BUCKET).remove([fileName]);
      }
    }
    // 답변 먼저 삭제 후 질문 삭제 (외래키 cascade가 있어도 안전하게)
    await supabase.from("answers").delete().eq("question_id", qid);
    await supabase.from("questions").delete().eq("id", qid);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "삭제에 실패했습니다." });
  }
});

// --- 답변 삭제 (본인 답변 또는 관리자) ---
app.delete("/api/answers/:id", auth, async (req, res) => {
  try {
    const aid = Number(req.params.id);
    const { data: a } = await supabase
      .from("answers")
      .select("*")
      .eq("id", aid)
      .maybeSingle();
    if (!a) return res.status(404).json({ error: "답변을 찾을 수 없습니다." });
    if (a.student_id !== req.user.studentId && !isStaffRole(req.user.role)) {
      return res.status(403).json({ error: "본인이 쓴 답변만 삭제할 수 있습니다." });
    }
    await supabase.from("answers").delete().eq("id", aid);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "삭제에 실패했습니다." });
  }
});

// ============================================================
// 관리자/운영자 전용 — 계정 관리
// ============================================================
function requireStaff(req, res, next) {
  if (!isStaffRole(req.user.role)) {
    return res.status(403).json({ error: "관리자 권한이 필요합니다." });
  }
  next();
}
function requireOwner(req, res, next) {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "운영자만 가능한 기능입니다." });
  }
  next();
}

// --- 계정 목록 (관리자 이상) ---
app.get("/api/admin/users", auth, requireStaff, async (req, res) => {
  try {
    const { data } = await supabase
      .from("users")
      .select("student_id, nickname, role, must_change, created_at")
      .order("student_id", { ascending: true });
    const list = (data || []).map((u) => ({
      student_id: u.student_id,
      nickname: u.nickname,
      role: resolveRole(u),
      must_change: !!u.must_change,
      created_at: u.created_at,
    }));
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정 목록을 불러오지 못했습니다." });
  }
});

// --- 계정 추가 (관리자 이상) ---
app.post("/api/admin/users", auth, requireStaff, async (req, res) => {
  try {
    const { studentId, nickname } = req.body || {};
    if (!/^\d{5}$/.test(studentId || "") && studentId !== "teacher") {
      return res.status(400).json({ error: "아이디는 5자리 학번이어야 합니다. 예) 30101" });
    }
    const { data: existing } = await supabase
      .from("users")
      .select("student_id")
      .eq("student_id", studentId)
      .maybeSingle();
    if (existing) return res.status(409).json({ error: "이미 존재하는 계정입니다." });
    await supabase.from("users").insert({
      student_id: studentId,
      password_hash: bcrypt.hashSync(INIT_PASSWORD, 10),
      nickname: nickname || studentId,
      must_change: true,
      role: "student",
      created_at: new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정 추가에 실패했습니다." });
  }
});

// --- 계정 삭제/추방 (관리자 이상) ---
app.delete("/api/admin/users/:id", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    if (isOwner(target)) {
      return res.status(403).json({ error: "운영자 계정은 삭제할 수 없습니다." });
    }
    const { data: tu } = await supabase
      .from("users")
      .select("*")
      .eq("student_id", target)
      .maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    if (resolveRole(tu) === "admin" && req.user.role !== "owner") {
      return res.status(403).json({ error: "관리자 계정은 운영자만 삭제할 수 있습니다." });
    }
    await supabase.from("users").delete().eq("student_id", target);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "계정 삭제에 실패했습니다." });
  }
});

// --- 비밀번호 초기화 (관리자 이상) ---
app.post("/api/admin/users/:id/reset-password", auth, requireStaff, async (req, res) => {
  try {
    const target = req.params.id;
    const { data: tu } = await supabase
      .from("users")
      .select("student_id")
      .eq("student_id", target)
      .maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    await supabase
      .from("users")
      .update({ password_hash: bcrypt.hashSync(INIT_PASSWORD, 10), must_change: true })
      .eq("student_id", target);
    res.json({ ok: true, initPassword: INIT_PASSWORD });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "비밀번호 초기화에 실패했습니다." });
  }
});

// --- 관리자 임명/박탈 (운영자 전용) ---
app.post("/api/admin/users/:id/role", auth, requireOwner, async (req, res) => {
  try {
    const target = req.params.id;
    const { role } = req.body || {};
    if (!["admin", "student"].includes(role)) {
      return res.status(400).json({ error: "잘못된 역할입니다." });
    }
    if (isOwner(target)) {
      return res.status(403).json({ error: "운영자의 역할은 변경할 수 없습니다." });
    }
    const { data: tu } = await supabase
      .from("users")
      .select("student_id")
      .eq("student_id", target)
      .maybeSingle();
    if (!tu) return res.status(404).json({ error: "계정을 찾을 수 없습니다." });
    await supabase.from("users").update({ role }).eq("student_id", target);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "역할 변경에 실패했습니다." });
  }
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---- Socket.IO : 캠스터디 ----
const ROOM = "main-camstudy";
const participants = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("인증 실패"));
  }
});

function broadcastCount() {
  io.to(ROOM).emit("participant-count", participants.size);
  io.to(ROOM).emit(
    "participant-list",
    [...participants.entries()].map(([id, p]) => ({ id, ...p }))
  );
}

io.on("connection", (socket) => {
  socket.emit("participant-count", participants.size);

  socket.on("join-study", ({ camOn }) => {
    socket.join(ROOM);
    participants.set(socket.id, {
      studentId: socket.user.studentId,
      nickname: socket.user.nickname || socket.user.studentId,
      camOn: !!camOn,
    });
    const others = [...participants.entries()]
      .filter(([id]) => id !== socket.id)
      .map(([id, p]) => ({ id, ...p }));
    socket.emit("existing-participants", others);
    socket.to(ROOM).emit("user-joined", { id: socket.id, ...participants.get(socket.id) });
    broadcastCount();
    io.to(ROOM).emit("chat", {
      system: true,
      text: `${participants.get(socket.id).nickname} 님이 입장했습니다.`,
      ts: Date.now(),
    });
  });

  socket.on("cam-state", ({ camOn }) => {
    const p = participants.get(socket.id);
    if (p) {
      p.camOn = !!camOn;
      socket.to(ROOM).emit("peer-cam-state", { id: socket.id, camOn: p.camOn });
      broadcastCount();
    }
  });

  socket.on("webrtc-offer", ({ to, sdp }) => io.to(to).emit("webrtc-offer", { from: socket.id, sdp }));
  socket.on("webrtc-answer", ({ to, sdp }) => io.to(to).emit("webrtc-answer", { from: socket.id, sdp }));
  socket.on("webrtc-ice", ({ to, candidate }) => io.to(to).emit("webrtc-ice", { from: socket.id, candidate }));

  socket.on("chat", ({ text }) => {
    const p = participants.get(socket.id);
    if (!p || !text) return;
    io.to(ROOM).emit("chat", {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      studentId: p.studentId,
      nickname: p.nickname,
      text: String(text).slice(0, 500),
      ts: Date.now(),
    });
  });

  // 관리자(선생님)만 채팅 메시지 삭제 가능 → 모두의 화면에서 제거
  socket.on("delete-chat", ({ id }) => {
    if (!isStaffRole(socket.user.role) || !id) return;
    io.to(ROOM).emit("chat-deleted", { id });
  });

  function leave() {
    const p = participants.get(socket.id);
    if (p) {
      participants.delete(socket.id);
      socket.to(ROOM).emit("user-left", { id: socket.id });
      io.to(ROOM).emit("chat", {
        system: true,
        text: `${p.nickname} 님이 퇴장했습니다.`,
        ts: Date.now(),
      });
      broadcastCount();
    }
  }
  socket.on("leave-study", leave);
  socket.on("disconnect", leave);
});

// ---- 시작 ----
seedClassAccounts().finally(() => {
  server.listen(PORT, () => {
    console.log(`캠스터디 서버 실행중: http://localhost:${PORT}`);
  });
});
