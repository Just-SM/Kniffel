'use strict';

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const rules = require('./rules');
const { buildPage } = require('./page');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const SEATS = MAX_PLAYERS;

const app = express();
app.use(express.json({ limit: '8kb' }));

// Single inlined page + build guard (no subresource requests, nothing left
// for adblock filter lists to block).
// Rebuilt on every request so file edits show after a plain reload — no
// server restart needed while iterating on public/ assets.
function freshPage() {
  let page;
  try {
    page = buildPage();
  } catch (e) {
    console.error('page build failed:', e.message);
    return null;
  }
  if (/__[A-Z_]+__/.test(page)) {
    console.error('FATAL: index.html contains unresolved placeholders (e.g. __SHEET_JS__).');
    console.error('Copy of the broken page saved to debug-broken-page.html');
    require('fs').writeFileSync('debug-broken-page.html', page);
    process.exit(1);
  }
  return page;
}

function newId() {
  return require('crypto').randomBytes(8).toString('hex');
}

// Simple cookie identity so every device keeps its seat across reloads.
function identity(req, res, next) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)kid=([^;]+)/);
  // One id used for BOTH the cookie and req.kid, so the seat created by
  // this request's handler always matches what the device will send later.
  const kid = m ? m[1] : newId();
  req.kid = kid;
  res.cookie('kid', kid, { maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  next();
}

// Single room, exists for the whole process lifetime.
const game = {
  started: false,
  config: { enforceTurns: false, oneDevice: false },
  turnId: null, // player id whose move it is (only used when enforceTurns)
  players: [], // { id, kid, seat, name, sheet, lastSeen }
  log: [], // scoring events of the current game, in move order
  archived: false, // current game captured into `past` already?
  deviceActive: {}, // kid -> player id being viewed/scored on that device
};

// Archive of played games: persisted to data/games.json so history and the
// leaderboard survive restarts. In-memory copy plus a dirty flag; saves are
// debounced through setImmediate-ish microtask batching below.
const _db = store.load();
const past = _db.games; // { no, t, finished, winner, players[], log[] }
let gameNo = past.reduce((a, g) => Math.max(a, g.no), 0);
let pastDirty = false;

function flushPast() {
  if (!pastDirty) return;
  pastDirty = false;
  store.save({ version: 1, games: past });
}
function markPast() {
  pastDirty = true;
  setTimeout(flushPast, 500); // debounce bursts of writes
}

function archiveGame() {
  if (!game.started || game.log.length === 0) return;
  gameNo += 1;
  const finished = game.players.length > 0 && game.players.every((p) => rules.isFinished(p.sheet));
  const players = bySeat().map((p) => ({ name: p.name, seat: p.seat, totals: rules.computeTotals(p.sheet) }));
  const winner = finished
    ? players.slice().sort((a, b) => b.totals.grand - a.totals.grand)[0].name
    : null;
  past.push({ no: gameNo, t: Date.now(), finished, winner, players, log: game.log.slice() });
  if (past.length > 500) past.shift();
  markPast();
}

function leaderboard() {
  const m = new Map();
  for (const g of past) {
    if (!g.finished) continue;
    const best = Math.max(...g.players.map((p) => p.totals.grand));
    for (const p of g.players) {
      const e = m.get(p.name) || { name: p.name, g: 0, w: 0, best: 0, sum: 0 };
      e.g += 1;
      e.sum += p.totals.grand;
      if (p.totals.grand === best) e.w += 1;
      if (p.totals.grand > e.best) e.best = p.totals.grand;
      m.set(p.name, e);
    }
  }
  return [...m.values()]
    .map((e) => ({ name: e.name, g: e.g, w: e.w, best: e.best, avg: Math.round(e.sum / e.g) }))
    .sort((a, b) => b.w - a.w || b.avg - a.avg || b.best - a.best)
    .slice(0, 10);
}

// Win-probability curves for the finished game, one polyline per player.
function everyoneDone() {
  return game.players.length > 0 && game.players.every((p) => rules.isFinished(p.sheet));
}

function chartPayload() {
  const curves = rules.winCurve(game.log);
  const nameOf = {};
  for (const e of game.log) nameOf[e.pid] = e.name;
  for (const p of game.players) if (!nameOf[p.id]) nameOf[p.id] = p.name;
  return Object.keys(curves).map((pid) => ({ id: pid, name: nameOf[pid] || '?', probs: curves[pid] }));
}

// win-prob curves for an archived game, from its persisted move log
function chartFromArchive(g) {
  const curves = rules.winCurve(g.log);
  const nameOf = {};
  for (const e of g.log) nameOf[e.pid] = e.name;
  return Object.keys(curves).map((pid) => ({ id: pid, name: nameOf[pid] || '?', probs: curves[pid] }));
}

function blankSheet() {
  const sheet = {};
  for (const c of rules.Kinds) sheet[c.id] = null;
  return sheet;
}

function bySeat() {
  return game.players.slice().sort((a, b) => a.seat - b.seat);
}

function seatTaken(seat) {
  return game.players.some((p) => p.seat === seat);
}

function lowestFreeSeat() {
  for (let s = 0; s < SEATS; s++) if (!seatTaken(s)) return s;
  return -1;
}

function nextTurnFrom(seat) {
  const order = bySeat().filter((p) => !rules.isFinished(p.sheet));
  if (order.length === 0) { game.turnId = null; return; }
  const nxt = order.find((p) => p.seat > seat) || order[0];
  game.turnId = nxt.id;
}

function pageBuild() {
  if (pageBuildMemo && pageBuildMemo.at > Date.now() - 1000) return pageBuildMemo.hash;
  try {
    const page = buildPage();
    const hash = crypto.createHash('sha1').update(page).digest('hex').slice(0, 8);
    pageBuildMemo = { at: Date.now(), hash };
    return hash;
  } catch (e) {
    return (pageBuildMemo && pageBuildMemo.hash) || '';
  }
}
let pageBuildMemo = null;

function publicState(kid) {
  const mine = game.players.filter((p) => p.kid === kid);
  // one-device mode: the device cycles through its players via /switch;
  // a device's own first player (id === kid) is only preferred while
  // deviceActive is unset (never after an explicit /switch).
  const act = mine.find((p) => p.id === game.deviceActive[kid]);
  const you = act ? act.id : (mine[0] ? mine[0].id : null);
  const devicePlayers = mine.length > 1 ? mine.map((p) => ({ id: p.id, name: p.name, seat: p.seat })) : undefined;
  return {
    started: game.started,
    you,
    mine: mine.map((p) => ({ id: p.id, name: p.name })),
    devicePlayers,
    oneDevice: game.config.oneDevice,
    config: { enforceTurns: game.config.enforceTurns },
    turn: game.started && game.config.enforceTurns ? game.turnId : null,
    lastMover: game.started && game.log.length > 0 ? game.log[game.log.length - 1].pid : null,
    pageBuild: pageBuild(),
    chart: everyoneDone() ? chartPayload() : null,
    players: bySeat().map((p) => ({
      id: p.id,
      seat: p.seat,
      name: p.name,
      sheet: p.sheet,
      totals: rules.computeTotals(p.sheet),
      finished: rules.isFinished(p.sheet),
    })),
  };
}

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const page = freshPage();
  if (page === null) {
    res.status(500).type('text').send('Page build failed — see server console.');
    return;
  }
  res.type('html').send(page);
});
app.use(express.static(path.join(__dirname, '..', 'public')));

