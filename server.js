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
  return /^\d{5}$/.test(id);
}

async function ensureUser(studentId) {
  const { data: existing } = await supabase
    .from("users")
    .select("*")
    .eq("student_id", studentId)
    .maybeSingle();
  if (existing) return existing;

  const newUser = {
    student_id: studentId,
    password_hash: bcrypt.hashSync(INIT_PASSWORD, 10),
    nickname: studentId,
    must_change: true,
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
  console.log("우리 반 계정(30101~30128) 준비 완료");
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
    const token = jwt.sign({ studentId, nickname: user.nickname }, JWT_SECRET, {
      expiresIn: "12h",
    });
    res.json({ token, studentId, nickname: user.nickname, mustChange: !!user.must_change });
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
      studentId: p.studentId,
      nickname: p.nickname,
      text: String(text).slice(0, 500),
      ts: Date.now(),
    });
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
