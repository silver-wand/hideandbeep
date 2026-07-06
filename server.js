/* ─────────────────────────────────────────────
   인간을 찾아라 — 게임 서버 (Express + Socket.IO)
   서버가 게임 엔진: 방/페이즈/타이머/AI 생성/채점 전부 담당.
   환경변수 ANTHROPIC_API_KEY 가 없으면 "연습 모드"로
   미리 준비된 답변을 사용해 (키 없이도) 테스트 가능.
────────────────────────────────────────────── */
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const FAST = process.env.TEST_FAST === "1";

const TOTAL_ROUNDS = 3;
const ANSWER_SEC = FAST ? 5 : 90;
const TAG_SEC = FAST ? 5 : 120;
const ROOM_TTL_MS = 30 * 60 * 1000;

const NICKS = ["곰돌이", "번개", "달빛", "고구마", "소나기", "치즈"];
const COLORS = ["#8AB4FF", "#F0A6C0", "#8FE0C8", "#C9A6F0", "#F0C98A", "#A6D4F0"];
const PERSONAS = [
  "만사 귀찮은 대학생. 답 짧고 성의없음. ㅇㅇ, ㄴㄴ 자주 씀",
  "텐션 높은 직장인. ㅋㅋㅋ 남발, 야근 얘기 자주 함",
  "츤데레. 퉁명스럽다가 은근 디테일하게 답함",
  "드립 치려는 사람. 가끔 노잼. 자기 드립에 자기가 웃음",
  "소심함. ...을 자주 씀. 가끔 되물음",
  "쿨한 척하는 사람. 다 아는 척하는데 가끔 헛다리",
];
const AI_TELLS = [
  "가끔 문장이 너무 완결됨. 주어와 서술어를 다 갖춰버림",
  "신조어를 살짝 어색하게 씀 (반박자 늦은 유행어)",
  "답변이 미묘하게 정보성임. 안 물어본 디테일을 붙임",
  "감정 표현이 살짝 과함. 리액션이 한 톤 높음",
  "질문의 단어를 그대로 받아서 답하는 버릇",
];
const QUESTIONS = [
  "요즘 뭐가 제일 귀찮아?",
  "라면에 뭐 넣어 먹는 게 최고야?",
  "월요일 아침에 드는 생각 솔직하게",
  "인생에서 제일 돈 아까웠던 소비는?",
  "새벽 3시에 갑자기 먹고 싶은 거?",
  "지금 통장에 100만원 생기면 뭐할래",
  "제일 최근에 현타 온 순간은?",
  "여름 vs 겨울, 하나 골라야 하면?",
  "폰에서 제일 자주 쓰는 앱 뭐야",
  "학교나 회사에서 제일 짜증나는 유형은?",
];
const STUB_ANSWERS = ["ㅋㅋ 몰라 그냥", "음 글쎄...", "아 그거 완전 공감", "출근 자체가 문제 아님?", "배고픈데 이 질문 뭐야 ㅋㅋ", "노코멘트 하겠음"];

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const rid = (n = 12) => crypto.randomBytes(n).toString("base64url").slice(0, n);
const roomCode = () =>
  Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

/* ── Anthropic API ── */
async function callClaude(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

/* ── 방 상태 ── */
const rooms = new Map(); // code → room

function makeRoom(hostToken) {
  return {
    code: null,
    hostToken,
    phase: "lobby", // lobby | q0..q2 | tag | result
    phaseEndsAt: null,
    createdAt: Date.now(),
    lastActive: Date.now(),
    players: new Map(), // token → {nick, name, socketId, connected}
    questions: shuffle(QUESTIONS).slice(0, TOTAL_ROUNDS),
    rounds: [], // {question, entries:[{name,text}]}
    seats: [], // [{nick,color}]
    secret: null, // {aiSeats:[{nick,persona,tell}], roles:{nick:role}}
    answers: {}, // round → {token: text}
    tags: {}, // token → {nick: 'HUMAN'|'AI'}
    result: null,
    timer: null,
    advancing: false,
  };
}

function touch(room) {
  room.lastActive = Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL_MS) {
      clearTimeout(room.timer);
      rooms.delete(code);
    }
  }
}, 60 * 1000);

