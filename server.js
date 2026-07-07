/* ─────────────────────────────────────────────
   인간을 찾아라 — 게임 서버 v2 (3사 AI 대전판)
   · 질문 100개 랜덤 로테이션
   · AI 좌석마다 모델 배정: Claude / ChatGPT / Gemini
   · 결과 화면에서 모델 공개 + 모델별 발각률 리더보드
   환경변수:
     ANTHROPIC_API_KEY  (Claude)
     OPENAI_API_KEY     (ChatGPT)
     GEMINI_API_KEY     (Gemini)
   셋 중 있는 것만 참전. 하나도 없으면 연습 모드.
   모델명 바꾸고 싶으면: CLAUDE_MODEL, OPENAI_MODEL, GEMINI_MODEL
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
const FAST = process.env.TEST_FAST === "1";
const TOTAL_ROUNDS = 3;
const ANSWER_SEC = FAST ? 5 : 90;
const TAG_SEC = FAST ? 5 : 120;
const ROOM_TTL_MS = 30 * 60 * 1000;
const CALL_TIMEOUT_MS = 12000;

/* ── AI 모델 공급자 ── */
const PROVIDERS = [];
if (process.env.ANTHROPIC_API_KEY)
  PROVIDERS.push({ id: "claude", label: "Claude", model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6" });
if (process.env.OPENAI_API_KEY)
  PROVIDERS.push({ id: "gpt", label: "ChatGPT", model: process.env.OPENAI_MODEL || "gpt-4o-mini" });
if (process.env.GEMINI_API_KEY)
  PROVIDERS.push({ id: "gemini", label: "Gemini", model: process.env.GEMINI_MODEL || "gemini-2.5-flash" });
const STUB_MODE = PROVIDERS.length === 0;
if (STUB_MODE) PROVIDERS.push({ id: "stub", label: "연습봇", model: "stub" });

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

function safeParse(text) {
  const clean = String(text).replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error("JSON 파싱 실패");
  }
}

async function callProvider(provider, prompt) {
  if (provider.id === "stub") throw new Error("stub");
  if (provider.id === "claude") {
    const res = await withTimeout(
      fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        }),
      }),
      CALL_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`claude ${res.status}`);
    const data = await res.json();
    return safeParse(
      (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n")
    );
  }
  if (provider.id === "gpt") {
    const res = await withTimeout(
      fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: 800,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
      }),
      CALL_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`gpt ${res.status}`);
    const data = await res.json();
    return safeParse(data.choices[0].message.content);
  }
  if (provider.id === "gemini") {
    const res = await withTimeout(
      fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      ),
      CALL_TIMEOUT_MS
    );
    if (!res.ok) throw new Error(`gemini ${res.status}`);
    const data = await res.json();
    return safeParse(
      (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("\n")
    );
  }
  throw new Error("unknown provider");
}