const api = express.Router();
api.use(identity);

api.get('/state', (req, res) => {
  res.json(publicState(req.kid));
});

api.post('/join', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 20);
  if (!name) return res.json({ ok: false, error: 'Enter a name to sit down.' });

  let player = game.players.find((x) => x.id === req.kid);
  if (!player) {
    if (game.players.length >= MAX_PLAYERS) {
      return res.json({ ok: false, error: 'Table is full (6 players).' });
    }
    const seat = lowestFreeSeat();
    if (seat < 0) return res.json({ ok: false, error: 'Table is full (6 players).' });
    player = { id: req.kid, kid: req.kid, seat, name, sheet: blankSheet(), lastSeen: Date.now() };
    game.players.push(player);
  } else {
    player.name = name;
  }
  player.lastSeen = Date.now();
  res.json({ ok: true, state: publicState(req.kid) });
});

// Move to a table position before the game starts. Occupied seats swap.
api.post('/seat', (req, res) => {
  if (game.started) return res.json({ ok: false, error: 'Seat changes only before the game starts.' });
  const p = game.players.find((x) => x.id === req.kid);
  if (!p) return res.json({ ok: false, error: 'Sit down first.' });
  const seat = Math.trunc(Number(req.body && req.body.seat));
  if (!(seat >= 0 && seat < SEATS)) return res.json({ ok: false, error: 'Invalid seat.' });
  const occ = game.players.find((x) => x.seat === seat);
  if (occ && occ.id !== p.id) {
    occ.seat = p.seat; // swap so order stays complete
    p.seat = seat;
  } else {
    p.seat = seat;
  }
  res.json({ ok: true, state: publicState(p.id) });
});