/* ── 플레이어별로 봐도 되는 것만 보내기 ── */
function snapshotFor(room, token) {
  const p = room.players.get(token);
  return {
    code: room.code,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    isHost: token === room.hostToken,
    myNick: p ? p.nick : null,
    lobby: {
      count: room.players.size,
      names: [...room.players.values()].map((x) => x.name),
    },
    seats: room.seats,
    questions: room.phase === "lobby" ? null : room.questions,
    rounds: room.rounds,
    submittedAnswer:
      room.phase.startsWith("q") &&
      !!(room.answers[Number(room.phase.slice(1))] || {})[token],
    submittedTags: !!room.tags[token],
    result: room.phase === "result" ? room.result : null,
  };
}

function broadcast(room) {
  for (const [token, p] of room.players) {
    if (p.socketId) io.to(p.socketId).emit("state", snapshotFor(room, token));
  }
}

function setPhase(room, phase, seconds) {
  room.phase = phase;
  room.phaseEndsAt = seconds ? Date.now() + seconds * 1000 : null;
  clearTimeout(room.timer);
  if (seconds) room.timer = setTimeout(() => advance(room).catch(console.error), seconds * 1000 + 500);
  broadcast(room);
}

const historyText = (rounds) =>
  rounds
    .map(
      (r, i) => `Q${i + 1}. ${r.question}\n` + r.entries.map((e) => `- ${e.name}: ${e.text}`).join("\n")
    )
    .join("\n\n");

/* ── AI 답변 생성 ── */
async function genAiAnswers(room, roundIdx) {
  const ai = room.secret.aiSeats;
  if (ai.length === 0) return [];
  if (!API_KEY) return ai.map((a) => ({ name: a.nick, text: STUB_ANSWERS[Math.floor(Math.random() * STUB_ANSWERS.length)] }));
  const prompt = `너는 익명 채팅 게임에서 "인간인 척하는 AI 참가자" ${ai.length}명을 동시에 연기한다. 이 방의 다른 참가자들은 진짜 인간이고, 게임이 끝나면 서로 누가 AI인지 태깅한다. 들키면 진다.

너가 연기할 AI 참가자들:
${ai.map((a) => `- ${a.nick}: ${a.persona} / 숨길 수 없는 버릇: ${a.tell}`).join("\n")}

${room.rounds.length ? `지금까지의 대화 (진짜 인간들의 답변 포함):\n${historyText(room.rounds)}\n` : ""}
이번 질문: "${room.questions[roundIdx]}"

지침:
- 진짜 인간처럼: 짧게(5~25자), 오타·ㅋㅋ·줄임말, 성의없음, 가끔 딴소리.
- 방에 있는 진짜 인간들의 말투 수준에 자연스럽게 섞여들 것.
- 각자의 "버릇"은 3라운드 중 한두 번만 미묘하게 새어나올 것.
- 서로 말투가 겹치지 않게, 이전 라운드와 일관성 유지.

JSON만 출력: {"answers":[{"name":"닉네임","text":"답변"}]}`;
  try {
    const parsed = await callClaude(prompt);
    return ai.map((a) => {
      const f = (parsed.answers || []).find((x) => x.name === a.nick);
      return { name: a.nick, text: f ? String(f.text).slice(0, 120) : "ㅇㅇ" };
    });
  } catch (e) {
    console.error("AI answer gen failed:", e.message);
    return ai.map((a) => ({ name: a.nick, text: "ㅋㅋ 패스" }));
  }
}

