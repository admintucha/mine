






























// =====================================================
// TUCHA MINES — сервер «Мин» для Render (Node 18+, без зависимостей)
// Поля 3×3 / 5×5 / 7×7 / 10×10. Мины и выплаты считает только этот сервер.
// Деньги проходят через мост Google Apps Script (pvp_mines_*), секрет — PVP_SECRET.
//
// Render → Environment:
//   TELEGRAM_BOT_TOKEN, GAS_URL (адрес /exec твоего Apps Script), PVP_SECRET
// Start Command: node server.js
// Чтобы Render не «засыпал», пингуй https://ТВОЙ-СЕРВИС.onrender.com/health раз в 5 минут (UptimeRobot).
// =====================================================
const http = require("http");
const crypto = require("crypto");

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const GAS = process.env.GAS_URL || "";
const SECRET = process.env.PVP_SECRET || "";
const PORT = process.env.PORT || 3000;

const MAX_BET = 100, MAX_WIN = 500, RTP = 0.92;
// min/max мин для каждого размера — должно совпадать с MX_SIZES в index.html
const SIZES = {3: {cells: 9, min: 1, max: 8}, 5: {cells: 25, min: 1, max: 24}, 7: {cells: 49, min: 2, max: 40}, 10: {cells: 100, min: 3, max: 50}};

const games = new Map();      // userid -> игра (в памяти; при перезапуске все ставки возвращаются через pvp_mines_recover)
const queues = new Map();     // userid -> цепочка запросов (один ход за раз)
const failedCloses = [];      // выплаты, которые не дошли до таблицы — повторяем

const money = v => Math.round((Number(v) || 0) * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Telegram initData ----------
function verifyInit(initData) {
  if (!BOT) throw new Error("Сервер не настроен (нет TELEGRAM_BOT_TOKEN).");
  if (!initData) throw new Error("Открой игру через Telegram.");
  const p = new URLSearchParams(initData), hash = p.get("hash");
  if (!hash) throw new Error("В initData нет hash.");
  p.delete("hash");
  const check = [...p.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => k + "=" + v).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT).digest();
  const calc = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (calc !== hash) throw new Error("Не удалось подтвердить Telegram initData.");
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) throw new Error("Данные Telegram устарели. Перезапусти игру.");
  let user = {}; try { user = JSON.parse(p.get("user") || "{}"); } catch (e) {}
  if (!user.id) throw new Error("Нет ID игрока.");
  return String(user.id);
}

// ---------- Мост к Google Apps Script ----------
async function gas(action, body) {
  const res = await fetch(GAS, {method: "POST", redirect: "follow", body: JSON.stringify(Object.assign({action, secret: SECRET}, body || {}))});
  let d; try { d = await res.json(); } catch (e) { throw new Error("Таблица не ответила. Попробуй ещё раз."); }
  if (!d || d.status !== "success") throw new Error((d && d.message) || "Ошибка таблицы.");
  return d;
}
async function closeBet(betId, payout) {
  for (let i = 0; i < 3; i++) { try { return await gas("pvp_mines_credit", {bet_id: betId, payout}); } catch (e) { await sleep(500); } }
  failedCloses.push({betId, payout});
  return null;
}
setInterval(async () => {
  while (failedCloses.length) {
    const f = failedCloses[0];
    try { await gas("pvp_mines_credit", {bet_id: f.betId, payout: f.payout}); failedCloses.shift(); } catch (e) { break; }
  }
}, 30000);

// ---------- Математика ----------
function mult(cells, mines, opened) {
  if (opened < 1) return 1;
  let p = 1;
  for (let j = 0; j < opened; j++) p *= (cells - mines - j) / (cells - j);
  return Math.max(1.01, Math.floor(RTP / p * 100) / 100);
}
function ladder(cells, mines) { const a = []; for (let s = 1; s <= cells - mines; s++) a.push(mult(cells, mines, s)); return a; }
function view(g) { return {bet: g.bet, mines: g.mines, size: g.size, opened: g.opened, mult: mult(g.cells, g.mines, g.opened.length), ladder: ladder(g.cells, g.mines)}; }
function payoutOf(g) { return Math.min(MAX_WIN, Math.floor(g.bet * mult(g.cells, g.mines, g.opened.length) * 100) / 100); }
function placeMines(cells, mines) {
  const a = []; for (let i = 0; i < cells; i++) a.push(i);
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, mines).sort((x, y) => x - y);
}