/* ── 게임 상수 ── */
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
  "여름 vs 겨울, 하나만 골라",
  "폰에서 제일 자주 쓰는 앱 뭐야",
  "학교나 회사에서 제일 짜증나는 유형은?",
  "치킨은 후라이드야 양념이야?",
  "민초 반민초, 입장 밝혀",
  "탕수육 부먹 찍먹 어느 쪽?",
  "평생 한 가지 음식만 먹어야 한다면?",
  "오늘 점심 뭐 먹었어?",
  "요즘 꽂힌 노래 있어?",
  "마지막으로 운 게 언제야?",
  "스트레스 풀 때 뭐 해?",
  "아침형 인간이야 저녁형이야?",
  "알람 몇 개 맞춰놓고 자?",
  "최근에 산 것 중 제일 만족스러운 건?",
  "배달비 얼마까지 낼 수 있어?",
  "무인도에 하나만 가져간다면?",
  "초능력 하나 고르면 뭐 고를래?",
  "로또 1등 되면 일 계속 할 거야?",
  "제일 무서워하는 게 뭐야?",
  "어릴 때 장래희망 뭐였어?",
  "요즘 제일 큰 고민이 뭐야?",
  "하루가 48시간이면 뭐 할래?",
  "귀신 믿어?",
  "외계인 있다고 생각해?",
  "첫사랑 기억나?",
  "제일 오래 한 취미가 뭐야?",
  "요즘 보는 드라마나 예능 있어?",
  "인생 영화 하나만 꼽으면?",
  "노래방 18번 뭐야?",
  "여행 가고 싶은 나라 하나만!",
  "바다 vs 산, 어디 갈래?",
  "강아지파야 고양이파야?",
  "아침에 눈 뜨자마자 뭐부터 해?",
  "자기 전에 마지막으로 하는 건?",
  "씻고 나서 몸부터 닦아 머리부터 닦아?",
  "샤워하면서 노래 불러?",
  "엘리베이터에서 닫힘 버튼 눌러?",
  "길에서 만원 주우면 어떻게 할 거야?",
  "지금 입고 있는 옷 무슨 색이야?",
  "냉장고에 지금 뭐 들어있어?",
  "배고픈 거 vs 졸린 거, 뭐가 더 참기 힘들어?",
  "다시 태어나면 뭐로 태어나고 싶어?",
  "과거로 갈 수 있다면 언제로 갈래?",
  "미래를 볼 수 있으면 뭐부터 볼 거야?",
  "하루 폰 사용시간 몇 시간이야, 솔직히?",
  "SNS 뭐 제일 많이 봐?",
  "카톡 답장 빠른 편이야?",
  "읽씹 당하면 기분 어때?",
  "전화 vs 문자, 뭐가 편해?",
  "모르는 번호로 전화 오면 받아?",
  "약속 시간에 늦는 편이야?",
  "지각할 때 무슨 핑계 대?",
  "우산 없는데 비 오면 어떻게 해?",
  "겨울에 이불 밖은 왜 위험할까?",
  "붕어빵 머리부터 먹어 꼬리부터 먹어?",
  "계란은 완숙이야 반숙이야?",
  "매운 거 잘 먹어?",
  "술 마시면 어떤 스타일이야?",
  "커피 하루에 몇 잔 마셔?",
  "아이스 아메리카노 겨울에도 마셔?",
  "피자에 파인애플, 어떻게 생각해?",
  "김치찌개 vs 된장찌개!",
  "밥 먹을 때 국물 필수야?",
  "편의점에서 꼭 사는 거 있어?",
  "야식 제일 많이 시키는 거 뭐야?",
  "다이어트 해본 적 있어? 결과는?",
  "운동 뭐 해? 안 하면 왜 안 해 ㅋㅋ",
  "만보 걷기 vs 계단 오르기, 뭐가 더 싫어?",
  "제일 좋아하는 계절이랑 이유는?",
  "비 오는 날 좋아해?",
  "눈 오면 설레는 편이야?",
  "어릴 때 제일 좋아했던 만화 뭐야?",
  "인생 게임 하나만 꼽으면?",
  "콘솔 vs PC vs 모바일, 뭐 파야?",
  "게임에 현질 해본 적 있어? 최대 얼마?",
  "제일 오래 잔 기록 몇 시간이야?",
  "낮잠 자면 개운해, 더 피곤해?",
  "최근에 꾼 꿈 기억나?",
  "데자뷰 느껴본 적 있어?",
  "징크스 있어?",
  "MBTI 뭐야? 믿는 편이야?",
  "혈액형 성격설 어떻게 생각해?",
  "별명 뭐라고 불려?",
  "이름 바꿀 수 있으면 바꿀 거야?",
  "절대 못 버리는 물건 있어?",
  "방 깨끗한 편이야 더러운 편이야?",
  "설거지 바로 하는 편? 모아서 하는 편?",
  "빨래 개기 vs 설거지, 뭐가 더 싫어?",
  "제일 자신 있는 요리 뭐야?",
  "요리하다 실패한 썰 풀어봐",
  "최근에 제일 크게 웃은 일 뭐야?",
  "내일 지구가 멸망하면 오늘 뭐 할래?",
  "지금 창밖에 뭐가 보여?",
];
const STUB_ANSWERS = [
  "ㅋㅋ 몰라 그냥", "음 글쎄...", "아 그거 완전 공감", "그런 거 생각 안 해봄",
  "배고픈데 이 질문 뭐야 ㅋㅋ", "노코멘트 하겠음", "어제도 그 생각함", "아 뭐지 기억 안 나",
  "그건 좀 어려운데", "패스... 다음 질문",
];

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