/* ── AI 판정 생성 (전원 시점으로 요청해 정답 유출 방지) ── */
async function genAiJudgments(room) {
  const ai = room.secret.aiSeats;
  const out = { tags: {}, reasons: {} };
  if (ai.length === 0) return out;
  const nickList = room.seats.map((s) => s.nick);
  if (!API_KEY) {
    for (const a of ai) {
      const t = {};
      for (const n of nickList) if (n !== a.nick) t[n] = Math.random() < 0.5 ? "HUMAN" : "AI";
      out.tags[a.nick] = t;
    }
    return out;
  }
  const prompt = `아래는 익명 채팅 게임의 대화 기록이다. 참가자 6명 중 일부는 인간, 일부는 인간인 척하는 AI다. 몇 명이 무엇인지는 비밀이다.

대화 기록:
${historyText(room.rounds)}

참가자 전원 [${nickList.join(", ")}] 각각의 시점에서, 자신을 제외한 5명을 "인간" 또는 "AI"로 판정하라. 말투·내용·미묘한 어색함을 근거로 진지하게 추리할 것. 그리고 각자 "가장 인간 같다"고 생각한 1명에 대한 이유를 반말로 짧게(15자 내외) 붙여라.

JSON만 출력:
{"judgments":[{"voter":"닉","tags":{"닉":"인간","닉":"AI","닉":"인간","닉":"AI","닉":"인간"},"top":"닉","reason":"이유"}]}
6명 전원 포함.`;
  try {
    const parsed = await callClaude(prompt);
    for (const a of ai) {
      const j = (parsed.judgments || []).find((x) => x.voter === a.nick);
      if (j && j.tags) {
        const t = {};
        for (const [k, v] of Object.entries(j.tags)) {
          if (k !== a.nick && nickList.includes(k)) t[k] = /ai/i.test(String(v)) ? "AI" : "HUMAN";
        }
        out.tags[a.nick] = t;
        if (j.top && j.reason) out.reasons[a.nick] = { top: j.top, reason: String(j.reason).slice(0, 60) };
      }
    }
  } catch (e) {
    console.error("AI judgment failed:", e.message);
  }
  return out;
}

/* ── 페이즈 진행 엔진 ── */
async function advance(room) {
  if (room.advancing) return;
  room.advancing = true;
  try {
    touch(room);
    if (room.phase.startsWith("q")) {
      const r = Number(room.phase.slice(1));
      const ans = room.answers[r] || {};
      const humanEntries = [...room.players.entries()].map(([token, p]) => ({
        name: p.nick,
        text: ans[token] !== undefined ? ans[token] : "…",
      }));
      const aiEntries = await genAiAnswers(room, r);
      room.rounds.push({ question: room.questions[r], entries: shuffle([...humanEntries, ...aiEntries]) });
      if (r + 1 < TOTAL_ROUNDS) setPhase(room, `q${r + 1}`, ANSWER_SEC);
      else setPhase(room, "tag", TAG_SEC);
      return;
    }
    if (room.phase === "tag") {
      const allTags = {};
      for (const [token, p] of room.players) if (room.tags[token]) allTags[p.nick] = room.tags[token];
      const aiJ = await genAiJudgments(room);
      Object.assign(allTags, aiJ.tags);
      const roles = room.secret.roles;
      const scores = {};
      for (const s of room.seats) {
        const mine = allTags[s.nick] || {};
        const targets = room.seats.filter((x) => x.nick !== s.nick);
        const detect = targets.filter((t) => mine[t.nick] === roles[t.nick]).length;
        const voters = room.seats.filter((x) => x.nick !== s.nick && allTags[x.nick]);
        const misled = voters.filter((v) => allTags[v.nick][s.nick] !== roles[s.nick]).length;
        scores[s.nick] = { detect, detectMax: targets.length, misled, misledMax: voters.length };
      }
      room.result = { roles, allTags, reasons: aiJ.reasons, scores };
      setPhase(room, "result", null);
      return;
    }
  } finally {
    room.advancing = false;
  }
}

function maybeAdvanceAnswers(room) {
  if (!room.phase.startsWith("q")) return;
  const r = Number(room.phase.slice(1));
  const ans = room.answers[r] || {};
  const allIn = [...room.players.keys()].every((t) => ans[t] !== undefined);
  if (allIn) advance(room).catch(console.error);
}

function maybeAdvanceTags(room) {
  if (room.phase !== "tag") return;
  const allIn = [...room.players.keys()].every((t) => room.tags[t]);
  if (allIn) advance(room).catch(console.error);
}