api.post('/config', (req, res) => {
  if (game.started) return res.json({ ok: false, error: 'Options are locked once the game started.' });
  if (typeof (req.body || {}).enforceTurns === 'boolean') {
    game.config.enforceTurns = req.body.enforceTurns;
  }
  if (typeof (req.body || {}).oneDevice === 'boolean') {
    game.config.oneDevice = req.body.oneDevice;
  }
  res.json({ ok: true, state: publicState(req.kid) });
});

api.post('/start', (req, res) => {
  if (game.players.length < 1) return res.json({ ok: false, error: 'Nobody at the table.' });
  game.started = true;
  for (const x of game.players) x.sheet = blankSheet();
  game.log = [];
  game.archived = false;
  game.deviceActive = {};
  if (game.config.enforceTurns) {
    const order = bySeat();
    game.turnId = (order.find((p) => !rules.isFinished(p.sheet)) || order[0]).id;
  } else {
    game.turnId = null;
  }
  res.json({ ok: true, state: publicState(req.kid) });
});

api.post('/score', (req, res) => {
  const { category, value } = req.body || {};
  // one-device mode: an explicit playerId belonging to this device wins;
  // otherwise it is the device's own first-seat player.
  const p = game.players.find((x) => (req.body || {}).playerId
    ? x.kid === req.kid && x.id === req.body.playerId
    : x.id === req.kid);
  if (!p) return res.json({ ok: false, error: 'Sit down first.' });
  if (!game.started) return res.json({ ok: false, error: 'Game not started.' });
  // Out-of-turn is only allowed to correct an already-filled cell (edit),
  // never to place a brand-new entry — turn order stays intact.
  const isEdit = p.sheet[category] !== null && p.sheet[category] !== undefined;
  if (game.config.enforceTurns && game.turnId !== p.id && !isEdit) {
    const cur = game.players.find((x) => x.id === game.turnId);
    return res.json({ ok: false, error: `Not your turn - it is ${cur ? cur.name : '?'}'s turn.` });
  }
  // Overwriting your own entry is allowed (long-press edit on the client);
  // you can never write into someone else's sheet.
  if (!rules.isValidValue(category, value)) {
    return res.json({ ok: false, error: 'Invalid points for that category.' });
  }
  const prevValue = isEdit ? p.sheet[category] : null;
  p.sheet[category] = value;
  const t = rules.computeTotals(p.sheet);
  game.log.push({
    pid: p.id,
    name: p.name,
    cat: category,
    v: value,
    prev: prevValue,
    grand: t.grand,
    filled: rules.filledCount(p.sheet),
    t: Date.now(),
  });
  if (everyoneDone() && !game.archived) {
    archiveGame();
    game.archived = true;
  }
  // turn order only advances on a genuine new entry — never on an edit
  if (game.config.enforceTurns && !isEdit) nextTurnFrom(p.seat);
  res.json({ ok: true, state: publicState(req.kid) });
});

// Undo the latest complete turn (one scoring move, latest first) and point
// the turn back at that player so the outcome can be corrected before the
// next player moves. Only the player who just scored may undo — nobody
// else gets to rewind someone else's turn.
api.post('/undo-turn', (req, res) => {
  if (!game.started) return res.json({ ok: false, error: 'Game not started.' });
  if (game.log.length === 0) return res.json({ ok: false, error: 'Nothing to undo.' });
  // same player resolution as /score (one-device mode may pass playerId)
  const p = game.players.find((x) => (req.body || {}).playerId
    ? x.kid === req.kid && x.id === req.body.playerId
    : x.id === req.kid);
  if (!p) return res.json({ ok: false, error: 'Sit down first.' });
  const last = game.log[game.log.length - 1];
  if (last.pid !== p.id) return res.json({ ok: false, error: 'Only the player who just scored can undo.' });
  const cat = last.cat;
  const wasOverwrite = p.sheet[cat] !== null && p.sheet[cat] !== undefined;
  // The log entry captured the sheet BEFORE the move: undo restores that
  // value when the move was an overwrite; a brand-new entry clears the cell.
  p.sheet[cat] = wasOverwrite ? last.prev : null;
  game.log.pop();
  game.archived = false; // game is no longer complete if it just was
  if (game.config.enforceTurns) game.turnId = p.id;
  res.json({ ok: true, state: publicState(req.kid) });
});