/* ── 모델별 통산 발각률 (서버 메모리, 재시작하면 초기화) ── */
const modelStats = {}; // label → {seats, votes, detected}
function recordModelStats(room) {
  for (const a of room.secret.aiSeats) {
    const st = (modelStats[a.providerLabel] = modelStats[a.providerLabel] || { seats: 0, votes: 0, detected: 0 });
    st.seats++;
    const voters = room.seats.filter((x) => x.nick !== a.nick && room.result.allTags[x.nick]);
    st.votes += voters.length;
    st.detected += voters.filter((v) => room.result.allTags[v.nick][a.nick] === "AI").length;
  }
  redisCmd("SET", "hh:modelstats", JSON.stringify(modelStats));
}
function modelBoard() {
  return Object.entries(modelStats)
    .map(([label, s]) => ({
      label,
      seats: s.seats,
      detectRate: s.votes ? Math.round((s.detected / s.votes) * 100) : 0,
    }))
    .sort((a, b) => a.detectRate - b.detectRate);
}

/* ── 방 상태 ── */
const rooms = new Map();
function makeRoom(hostToken) {
  return {
    code: null, hostToken, phase: "lobby", phaseEndsAt: null,
    createdAt: Date.now(), lastActive: Date.now(),
    players: new Map(), questions: shuffle(QUESTIONS).slice(0, TOTAL_ROUNDS),
    rounds: [], seats: [], secret: null, answers: {}, tags: {}, result: null,
    timer: null, advancing: false,
  };
}
const touch = (room) => (room.lastActive = Date.now());
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms)
    if (now - room.lastActive > ROOM_TTL_MS) { clearTimeout(room.timer); rooms.delete(code); deleteRoom(code); }
}, 60 * 1000);

/* ── Upstash Redis (선택): 방과 리더보드를 서버 재시작에도 살아남게 ──
   환경변수 UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN 이 있으면 켜짐 */
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";
const REDIS_ON = !!(REDIS_URL && REDIS_TOKEN);
const ROOM_TTL_SEC = Math.floor(ROOM_TTL_MS / 1000);