/* ── 소켓 ── */
io.on("connection", (socket) => {
  let myToken = null;
  let myCode = null;

  socket.on("create_room", (name, cb) => {
    let code = roomCode();
    while (rooms.has(code)) code = roomCode();
    const token = rid();
    const room = makeRoom(token);
    room.code = code;
    room.players.set(token, { nick: null, name: String(name || "익명").slice(0, 12), socketId: socket.id, connected: true });
    rooms.set(code, room);
    myToken = token;
    myCode = code;
    cb({ ok: true, code, token });
    broadcast(room);
  });

  socket.on("join_room", ({ code, token, name }, cb) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room) return cb({ ok: false, error: "그 코드의 방이 없어요." });
    touch(room);
    /* 재접속: 토큰으로 자리 복구 */
    if (token && room.players.has(token)) {
      const p = room.players.get(token);
      p.socketId = socket.id;
      p.connected = true;
      myToken = token;
      myCode = room.code;
      cb({ ok: true, code: room.code, token });
      socket.emit("state", snapshotFor(room, token));
      return;
    }
    if (room.phase !== "lobby") return cb({ ok: false, error: "이미 시작된 방이에요." });
    if (room.players.size >= 6) return cb({ ok: false, error: "방이 꽉 찼어요 (6명)." });
    const t = rid();
    room.players.set(t, { nick: null, name: String(name || "익명").slice(0, 12), socketId: socket.id, connected: true });
    myToken = t;
    myCode = room.code;
    cb({ ok: true, code: room.code, token: t });
    broadcast(room);
  });

  socket.on("start_game", () => {
    const room = rooms.get(myCode);
    if (!room || myToken !== room.hostToken || room.phase !== "lobby") return;
    touch(room);
    const nicks = shuffle(NICKS);
    const humanTokens = [...room.players.keys()];
    humanTokens.forEach((t, i) => (room.players.get(t).nick = nicks[i]));
    const aiNicks = nicks.slice(humanTokens.length);
    const personas = shuffle(PERSONAS);
    const tells = shuffle(AI_TELLS);
    room.secret = {
      aiSeats: aiNicks.map((nick, i) => ({ nick, persona: personas[i % personas.length], tell: tells[i % tells.length] })),
      roles: Object.fromEntries(nicks.map((n) => [n, aiNicks.includes(n) ? "AI" : "HUMAN"])),
    };
    room.seats = shuffle(nicks.map((nick, i) => ({ nick, color: COLORS[i] })));
    setPhase(room, "q0", ANSWER_SEC);
  });

  socket.on("submit_answer", (text) => {
    const room = rooms.get(myCode);
    if (!room || !room.phase.startsWith("q") || !room.players.has(myToken)) return;
    touch(room);
    const r = Number(room.phase.slice(1));
    room.answers[r] = room.answers[r] || {};
    if (room.answers[r][myToken] !== undefined) return;
    room.answers[r][myToken] = String(text || "").slice(0, 120);
    socket.emit("state", snapshotFor(room, myToken));
    maybeAdvanceAnswers(room);
  });

  socket.on("submit_tags", (tags) => {
    const room = rooms.get(myCode);
    if (!room || room.phase !== "tag" || !room.players.has(myToken) || room.tags[myToken]) return;
    touch(room);
    const myNick = room.players.get(myToken).nick;
    const clean = {};
    for (const s of room.seats) {
      if (s.nick === myNick) continue;
      clean[s.nick] = tags && tags[s.nick] === "AI" ? "AI" : "HUMAN";
    }
    room.tags[myToken] = clean;
    socket.emit("state", snapshotFor(room, myToken));
    maybeAdvanceTags(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(myCode);
    if (!room || !room.players.has(myToken)) return;
    const p = room.players.get(myToken);
    p.connected = false;
    p.socketId = null;
    /* 로비에서 나가면 자리 비움. 게임 중엔 자리 유지(재접속 대기) */
    if (room.phase === "lobby") {
      room.players.delete(myToken);
      if (room.players.size === 0) {
        clearTimeout(room.timer);
        rooms.delete(myCode);
        return;
      }
      if (myToken === room.hostToken) room.hostToken = [...room.players.keys()][0];
      broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`인간을 찾아라 서버 가동: http://localhost:${PORT}`);
  console.log(API_KEY ? "AI 모드: Anthropic API 연결됨" : "연습 모드: ANTHROPIC_API_KEY 미설정 (미리 준비된 답변 사용)");
});
