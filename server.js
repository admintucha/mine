// Tucha Games — сервер «Мины» для Render.
// Игру (позиции мин, открытые клетки) считает этот сервер. Деньги живут в Google Таблице:
// списание/начисление идёт через мост Apps Script (pvp_mines_*) по секрету PVP_SECRET.
//
// Переменные окружения (Render → Environment):
//   BOT_TOKEN   — токен Telegram-бота (тот же, что TELEGRAM_BOT_TOKEN в Apps Script)
//   GAS_URL     — адрес веб-приложения Apps Script (.../exec)
//   PVP_SECRET  — тот же секрет, что в Script Properties
//
// ВАЖНО: запускать ровно ОДИН экземпляр (инстанс) — активные игры хранятся в памяти.
const express = require("express");
const crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const GAS_URL = process.env.GAS_URL || "";
const SECRET = process.env.PVP_SECRET || "";
if (!BOT_TOKEN || !GAS_URL || !SECRET) console.error("⚠️ Задай BOT_TOKEN, GAS_URL, PVP_SECRET в Environment!");

// ---------- настройки игры (как в Apps Script) ----------
const CELLS = 25, MINES_MIN = 1, MINES_MAX = 24;
const MAX_BET = 100, MAX_WIN = 500, RTP = 0.88;
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

function mult(mines, opened) {
  if (opened < 1) return 1;
  let prob = 1;
  for (let j = 0; j < opened; j++) prob *= (CELLS - mines - j) / (CELLS - j);
  return Math.max(1.01, Math.floor((RTP / prob) * 100) / 100);
}
function ladder(mines) {
  const a = [];
  for (let s = 1; s <= CELLS - mines; s++) a.push(mult(mines, s));
  return a;
}
const payoutOf = (g) => Math.min(MAX_WIN, Math.floor(g.bet * mult(g.mines, g.opened.length) * 100) / 100);
const view = (g) => ({ bet: g.bet, mines: g.mines, opened: g.opened, mult: mult(g.mines, g.opened.length), ladder: ladder(g.mines) });

// ---------- Telegram initData ----------
function verifyInitData(initData) {
  if (!initData) throw new Error("Открой игру через Telegram.");
  const p = new URLSearchParams(String(initData));
  const hash = p.get("hash");
  if (!hash) throw new Error("В initData нет hash.");
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Не удалось подтвердить Telegram initData.");
  const authDate = Number(p.get("auth_date") || 0);
  if (!authDate || Date.now() / 1000 - authDate > 86400) throw new Error("Данные Telegram устарели. Перезапусти игру.");
  let user = {};
  try { user = JSON.parse(p.get("user") || "{}"); } catch (e) { throw new Error("Не удалось прочитать Telegram user."); }
  if (!user.id) throw new Error("Нет ID игрока.");
  return String(user.id);
}

// ---------- мост к Apps Script ----------
async function gas(action, payload) {
  const res = await fetch(GAS_URL, { method: "POST", body: JSON.stringify({ action, secret: SECRET, ...payload }), redirect: "follow" });
  let d;
  try { d = await res.json(); } catch (e) { throw new Error("Сервер баланса не ответил. Попробуй ещё раз."); }
  if (!d || d.status !== "success") throw new Error((d && d.message) || "Ошибка сервера баланса.");
  return d;
}

// ---------- игры в памяти + очередь на каждого игрока ----------
const games = new Map();   // userid -> {betId, bet, mines, pos, opened, payout?}
const queues = new Map();  // userid -> Promise
function withUser(uid, fn) {
  const prev = queues.get(uid) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(uid, next.finally(() => { if (queues.get(uid) === next) queues.delete(uid); }));
  return next;
}

// Закрыть игру и начислить выигрыш. Если Apps Script не ответил — игра остаётся,
// выплата повторится (bet_id идемпотентен, второй раз деньги не начислятся).
async function settle(uid, g, payout, extra) {
  g.payout = payout;
  const r = await gas("pvp_mines_credit", { bet_id: g.betId, payout });
  games.delete(uid);
  return { status: "success", payout, balance: r.balance, active: null, ...extra };
}