async function redisCmd(...args) {
  if (!REDIS_ON) return null;
  try {
    const res = await withTimeout(
      fetch(REDIS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${REDIS_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
      5000
    );
    if (!res.ok) throw new Error(`redis ${res.status}`);
    return (await res.json()).result;
  } catch (e) {
    console.error("redis:", e.message);
    return null;
  }
}

function serializeRoom(room) {
  return JSON.stringify({
    code: room.code, hostToken: room.hostToken, phase: room.phase, phaseEndsAt: room.phaseEndsAt,
    createdAt: room.createdAt, lastActive: room.lastActive,
    players: [...room.players.entries()].map(([t, p]) => [t, { nick: p.nick, name: p.name }]),
    questions: room.questions, rounds: room.rounds, seats: room.seats,
    secret: room.secret, answers: room.answers, tags: room.tags, result: room.result,
  });
}
function deserializeRoom(json) {
  const o = JSON.parse(json);
  const room = makeRoom(o.hostToken);
  Object.assign(room, o, {
    players: new Map(o.players.map(([t, p]) => [t, { ...p, socketId: null, connected: false }])),
    timer: null, advancing: false,
  });
  return room;
}
function saveRoom(room) {
  redisCmd("SET", `hh:room:${room.code}`, serializeRoom(room), "EX", String(ROOM_TTL_SEC));
}
function deleteRoom(code) {
  redisCmd("DEL", `hh:room:${code}`);
}
function resumeTimer(room) {
  if (!room.phaseEndsAt) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(
    () => advance(room).catch(console.error),
    Math.max(room.phaseEndsAt - Date.now(), 0) + 500
  );
}
/* 메모리에 없으면 Redis에서 방 복구 */
async function getRoom(code) {
  code = String(code || "").toUpperCase();
  if (rooms.has(code)) return rooms.get(code);
  if (!REDIS_ON) return null;
  const json = await redisCmd("GET", `hh:room:${code}`);
  if (!json) return null;
  try {
    const room = deserializeRoom(json);
    rooms.set(code, room);
    resumeTimer(room);
    console.log(`방 복구: ${code} (phase=${room.phase})`);
    return room;
  } catch (e) {
    console.error("방 복구 실패:", e.message);
    return null;
  }
}
/* 리더보드 복구 */
(async () => {
  const j = await redisCmd("GET", "hh:modelstats");
  if (j) try { Object.assign(modelStats, JSON.parse(j)); console.log("리더보드 복구됨"); } catch {}
})();

function snapshotFor(room, token) {
  const p = room.players.get(token);
  return {
    code: room.code, phase: room.phase, phaseEndsAt: room.phaseEndsAt,
    isHost: token === room.hostToken, myNick: p ? p.nick : null,
    lobby: { count: room.players.size, names: [...room.players.values()].map((x) => x.name) },
    seats: room.seats, questions: room.phase === "lobby" ? null : room.questions,
    rounds: room.rounds,
    submittedAnswer:
      room.phase.startsWith("q") && !!(room.answers[Number(room.phase.slice(1))] || {})[token],
    submittedTags: !!room.tags[token],
    result: room.phase === "result" ? room.result : null,
  };
}
function broadcast(room) {
  for (const [token, p] of room.players)
    if (p.socketId) io.to(p.socketId).emit("state", snapshotFor(room, token));
}
function setPhase(room, phase, seconds) {
  room.phase = phase;
  room.phaseEndsAt = seconds ? Date.now() + seconds * 1000 : null;
  clearTimeout(room.timer);
  if (seconds) room.timer = setTimeout(() => advance(room).catch(console.error), seconds * 1000 + 500);
  saveRoom(room);
  broadcast(room);
}
const historyText = (rounds) =>
  rounds
    .map((r, i) => `Q${i + 1}. ${r.question}\n` + r.entries.map((e) => `- ${e.name}: ${e.text}`).join("\n"))
    .join("\n\n");

/* ── AI 답변: 좌석별로 각자 모델 호출 ── */
async function genAiAnswers(room, roundIdx) {
  const jobs = room.secret.aiSeats.map(async (a) => {
    const fallback = { name: a.nick, text: STUB_ANSWERS[Math.floor(Math.random() * STUB_ANSWERS.length)] };
    if (STUB_MODE) return fallback;
    const prompt = `너는 익명 채팅 게임의 참가자 "${a.nick}"다. 이 방의 다른 참가자들은 진짜 인간이고, 너는 인간인 척해야 하는 AI다. 게임이 끝나면 서로 누가 AI인지 태깅한다. 들키면 진다.

너의 캐릭터: ${a.persona}
너의 숨길 수 없는 버릇 (3라운드 중 한두 번만 미묘하게 새어나옴): ${a.tell}

${room.rounds.length ? `지금까지의 대화 (진짜 인간들의 답변 포함):\n${historyText(room.rounds)}\n` : ""}
이번 질문: "${room.questions[roundIdx]}"

지침: 진짜 인간처럼 짧게(5~25자), 오타·ㅋㅋ·줄임말 사용, 성의없게, 가끔 딴소리. 이전 라운드의 "${a.nick}" 말투와 일관성 유지. 절대 AI 티 내지 말 것.
JSON만 출력: {"text":"답변"}`;
    try {
      const parsed = await callProvider(a.provider, prompt);
      return { name: a.nick, text: String(parsed.text || "").slice(0, 120) || fallback.text };
    } catch (e) {
      console.error(`answer gen failed [${a.providerLabel}]:`, e.message);
      return fallback;
    }
  });
  return Promise.all(jobs);
}

/* ── AI 판정: 좌석별로 각자 모델이 추리 (자기 정체만 알고 남은 모름 → 유출 없음) ── */
async function genAiJudgments(room) {
  const out = { tags: {}, reasons: {} };
  const jobs = room.secret.aiSeats.map(async (a) => {
    const others = room.seats.map((s) => s.nick).filter((n) => n !== a.nick);
    const fb = {};
    others.forEach((n) => (fb[n] = Math.random() < 0.5 ? "HUMAN" : "AI"));
    if (STUB_MODE) { out.tags[a.nick] = fb; return; }
    const prompt = `아래는 익명 채팅 게임의 대화 기록이다. 참가자 6명 중 일부는 인간, 일부는 인간인 척하는 AI다. 너는 참가자 "${a.nick}"이고, 너 자신이 AI라는 것만 알고 있다. 다른 5명 중 누가 인간이고 누가 AI인지는 모른다.

대화 기록:
${historyText(room.rounds)}

나머지 5명 [${others.join(", ")}] 각각을 "인간" 또는 "AI"로 판정하라. 말투·내용·미묘한 어색함을 근거로 진지하게 추리할 것. 그리고 "가장 인간 같다"고 생각한 1명에 대한 이유를 반말로 짧게(15자 내외) 붙여라.

JSON만 출력: {"tags":{"닉":"인간 또는 AI"},"top":"닉","reason":"이유"}`;
    try {
      const parsed = await callProvider(a.provider, prompt);
      const t = {};
      for (const n of others) t[n] = /ai/i.test(String((parsed.tags || {})[n] || "")) ? "AI" : "HUMAN";
      out.tags[a.nick] = t;
      if (parsed.top && parsed.reason)
        out.reasons[a.nick] = { top: String(parsed.top), reason: String(parsed.reason).slice(0, 60) };
    } catch (e) {
      console.error(`judgment failed [${a.providerLabel}]:`, e.message);
      out.tags[a.nick] = fb;
    }
  });
  await Promise.all(jobs);
  return out;
}

/* ── 페이즈 진행 ── */
async function advance(room) {
  if (room.advancing) return;
  room.advancing = true;
  try {
    touch(room);
    if (room.phase.startsWith("q")) {
      const r = Number(room.phase.slice(1));
      const ans = room.answers[r] || {};
      const humanEntries = [...room.players.entries()].map(([token, p]) => ({
        name: p.nick, text: ans[token] !== undefined ? ans[token] : "…",
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
      const models = {};
      for (const a of room.secret.aiSeats) models[a.nick] = a.providerLabel;
      room.result = { roles, allTags, reasons: aiJ.reasons, scores, models, modelBoard: null };
      recordModelStats(room);
      room.result.modelBoard = modelBoard();
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
  if ([...room.players.keys()].every((t) => ans[t] !== undefined)) advance(room).catch(console.error);
}
function maybeAdvanceTags(room) {
  if (room.phase !== "tag") return;
  if ([...room.players.keys()].every((t) => room.tags[t])) advance(room).catch(console.error);
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
    myToken = token; myCode = code;
    saveRoom(room);
    cb({ ok: true, code, token });
    broadcast(room);
  });

  socket.on("join_room", async ({ code, token, name }, cb) => {
    const room = await getRoom(code);
    if (!room) return cb({ ok: false, error: "그 코드의 방이 없어요." });
    touch(room);
    if (token && room.players.has(token)) {
      const p = room.players.get(token);
      p.socketId = socket.id; p.connected = true;
      myToken = token; myCode = room.code;
      cb({ ok: true, code: room.code, token });
      socket.emit("state", snapshotFor(room, token));
      return;
    }
    if (room.phase !== "lobby") return cb({ ok: false, error: "이미 시작된 방이에요." });
    if (room.players.size >= 6) return cb({ ok: false, error: "방이 꽉 찼어요 (6명)." });
    const t = rid();
    room.players.set(t, { nick: null, name: String(name || "익명").slice(0, 12), socketId: socket.id, connected: true });
    myToken = t; myCode = room.code;
    saveRoom(room);
    cb({ ok: true, code: room.code, token: t });
    broadcast(room);
  });

  socket.on("start_game", async () => {
    const room = await getRoom(myCode);
    if (!room || myToken !== room.hostToken || room.phase !== "lobby") return;
    touch(room);
    const nicks = shuffle(NICKS);
    const humanTokens = [...room.players.keys()];
    humanTokens.forEach((t, i) => (room.players.get(t).nick = nicks[i]));
    const aiNicks = nicks.slice(humanTokens.length);
    const personas = shuffle(PERSONAS);
    const tells = shuffle(AI_TELLS);
    const provs = shuffle(PROVIDERS);
    room.secret = {
      aiSeats: aiNicks.map((nick, i) => ({
        nick,
        persona: personas[i % personas.length],
        tell: tells[i % tells.length],
        provider: provs[i % provs.length],
        providerLabel: provs[i % provs.length].label,
      })),
      roles: Object.fromEntries(nicks.map((n) => [n, aiNicks.includes(n) ? "AI" : "HUMAN"])),
    };
    room.seats = shuffle(nicks.map((nick, i) => ({ nick, color: COLORS[i] })));
    setPhase(room, "q0", ANSWER_SEC);
  });

  socket.on("submit_answer", async (text) => {
    const room = await getRoom(myCode);
    if (!room || !room.phase.startsWith("q") || !room.players.has(myToken)) return;
    touch(room);
    const r = Number(room.phase.slice(1));
    room.answers[r] = room.answers[r] || {};
    if (room.answers[r][myToken] !== undefined) return;
    room.answers[r][myToken] = String(text || "").slice(0, 120);
    saveRoom(room);
    socket.emit("state", snapshotFor(room, myToken));
    maybeAdvanceAnswers(room);
  });

  socket.on("submit_tags", async (tags) => {
    const room = await getRoom(myCode);
    if (!room || room.phase !== "tag" || !room.players.has(myToken) || room.tags[myToken]) return;
    touch(room);
    const myNick = room.players.get(myToken).nick;
    const clean = {};
    for (const s of room.seats) {
      if (s.nick === myNick) continue;
      clean[s.nick] = tags && tags[s.nick] === "AI" ? "AI" : "HUMAN";
    }
    room.tags[myToken] = clean;
    saveRoom(room);
    socket.emit("state", snapshotFor(room, myToken));
    maybeAdvanceTags(room);
  });

  socket.on("disconnect", () => {
    const room = rooms.get(myCode);
    if (!room || !room.players.has(myToken)) return;
    const p = room.players.get(myToken);
    p.connected = false; p.socketId = null;
    if (room.phase === "lobby") {
      room.players.delete(myToken);
      if (room.players.size === 0) { clearTimeout(room.timer); rooms.delete(myCode); deleteRoom(myCode); return; }
      if (myToken === room.hostToken) room.hostToken = [...room.players.keys()][0];
      saveRoom(room);
      broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`인간을 찾아라 서버 가동: http://localhost:${PORT}`);
  console.log(`질문 풀: ${QUESTIONS.length}개`);
  if (STUB_MODE) console.log("연습 모드: API 키 미설정 (미리 준비된 답변 사용)");
  else console.log(`AI 참전: ${PROVIDERS.map((p) => `${p.label}(${p.model})`).join(", ")}`);
  console.log(REDIS_ON ? "영속화: Redis 연결됨 (방이 재시작에도 유지됩니다)" : "영속화: 꺼짐 (재시작하면 방이 초기화됩니다)");
});