// ---------- Действия ----------
async function state(uid) {
  const b = await gas("pvp_mines_balance", {userid: uid}), g = games.get(uid);
  return {status: "success", balance: b.balance, max_bet: MAX_BET, max_win: MAX_WIN, enabled: b.enabled, active: g ? view(g) : null};
}
async function start(uid, d) {
  if (games.has(uid)) throw new Error("У тебя уже есть начатая игра.");
  const size = Math.floor(Number(d.size) || 5), S = SIZES[size];
  if (!S) throw new Error("Неизвестный размер поля.");
  const mines = Math.floor(Number(d.mines));
  if (!Number.isFinite(mines) || mines < S.min || mines > S.max) throw new Error("Для поля " + size + "×" + size + " мин от " + S.min + " до " + S.max + ".");
  const bet = money(d.bet);
  if (!Number.isFinite(bet) || bet < 0.01 || bet > MAX_BET) throw new Error("Ставка от $0.01 до $" + MAX_BET + ".");
  const betId = crypto.randomUUID();
  const r = await gas("pvp_mines_debit", {userid: uid, bet_id: betId, amount: bet});
  const g = {betId, bet, size, cells: S.cells, mines, pos: placeMines(S.cells, mines), opened: []};
  games.set(uid, g);
  return {status: "success", balance: r.balance, active: view(g)};
}
async function finish(uid, g) {
  const payout = payoutOf(g), m = mult(g.cells, g.mines, g.opened.length);
  const r = await gas("pvp_mines_credit", {bet_id: g.betId, payout});   // если таблица не ответила — игра остаётся, можно повторить
  games.delete(uid);
  return {payout, mult: m, balance: r.balance};
}
async function open(uid, d) {
  const g = games.get(uid); if (!g) throw new Error("Нет активной игры.");
  const cell = Number(d.cell);
  if (!Number.isInteger(cell) || cell < 0 || cell >= g.cells) throw new Error("Некорректная клетка.");
  if (g.opened.includes(cell)) return {status: "success", repeat: true, safe: true, cell, active: view(g)};
  if (g.pos.includes(cell)) {
    games.delete(uid);
    await closeBet(g.betId, 0);
    return {status: "success", boom: true, cell, mines: g.pos, active: null};
  }
  g.opened.push(cell);
  if (g.opened.length >= g.cells - g.mines || g.bet * mult(g.cells, g.mines, g.opened.length) >= MAX_WIN) {
    let w;
    try { w = await finish(uid, g); } catch (e) { g.opened.pop(); throw e; }
    return {status: "success", safe: true, finished: true, cell, payout: w.payout, mult: w.mult, balance: w.balance, mines: g.pos, active: null};
  }
  return {status: "success", safe: true, cell, active: view(g)};
}
async function cashout(uid) {
  const g = games.get(uid); if (!g) throw new Error("Нет активной игры.");
  if (g.opened.length < 1) throw new Error("Сначала открой хотя бы одну клетку.");
  const w = await finish(uid, g);
  return {status: "success", payout: w.payout, mult: w.mult, balance: w.balance, mines: g.pos, active: null};
}

async function handle(d) {
  const uid = verifyInit(d.initData), a = String(d.action || "");
  const run = async () => {
    if (a === "mines_state") return state(uid);
    if (a === "mines_start") return start(uid, d);
    if (a === "mines_open") return open(uid, d);
    if (a === "mines_cashout") return cashout(uid);
    throw new Error("Неизвестное действие.");
  };
  const prev = queues.get(uid) || Promise.resolve();
  const cur = prev.catch(() => {}).then(run);
  queues.set(uid, cur.catch(() => {}));
  return cur;
}

// ---------- HTTP ----------
const CORS = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type"};
http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.url === "/health" || req.method === "GET") { res.writeHead(200, Object.assign({"Content-Type": "text/plain"}, CORS)); return res.end("ok"); }
  let raw = "";
  req.on("data", c => { raw += c; if (raw.length > 20000) req.destroy(); });
  req.on("end", async () => {
    let out;
    try { out = await handle(JSON.parse(raw || "{}")); }
    catch (e) { out = {status: "error", message: String(e && e.message || e)}; }
    res.writeHead(200, Object.assign({"Content-Type": "application/json"}, CORS));
    res.end(JSON.stringify(out));
  });
}).listen(PORT, async () => {
  console.log("Mines server on :" + PORT);
  // Память пуста → все «открытые» ставки мертвы → вернуть их игрокам
  for (let i = 0; i < 5; i++) { try { const r = await gas("pvp_mines_recover"); console.log("recover:", r.refunded); break; } catch (e) { console.log("recover failed:", e.message); await sleep(3000); } }
});