const handlers = {
  async state(uid) {
    const b = await gas("pvp_mines_balance", { userid: uid });
    const g = games.get(uid);
    return { status: "success", balance: b.balance, max_bet: MAX_BET, max_win: MAX_WIN, enabled: b.enabled !== false, active: g ? view(g) : null };
  },
  async start(uid, d) {
    if (games.has(uid)) throw new Error("У тебя уже есть начатая игра.");
    const mines = Math.floor(Number(d.mines));
    if (!Number.isFinite(mines) || mines < MINES_MIN || mines > MINES_MAX) throw new Error(`Мин от ${MINES_MIN} до ${MINES_MAX}.`);
    const bet = money(d.bet);
    if (!Number.isFinite(bet) || bet < 0.01 || bet > MAX_BET) throw new Error(`Ставка от $0.01 до $${MAX_BET}.`);
    const betId = "mn_" + crypto.randomUUID();
    const r = await gas("pvp_mines_debit", { userid: uid, bet_id: betId, amount: bet });
    const cells = Array.from({ length: CELLS }, (_, i) => i);
    for (let i = cells.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    const g = { betId, bet, mines, pos: cells.slice(0, mines).sort((a, b) => a - b), opened: [] };
    games.set(uid, g);
    return { status: "success", balance: r.balance, active: view(g) };
  },
  async open(uid, d) {
    const g = games.get(uid);
    if (!g) throw new Error("Нет активной игры.");
    if (g.payout !== undefined) return settle(uid, g, g.payout, { mines: g.pos, finished: true, safe: true }); // повтор незавершённой выплаты
    const cell = Number(d.cell);
    if (!Number.isInteger(cell) || cell < 0 || cell >= CELLS) throw new Error("Некорректная клетка.");
    if (g.opened.includes(cell)) return { status: "success", repeat: true, safe: true, cell, active: view(g) };
    if (g.pos.includes(cell)) {
      await settle(uid, g, 0, {});
      return { status: "success", boom: true, cell, mines: g.pos, active: null };
    }
    g.opened.push(cell);
    if (g.opened.length >= CELLS - g.mines || g.bet * mult(g.mines, g.opened.length) >= MAX_WIN) {
      const m = mult(g.mines, g.opened.length);
      const r = await settle(uid, g, payoutOf(g), { mult: m, mines: g.pos, finished: true, safe: true, cell });
      return r;
    }
    return { status: "success", safe: true, cell, active: view(g) };
  },
  async cashout(uid) {
    const g = games.get(uid);
    if (!g) throw new Error("Нет активной игры.");
    if (g.payout === undefined && g.opened.length < 1) throw new Error("Сначала открой хотя бы одну клетку.");
    const m = mult(g.mines, g.opened.length);
    return settle(uid, g, g.payout !== undefined ? g.payout : payoutOf(g), { mult: m, mines: g.pos });
  },
};

// ---------- HTTP ----------
const app = express();
app.use((req, res, next) => {
  res.set({ "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ type: () => true, limit: "20kb" })); // клиент шлёт JSON без Content-Type — принимаем любой

app.get("/", (req, res) => res.json({ ok: true, service: "mines", active_games: games.size }));

app.post("/mines", async (req, res) => {
  try {
    const d = req.body || {};
    const uid = verifyInitData(d.initData);
    const name = String(d.action || "").replace(/^mines_/, "");
    if (!handlers[name]) throw new Error("Неизвестное действие.");
    const out = await withUser(uid, () => handlers[name](uid, d));
    res.json(out);
  } catch (e) {
    res.json({ status: "error", message: String((e && e.message) || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("Mines server on", PORT);
  // Память пуста после запуска → все «висящие» игры мертвы. Возвращаем ставки.
  try { const r = await gas("pvp_mines_recover", {}); console.log("Recovered:", r.refunded); } catch (e) { console.error("Recover failed:", e.message); }
});