// one-device mode: switch which of this device's players is active
api.post('/switch', (req, res) => {
  const pid = String((req.body || {}).playerId || '');
  const p = game.players.find((x) => x.kid === req.kid && x.id === pid);
  if (!p) return res.json({ ok: false, error: 'That player is not on this device.' });
  game.deviceActive[req.kid] = p.id;
  res.json({ ok: true, state: publicState(req.kid) });
});

// one-device mode: add extra players on this device (lobby only)
api.post('/add-player', (req, res) => {
  const name = String((req.body || {}).name || '').trim().slice(0, 20);
  if (!name) return res.json({ ok: false, error: 'Enter a name.' });
  if (game.started) return res.json({ ok: false, error: 'Players can only join before the game starts.' });
  if (game.players.length >= MAX_PLAYERS) return res.json({ ok: false, error: 'Table is full (6 players).' });
  const seat = lowestFreeSeat();
  if (seat < 0) return res.json({ ok: false, error: 'Table is full (6 players).' });
  const player = { id: newId(), kid: req.kid, seat, name, sheet: blankSheet(), lastSeen: Date.now() };
  game.players.push(player);
  game.deviceActive[req.kid] = player.id;
  res.json({ ok: true, state: publicState(req.kid) });
});

api.post('/reset', (req, res) => {
  game.started = false;
  game.turnId = null;
  game.log = [];
  game.archived = false;
  game.deviceActive = {};
  for (const x of game.players) x.sheet = blankSheet();
  res.json({ ok: true, state: publicState(req.kid) });
});

// full table reset: scores cleared and every player removed, so all devices
// are back on the join screen (their cookies survive; joining re-seats them)
api.post('/reset-table', (req, res) => {
  game.started = false;
  game.turnId = null;
  game.log = [];
  game.archived = false;
  game.deviceActive = {};
  game.players = [];
  res.json({ ok: true, state: publicState(req.kid) });
});

api.post('/leave', (req, res) => {
  const p = game.players.find((x) => x.id === req.kid);
  if (p && game.config.enforceTurns && game.turnId === p.id && game.started) {
    nextTurnFrom(p.seat);
  }
  // leaving removes all players seated on this device
  game.players = game.players.filter((x) => x.kid !== req.kid);
  delete game.deviceActive[req.kid];
  res.clearCookie('kid');
  res.json({ ok: true, state: publicState(null) });
});

app.use('/api', api);

// History + leaderboard (read-only, no identity cookie needed).
const apiPub = express.Router();
apiPub.get('/history', (req, res) => {
  res.json({
    gameNo,
    games: past.slice(-50).reverse().map((g) => ({
      no: g.no, t: g.t, finished: g.finished, winner: g.winner,
      players: g.players.map((p) => ({ name: p.name, grand: p.totals.grand })),
      chart: g.finished ? chartFromArchive(g) : null,
    })),
    leaders: leaderboard(),
  });
});
app.use('/api', apiPub);

// persist the archive on graceful shutdown as a final safety net
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { flushPast(); process.exit(0); });
}

const server = http.createServer(app);
server.listen(PORT, '0.0.0.0', () => {
  // Only IPv4, private LAN ranges are usable from phones; link-local
  // (169.254.x.x) is an unconnected/virtual adapter and never reachable.
  const candidates = [];
  for (const name of Object.keys(os.networkInterfaces())) {
    for (const net of os.networkInterfaces()[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const isPrivate = net.address.startsWith('192.168.') ||
        net.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(net.address);
      candidates.push({ addr: net.address, name, usable: isPrivate });
    }
  }
  candidates.sort((a, b) => (b.usable ? 1 : 0) - (a.usable ? 1 : 0));

  console.log('');
  console.log('  Kniffel score sheet (REST polling, adblock-proof)');
  console.log(`  This PC : http://localhost:${PORT}`);
  if (candidates.length === 0) {
    console.log('  No IPv4 LAN address found - connect this PC to your Wi-Fi and restart.');
  } else {
    console.log(`  Phones  : http://${candidates[0].addr}:${PORT}`);
    if (candidates.length > 1) {
      console.log('  Other adapters (try if the first does not work):');
      for (const c of candidates.slice(1)) console.log(`    http://${c.addr}:${PORT}  (${c.name})`);
    }
    console.log('  If unreachable: allow Node.js in Windows Firewall (private networks)');
    console.log('  or run as admin once:  netsh advfirewall firewall add rule name="kniffel" dir=in action=allow protocol=TCP localport=' + PORT);
  }
  console.log('');
});