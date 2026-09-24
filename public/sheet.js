'use strict';

// Plain REST + polling transport: no websocket handshake URLs or query
// fingerprints that adblock filter lists could match.

let state = null;
let picker = { open: false, category: null };
let view = 'sheet'; // 'sheet' is the main page; 'standings' is secondary
let winDismissedFor = 0; // game generation the win overlay was closed for
let peek = true; // privacy mode: sheet shows only your own scores until revealed
let myPageBuild = null; // build id this page was served with; change => reload
let myKid = null; // this device's cookie id (server echoes it in state.mine matching)

const $ = (sel) => document.querySelector(sel);
const joinView = $('#join-view');
const gameView = $('#game-view');
const standingsView = $('#standings-view');
const sheetEl = $('#sheet');
const pickerEl = $('#picker');
const winEl = $('#win-overlay');
const connDot = $('#conn-dot');
let histCache = null;

const UPPER_IDS = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];

const CAT_LABELS = {
  ones: 'Ones', twos: 'Twos', threes: 'Threes', fours: 'Fours',
  fives: 'Fives', sixes: 'Sixes', threeKind: '3 of a kind',
  fourKind: '4 of a kind', fullHouse: 'Full house',
  smallStraight: 'Sm straight', largeStraight: 'Lg straight',
  kniffel: 'KNIFFEL', chance: 'Chance',
};
const CAT_ORDER = UPPER_IDS.concat(['threeKind', 'fourKind', 'fullHouse', 'smallStraight', 'largeStraight', 'kniffel', 'chance']);

// ---------- fun: score reactions (toasts, banner, dice rain) ----------
// Pure presentation: the server state is diffed each poll; anything that
// changed since last time triggers phrases/animations.
const REDUCE = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const fxPulses = new Map(); // "pid:cat" -> { t, cls } for sheet cell animations
let fxBigTimer = null;

const BANKS = {
  scratch: [
    'Bold strategy.',
    'Ouch. We all saw it. We will speak of it never.',
    'The dice said NO and meant it.',
    'A sacrifice to the dice gods.',
    'Zero points, infinite courage.',
    'Character-building scratch.',
    'That cell is dead to us now.',
    'Somewhere, a Yahtzee grandmaster just cried.',
  ],
  bonus: [
    'The 63 toll has been paid.',
    'Upper section: conquered.',
    'Big-brain bonus banking.',
    'The long game pays off.',
  ],
  high: [
    'The table goes completely silent.',
    'Certified dice wizardry.',
    "That one's going on the fridge.",
    'Disgusting. Beautiful, but disgusting.',
    'The other players felt that one.',
    'Frame-worthy. Absolutely frame-worthy.',
  ],
  solid: [
    'Clean. Efficient. Deadly.',
    "Hey, that's a keeper.",
    'The sheet grows stronger.',
    'Sneaky. We like it.',
  ],
  meh: [
    'Every point counts. Allegedly.',
    'The accountant has entered the chat.',
    'Points are points. Probably.',
    'A true strategist. Or chaotic. Hard to say.',
    'We have all made worse choices.',
  ],
};

// Per-category expectation: what fraction of the picker max counts as a good
// entry. Sixes for 6 is a bad day; sixes for 24 is a highlight.
const EXPECT = {
  ones: 0.66, twos: 0.5, threes: 0.5, fours: 0.5, fives: 0.5, sixes: 0.5,
  threeKind: 0.6, fourKind: 0.7, fullHouse: 1, smallStraight: 1,
  largeStraight: 1, kniffel: 1, chance: 0.6,
};

// quality: 'great' | 'ok' | 'weak' | 'scratch' for value vs category max
function qualityOf(e) {
  if (e.v === 0) return 'scratch';
  const max = Math.max(...PICKERS[e.cat].values);
  const f = e.v / max;
  if (f >= 0.8) return 'great';
  if (f >= 0.45) return 'ok';
  return 'weak';
}

const QUALITY_BANKS = {
  great: [
    'Textbook. The dice respect you.',
    'That is how it is drawn up.',
    'Maximum value. No notes.',
    'Stealing points from the gods.',
    'Put it in the highlight reel.',
    'Absolute pillage of that box.',
    'The category gave you everything it had.',
  ],
  ok: [
    'Respectable. Nobody argues.',
    'Fair value, fair fight.',
    'Banked without drama.',
    'A solid day at the office.',
    'That will not embarrass anyone.',
  ],
  weak: [
    'Low roll, bold placement.',
    'Begging for those points, were we?',
    'Duct-taped in. It counts.',
    'Someone was in a hurry.',
    'The dice were not on your side.',
    'Economy class points. Still counts.',
    'The dice offered little, you took it.',
  ],
};

// value-dependent tone for upper categories (6 ones = sad, 5 sixes = hero)
function bankFor(e) {
  const q = qualityOf(e);
  if (q === 'scratch') return BANKS.scratch;
  if (q === 'great') return QUALITY_BANKS.great;
  if (q === 'weak') return QUALITY_BANKS.weak;
  if (e.tier >= 2 || e.v >= 25) return BANKS.high;
  if (e.v >= 18) return BANKS.solid;
  return QUALITY_BANKS.ok;
}
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function fxTier(e) {
  if (e.cat === 'kniffel' && e.v === 50) return 4;
  if (e.cat === 'largeStraight' && e.v === 40) return 3;
  if (e.cat === 'smallStraight' && e.v === 30) return 3;
  if (e.cat === 'fullHouse' && e.v === 25) return 3;
  if (qualityOf(e) === 'great') return 2;
  if (e.v >= 25) return 2;
  return 1;
}

function fxClass(e) {
  if (e.v === 0) return 'cell-anim-zero';
  if (e.tier >= 4) return 'cell-anim-kniffel';
  if (e.tier >= 2 || e.v >= 25) return 'cell-anim-gold';
  return 'cell-anim-pop';
}

function fxBank(e) {
  if (e.bonusUpper || e.bonusKniffel) return BANKS.bonus;
  return bankFor(e);
}

function buzz(pattern) {
  if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* not supported */ } }
}

// diff prev -> current state; queue toasts and maybe the big splash
function handleFx(prev, s) {
  if (!prev || !s || !s.started || !prev.started) return;
  const evs = [];
  for (const np of s.players) {
    const op = prev.players.find((q) => q.id === np.id);
    if (!op) continue;
    for (const cat of CAT_ORDER) {
      const now = np.sheet[cat];
      const was = op.sheet[cat];
      if (now === null || now === undefined) continue;
      if (was === now) continue;
      const e = { p: np, cat, v: now, overwrite: was !== null && was !== undefined, tier: 0 };
      e.tier = fxTier(e);
      evs.push(e);
      fxPulses.set(np.id + ':' + cat, { t: Date.now(), cls: fxClass(e) });
    }
    if (op.totals.upperBonus === 0 && np.totals.upperBonus > 0) {
      evs.push({ bonusUpper: true, p: np });
    }
    if (np.totals.kniffelBonus > op.totals.kniffelBonus
      && !evs.some((x) => x.p === np && x.cat === 'kniffel' && x.v === 50)) {
      evs.push({ bonusKniffel: true, p: np });
    }
  }
  if (!evs.length) return;
  evs.sort((a, b) => (b.tier || 0) - (a.tier || 0));
  const big = evs.find((e) => e.tier >= 3);
  for (const e of evs) {
    // privacy: while peek mode hides others' columns, don't leak their
    // exact scores in toasts; own events always toast. Public celebrations
    // (big splash) still fire for everyone, like shouting at a real table.
    if (peek && e.p && e.p.id !== s.you) continue;
    pushToast(fxToast(e));
  }
  if (big) showBig(big);
}

// small inline SVG dice face (pip pattern) for toasts / accents
function diceSvg(face, size = 16) {
  const s = size;
  const r = s * 0.22;
  const p = s * 0.28;
  const m = s * 0.5;
  const q = s - p;
  const dots = {
    1: [[m, m]],
    2: [[p, p], [q, q]],
    3: [[p, p], [m, m], [q, q]],
    4: [[p, p], [q, p], [p, q], [q, q]],
    5: [[p, p], [q, p], [m, m], [p, q], [q, q]],
    6: [[p, p], [q, p], [p, m], [q, m], [p, q], [q, q]],
  };
  const circle = (cx, cy) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="currentColor"/>`;
  return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="1" y="1" width="${s - 2}" height="${s - 2}" rx="2.5" fill="none"/>\u003e\u003cg fill="currentColor" stroke="none">${dots[face] ? dots[face].map(([x, y]) => circle(x, y)).join('') : ''}\u003c/g></svg>`;
}

// big-splash wording per combo, bowling style
const BIG_WORDS = {
  kniffel: 'KNIFFEL!!',
  largeStraight: 'LARGE STRAIGHT!',
  smallStraight: 'STRAIGHT!',
  fullHouse: 'FULL HOUSE!',
};
const BIG_COLOR = { kniffel: 'flavor-kniffel', largeStraight: 'flavor-strike', smallStraight: 'flavor-strike', fullHouse: 'flavor-fullhouse' };

function fxToast(e) {
  const name = e.p.name;
  let head;
  let bank;
  let tier = '';
  if (e.bonusUpper) {
    head = `${name} unlocks the 63+ bonus (+35)`;
    bank = BANKS.bonus;
  } else if (e.bonusKniffel) {
    head = `${name} banks a bonus Kniffel (+50)`;
    bank = BANKS.bonus;
    tier = 'gold';
  } else if (e.v === 0) {
    head = `${name} scratches ${CAT_LABELS[e.cat]}`;
    bank = BANKS.scratch;
    tier = 'scratch';
  } else {
    head = `${name} ${e.overwrite ? 're-' : ''}scores ${e.v} on ${CAT_LABELS[e.cat]}`;
    bank = fxBank(e);
    if (e.tier >= 3) {
      tier = 'gold';
    } else if (qualityOf(e) === 'weak' && e.v > 0) {
      tier = 'weak';
    }
  }
  return { head, quote: pick(bank), tier };
}

const MAX_TOASTS = 2;
const toastQueue = [];
let toastsInFlight = 0;

function pushToast(t) {
  toastQueue.push(t);
  drainToasts();
}

function drainToasts() {
  const host = $('#fx-toasts');
  if (!host) return;
  while (toastsInFlight < MAX_TOASTS && toastQueue.length) {
    const t = toastQueue.shift();
    toastsInFlight += 1;
    const d = document.createElement('div');
    d.className = 'fx-toast' + (t.tier ? ' t-' + t.tier : '');
    const main = document.createElement('div');
    main.textContent = t.head;
    d.appendChild(main);
    if (t.quote) {
      const q = document.createElement('span');
      q.className = 'fx-quote';
      q.textContent = '\u201C' + t.quote + '\u201D';
      d.appendChild(q);
    }
    host.appendChild(d);
    while (host.children.length > MAX_TOASTS) host.removeChild(host.firstChild);
    setTimeout(() => {
      d.classList.add('out');
      setTimeout(() => { d.remove(); toastsInFlight -= 1; drainToasts(); }, 260);
    }, t.tier === 'gold' ? 4200 : 3200);
  }
}

const DICE_FACES = ['\u2680', '\u2681', '\u2682', '\u2683', '\u2684', '\u2685'];

function spawnDiceRain(host, n) {
  if (!host || REDUCE) return;
  host.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    d.className = 'die';
    d.textContent = DICE_FACES[i % 6];
    d.style.left = (Math.random() * 94 + 1) + '%';
    d.style.fontSize = (15 + Math.random() * 22) + 'px';
    d.style.animationDuration = (1.3 + Math.random() * 1.3) + 's';
    d.style.animationDelay = (Math.random() * 0.6) + 's';
    host.appendChild(d);
  }
}

// bowling-style splash for KNIFFEL and large straight
function showBig(e) {
  const host = $('#fx-big');
  const inn = $('#fx-big-in');
  const rain = $('#fx-rain');
  if (!host || !inn) return;
  clearTimeout(fxBigTimer);
  const isKniffel = e.tier >= 4;
  inn.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'fx-big-text ' + (BIG_COLOR[e.cat] || 'flavor-strike');
  t.textContent = BIG_WORDS[e.cat] || 'NICE!';
  const sub = document.createElement('div');
  sub.className = 'fx-big-sub';
  sub.textContent = `${e.p.name} \u00B7 ${CAT_LABELS[e.cat]} \u00B7 +${e.v}`;
  inn.appendChild(t);
  inn.appendChild(sub);
  if (rain) spawnDiceRain(rain, isKniffel ? 30 : 20);
  host.hidden = false;
  requestAnimationFrame(() => host.classList.add('show'));
  buzz(isKniffel ? [50, 70, 40, 70, 140] : [40, 60, 90]);
  fxBigTimer = setTimeout(() => {
    host.classList.remove('show');
    setTimeout(() => {
      host.hidden = true;
      inn.innerHTML = '';
      if (rain) rain.innerHTML = '';
    }, 320);
  }, isKniffel ? 3000 : 2400);
}

// ---------- transport ----------
async function api(path, body) {
  try {
    const res = await fetch('/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
    connDot.className = 'dot on';
    $('#conn-banner').hidden = true;
    return await res.json();
  } catch (e) {
    connDot.className = 'dot off';
    $('#conn-banner').hidden = false;
    return null;
  }
}

async function refreshLoop() {
  const s = await api('state');
  if (s) applyState(s);
  setTimeout(refreshLoop, 1500);
}

function applyState(s) {
  // auto-refresh when the server's page build changed (new deploy) —
  // one reload, and only after the user has seen the current page
  if (s.pageBuild) {
    if (myPageBuild === null) {
      myPageBuild = s.pageBuild;
    } else if (s.pageBuild !== myPageBuild) {
      location.reload();
      return;
    }
  }
  // remember the kid this device originally joined with (first seat taken)
  if (!myKid && s.mine && s.mine.length) myKid = s.mine[0].id;
  const prev = state;
  state = s;
  handleFx(prev, state);
  render(prev);
  if (picker.open) {
    if (!state.players.some((p) => p.id === state.you)) closePicker();
    else renderPickerValues();
  }
}

// ---------- join ----------
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await api('join', { name: $('#name-input').value });
  if (!res) return;
  if (!res.ok) {
    $('#join-error').textContent = res.error || 'Could not join.';
    return;
  }
  $('#join-error').textContent = '';
  applyState(res.state);
});

// ---------- side drawer navigation ----------
const drawer = $('#drawer');
const backdrop = $('#drawer-backdrop');

function openDrawer() {
  drawer.hidden = false;
  backdrop.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add('open');
    backdrop.classList.add('show');
  });
}

function closeDrawer() {
  drawer.classList.remove('open');
  backdrop.classList.remove('show');
  setTimeout(() => { drawer.hidden = true; backdrop.hidden = true; }, 220);
}

function setView(v) {
  view = v;
  if (v === 'history' || v === 'leaderboard') loadHistory();
  if (state) render(state);
  closeDrawer();
}

$('#burger').addEventListener('click', openDrawer);
backdrop.addEventListener('click', closeDrawer);
for (const b of drawer.querySelectorAll('.drawer-item[data-view]')) {
  b.addEventListener('click', () => setView(b.dataset.view));
}
$('#drawer-reset-btn').addEventListener('click', () => {
  closeDrawer();
  if (!state || !state.started) { alert('No game running yet.'); return; }
  if (!confirm('Start a new game? All scores will be cleared.')) return;
  api('reset', {}).then((res) => {
    if (res && res.state) applyState(res.state);
    else if (res && !res.ok) alert(res.error);
  });
});

$('#drawer-reset-table-btn').addEventListener('click', () => {
  closeDrawer();
  if (!confirm('Reset the whole table? All players will be removed and must join again.')) return;
  api('reset-table', {}).then((res) => {
    if (res && res.state) applyState(res.state);
    else if (res && !res.ok) alert(res.error);
  });
});
// peek privacy toggle (pill on the quick strip above the sheet)
$('#peek-btn').addEventListener('click', () => {
  peek = !peek;
  render(state);
});

// ---------- history + leaderboard (shared fetch) ----------
async function loadHistory() {
  const res = await fetch('/api/history', { cache: 'no-store' });
  if (!res.ok) return;
  histCache = await res.json();
  if (state) render(state);
}

// ---------- privacy peek toggle (relocated to drawer) ----------

// ---------- actions ----------
$('#start-btn').addEventListener('click', async () => {
  const res = await api('start', {});
  if (res && res.state) applyState(res.state);
});

// ---------- lobby: seat + options ----------
$('#opt-turns').addEventListener('change', async (e) => {
  const res = await api('config', { enforceTurns: e.target.checked });
  if (res && res.state) applyState(res.state);
  else if (res && !res.ok) { alert(res.error); e.target.checked = !e.target.checked; }
});

$('#opt-one-device').addEventListener('change', async (e) => {
  const res = await api('config', { oneDevice: e.target.checked });
  if (res && res.state) applyState(res.state);
  else if (res && !res.ok) { alert(res.error); e.target.checked = !e.target.checked; }
});

// one-device mode: cycle between this device's players
function switchPlayer(dir) {
  const mine = (state && state.mine) || [];
  if (mine.length < 2) return;
  const idx = mine.findIndex((p) => p.id === state.you);
  const nxt = mine[(idx + dir + mine.length) % mine.length];
  api('switch', { playerId: nxt.id }).then((res) => {
    if (res && res.state) applyState(res.state);
    else if (res && !res.ok) alert(res.error);
  });
}
$('#dev-prev').addEventListener('click', () => switchPlayer(-1));
$('#dev-next').addEventListener('click', () => switchPlayer(1));

function renderTable() {
  const tv = $('#table-visual');
  tv.innerHTML = '';

  const center = document.createElement('div');
  center.className = 'table-center';
  const dice = document.createElement('div');
  dice.className = 'tc-dice';
  dice.textContent = '🎲';
  const lbl = document.createElement('div');
  lbl.textContent = state.players.length >= 2 ? `${state.players.length} players` : 'tap a seat';
  center.appendChild(dice);
  center.appendChild(lbl);
  tv.appendChild(center);

  // 6 seats evenly around the circle; seat 1 at the top, clockwise.
  // R = 38% so the 74px seat circles stay fully inside the container
  // (50% would push them over the heading above and the button below).
  for (let s = 0; s < 6; s++) {
    const p = state.players.find((x) => x.seat === s);
    const angle = (Math.PI * 2 * s) / 6 - Math.PI / 2;
    const R = 38; // percent of container
    const x = 50 + R * Math.cos(angle);
    const y = 50 + R * Math.sin(angle);

    const b = document.createElement('button');
    b.className = 'seat-btn' + (p && p.id === state.you ? ' you' : '') + (!p ? ' open' : '');
    b.style.left = x + '%';
    b.style.top = y + '%';
    const no = document.createElement('span');
    no.className = 'seat-no';
    no.textContent = '#' + (s + 1);
    b.appendChild(no);
    const nm = document.createElement('span');
    nm.className = 'seat-name';
    nm.textContent = p ? p.name : '+ open';
    b.appendChild(nm);
    b.disabled = !!p && p.id !== state.you;
    if (!p || p.id === state.you) {
      b.addEventListener('click', async () => {
        const res = await api('seat', { seat: s });
        if (res && res.state) applyState(res.state);
        else if (res && !res.ok) alert(res.error);
      });
    }
    tv.appendChild(b);
  }
}

$('#reset-btn').addEventListener('click', async () => {
  if (!confirm('Start a new game? All scores will be cleared.')) return;
  const res = await api('reset', {});
  if (res && res.state) applyState(res.state);
});

// undo the latest scoring move — only the player who just scored may call it
$('#undo-turn-btn').addEventListener('click', async () => {
  const forPlayer = state.mine && state.mine.some((p) => p.id === state.you) ? state.you : undefined;
  const res = await api('undo-turn', { playerId: forPlayer });
  if (res && res.state) applyState(res.state);
  else if (res && !res.ok) alert(res.error || 'Could not undo.');
});

// one-device lobby: list this device's players + add/remove
function renderDeviceList() {
  const host = $('#device-players');
  if (!host) return;
  host.innerHTML = '';
  const mine = state.mine || [];
  for (const mp of mine) {
    const r = document.createElement('div');
    r.className = 'dev-list-row' + (mp.id === state.you ? ' active' : '');
    r.textContent = mp.name;
    host.appendChild(r);
  }
}

$('#device-add-btn').addEventListener('click', async () => {
  const inp = $('#device-add-name');
  const name = inp.value.trim();
  if (!name) return;
  const res = await api('add-player', { name });
  if (res && res.state) { inp.value = ''; applyState(res.state); }
  else if (res && !res.ok) alert(res.error);
});

// ---------- picker ----------
function openPicker(category, titlePrefix, isEdit) {
  picker = { open: true, category };
  const lbl = CAT_LABELS[category];
  $('#picker-title').textContent = isEdit
    ? (titlePrefix ? titlePrefix + ' — ' : '') + lbl + ' (correct)'
    : (titlePrefix ? titlePrefix + ' — ' : '') + lbl;
  renderPickerValues();
  pickerEl.hidden = false;
}

function closePicker() {
  pickerEl.hidden = true;
  picker = { open: false, category: null };
}

$('#picker-cancel').addEventListener('click', closePicker);
pickerEl.addEventListener('click', (e) => { if (e.target === pickerEl) closePicker(); });

// Picker options + hints are presentation logic; the server independently
// validates every submitted value (server/rules.js).
const PICKERS = {
  ones:     { values: [0, 1, 2, 3, 4, 5], hint: 'tap how many ones you have' },
  twos:     { values: [0, 2, 4, 6, 8, 10], hint: 'tap how many twos you have' },
  threes:   { values: [0, 3, 6, 9, 12, 15], hint: 'tap how many threes you have' },
  fours:    { values: [0, 4, 8, 12, 16, 20], hint: 'tap how many fours you have' },
  fives:    { values: [0, 5, 10, 15, 20, 25], hint: 'tap how many fives you have' },
  sixes:    { values: [0, 6, 12, 18, 24, 30], hint: 'tap how many sixes you have' },
  threeKind: { values: [10, 12, 15, 18, 20, 21, 24, 25, 27, 28, 30, 5, 6, 7, 8, 9, 11, 13, 14, 16, 17, 19, 22, 23, 26, 29, 0], hint: 'tap your total (3 equal dice or more)' },
  fourKind: { values: [20, 22, 25, 8, 12, 16, 24, 5, 6, 7, 9, 10, 11, 13, 14, 15, 17, 18, 19, 21, 23, 26, 27, 28, 29, 30, 0], hint: 'tap your total (at least 4 equal dice)' },
  fullHouse: { values: [25, 0], hint: 'tap 25 if you have a pair + triple' },
  smallStraight: { values: [30, 0], hint: 'tap 30 if you have 4 in a row' },
  largeStraight: { values: [40, 0], hint: 'tap 40 for 1-2-3-4-5 or 2-3-4-5-6' },
  kniffel: { values: [50, 0], hint: 'tap 50 for five-of-a-kind' },
  chance: { values: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 0], hint: 'tap your total (any dice)' },
};

// expected value per upper category (deficit meter anchor): sixes for 6
// feels bad, 24 feels good. Lower sections (kinds/chance) have no anchor —
// any total can be fine there.
const DEFICIT_ANCHOR = {
  ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18,
};
function deficitLabel(cat, v) {
  if (v === 0 || !(cat in DEFICIT_ANCHOR)) return null;
  const d = v - DEFICIT_ANCHOR[cat];
  return d > 0 ? '+' + d : d === 0 ? '\u00B10' : '\u2212' + Math.abs(d);
}

function renderPickerValues() {
  const spec = PICKERS[picker.category];
  const el = $('#picker-values');
  el.innerHTML = '';
  if (spec.hint) {
    const h = document.createElement('div');
    h.style.cssText = 'grid-column:1/-1;color:var(--dim);font-size:13px;text-align:center;margin-bottom:4px;font-weight:500';
    h.textContent = spec.hint;
    el.appendChild(h);
  }
  const me = state && state.players.find((p) => p.id === state.you);
  const cur = me && picker.category ? me.sheet[picker.category] : null;
  for (const v of spec.values.slice().sort((a, b) => a - b)) {
    const b = document.createElement('button');
    b.className = 'val-btn' + (v === 0 ? ' zero' : '') + (v === cur ? ' cur' : '');
    b.type = 'button';
    const num = document.createElement('span');
    num.className = 'val-num';
    num.textContent = String(v);
    b.appendChild(num);
    if (v === 0) b.title = 'scratch (cross out)';
    const def = deficitLabel(picker.category, v);
    if (def) {
      const s = document.createElement('span');
      s.className = 'val-def' + (v - DEFICIT_ANCHOR[picker.category] >= 0 ? ' pos' : ' neg');
      s.textContent = def;
      b.appendChild(s);
    }
    b.addEventListener('click', () => commitScore(v));
    el.appendChild(b);
  }
}

async function commitScore(value) {
  if (!picker.category) return;
  // score for whoever is currently switched-to on this device
  const forPlayer = state.mine && state.mine.some((p) => p.id === state.you) ? state.you : undefined;
  const res = await api('score', { category: picker.category, value, playerId: forPlayer });
  if (res && !res.ok) alert(res.error || 'Could not save.');
  if (res && res.state) applyState(res.state);
  closePicker();
}

// ---------- standings ----------
function sortedPlayers() {
  return state.players
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => b.p.totals.grand - a.p.totals.grand || a.idx - b.idx);
}

function renderStandings() {
  standingsView.innerHTML = '';
  const list = sortedPlayers();
  const done = everyoneDone();
  const leaders = countLeaders();

  list.forEach(({ p, idx }, rank) => {
    const row = document.createElement('div');
    row.className = 'stand-row' + (rank === 0 && leaders > 0 ? ' winner-row' : '');
    const rk = document.createElement('div');
    rk.className = 'rank';
    rk.textContent = leaders > 1 && rank === leaders - 1 ? '=' : String(rank + 1);
    const mid = document.createElement('div');
    mid.style.cssText = 'flex:1;min-width:0';
    const nm = document.createElement('div');
    nm.className = 'p-name' + (rank < leaders ? ' leader' : '');
    nm.textContent = p.name;
    const sub = document.createElement('div');
    sub.className = 'p-sub';
    sub.textContent = `${filledCount(p.sheet)}/13 filled · upper ${p.totals.upper}${p.totals.upperBonus ? ' +' + p.totals.upperBonus : ''}${p.totals.kniffelBonus ? ' · kn ' + p.totals.kniffelBonus : ''}`;
    mid.appendChild(nm);
    mid.appendChild(sub);
    const pts = document.createElement('div');
    pts.className = 'p-pts';
    pts.textContent = String(p.totals.grand);
    // deficit to the leader (everyone after rank 1)
    const leaderPts = list[0].p.totals.grand;
    if (p.totals.grand < leaderPts) {
      const d = document.createElement('span');
      d.className = 'p-def';
      d.textContent = '\u2212' + (leaderPts - p.totals.grand);
      pts.appendChild(d);
    }
    row.appendChild(rk);
    row.appendChild(mid);
    row.appendChild(pts);
    standingsView.appendChild(row);
  });
}

function filledCount(sheet) {
  let n = 0;
  for (const k of CAT_ORDER) if (sheet[k] !== null && sheet[k] !== undefined) n += 1;
  return n;
}

function countLeaders() {
  const list = sortedPlayers();
  if (list.length === 0) return 0;
  const best = list[0].p.totals.grand;
  let n = 0;
  for (const it of list) { if (it.p.totals.grand === best) n += 1; else break; }
  return n;
}

// ---------- leaderboard tab ----------
function renderLeaderboard() {
  const hv = $('#leaderboard-view');
  hv.innerHTML = '';
  const h = histCache;
  if (!h) {
    const note = document.createElement('div');
    note.className = 'hist-note';
    note.textContent = 'Loading…';
    hv.appendChild(note);
    return;
  }

  const title = document.createElement('div');
  title.className = 'hist-title';
  title.textContent = 'Leaderboard';
  hv.appendChild(title);

  if (!h.leaders.length) {
    const note = document.createElement('div');
    note.className = 'hist-note';
    note.textContent = 'No finished games yet.';
    hv.appendChild(note);
  }
  for (const [i, e] of h.leaders.entries()) {
    const r = document.createElement('div');
    r.className = 'hist-lrow' + (i === 0 ? ' first' : '');
    const rk = document.createElement('div');
    rk.className = 'rank';
    rk.textContent = ['🥇', '🥈', '🥉'][i] || String(i + 1);
    const nm = document.createElement('div');
    nm.className = 'p-name';
    nm.textContent = e.name;
    const sub = document.createElement('div');
    sub.className = 'p-sub';
    sub.textContent = `${e.w}W ${e.g - e.w}L · avg ${e.avg} · best ${e.best}`;
    const pts = document.createElement('div');
    pts.className = 'p-pts';
    pts.textContent = `${e.w}/${e.g}`;
    r.appendChild(rk);
    r.appendChild(nm);
    nm.appendChild(sub);
    r.appendChild(pts);
    hv.appendChild(r);
  }
}

// ---------- past-games history tab ----------
// identity of the history payload currently rendered — polls must not
// rebuild the cards (that would collapse open charts every 1.5 s)
let histRenderedKey = null;
const histOpen = new Set(); // game nos with expanded chart

function histKey(h) {
  if (!h) return '';
  return h.games.map((g) => g.no + ':' + (g.chart ? g.chart.length : 0)).join('|')
    + '#' + h.leaders.map((l) => l.name + l.w + l.g).join(',');
}

function renderHistory() {
  const hv = $('#history-view');
  const key = histKey(histCache);
  if (!histCache) {
    hv.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'hist-note';
    note.textContent = 'Loading…';
    hv.appendChild(note);
    histRenderedKey = null;
    return;
  }
  if (key === histRenderedKey) return; // unchanged: keep DOM + open charts
  histRenderedKey = key;
  hv.innerHTML = '';
  const h = histCache;

  const title = document.createElement('div');
  title.className = 'hist-title';
  title.textContent = 'Past games';
  hv.appendChild(title);

  if (!h.games.length) {
    const note = document.createElement('div');
    note.className = 'hist-note';
    note.textContent = 'Finish a game and it will show up here.';
    hv.appendChild(note);
  }
  for (const g of h.games) {
    const card = document.createElement('div');
    card.className = 'hist-game';
    const head = document.createElement('div');
    head.className = 'hist-ghead';
    head.textContent = g.finished
      ? `#${g.no} · ${g.winner} won`
      : `#${g.no} · abandoned`;
    const headRight = document.createElement('span');
    headRight.className = 'hist-gtime-wrap';
    const time = document.createElement('span');
    time.className = 'hist-gtime';
    time.textContent = new Date(g.t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    headRight.appendChild(time);
    if (g.chart && g.chart.length) {
      const plotBtn = document.createElement('button');
      plotBtn.className = 'hist-plot-btn';
      plotBtn.textContent = '📈';
      plotBtn.title = 'win probability chart';
      plotBtn.addEventListener('click', () => {
        const box = card.querySelector('.wp-mini');
        const open = !box.hidden;
        box.hidden = open;
        if (open) histOpen.delete(g.no); else histOpen.add(g.no);
        plotBtn.classList.toggle('on', !open);
      });
      headRight.appendChild(plotBtn);
    }
    head.appendChild(headRight);
    card.appendChild(head);

    const list = g.players.slice().sort((a, b) => b.grand - a.grand);
    const maxp = Math.max(1, list[0].grand);
    for (const p of list) {
      const lr = document.createElement('div');
      lr.className = 'hist-line' + (g.finished && p.grand === list[0].grand ? ' w' : '');
      const bar = document.createElement('div');
      bar.className = 'hist-bar';
      bar.style.width = Math.max(6, Math.round((p.grand / maxp) * 100)) + '%';
      const nm = document.createElement('span');
      nm.className = 'hist-nm';
      nm.textContent = p.name;
      const sc = document.createElement('span');
      sc.className = 'hist-sc';
      sc.textContent = String(p.grand);
      lr.appendChild(bar);
      lr.appendChild(nm);
      lr.appendChild(sc);
      card.appendChild(lr);
    }

    // win probability chart per game; expanded state survives polls
    if (g.chart && g.chart.length) {
      const mini = document.createElement('div');
      mini.className = 'wp-mini';
      mini.hidden = !histOpen.has(g.no);
      mini.appendChild(winChartSvg(g.chart, list));
      card.appendChild(mini);
    }
    hv.appendChild(card);
  }
}

// tiny static win-prob chart: polylines colored by final standings
function winChartSvg(chart, list) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const W = 300;
  const H = 84;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('wp-svg', 'wp-mini-svg');
  const n = Math.max(...chart.map((c) => c.probs.length));
  const xAt = (i) => (W * i) / Math.max(1, n - 1);
  const yAt = (p) => H - 6 - (H - 12) * p;
  const mid = document.createElementNS(svgNS, 'line');
  mid.setAttribute('x1', 0); mid.setAttribute('x2', W);
  mid.setAttribute('y1', yAt(0.5)); mid.setAttribute('y2', yAt(0.5));
  mid.setAttribute('class', 'wp-mid');
  svg.appendChild(mid);
  for (const c of chart) {
    const pl = document.createElementNS(svgNS, 'polyline');
    pl.setAttribute('points', c.probs.map((p, i) => xAt(i).toFixed(1) + ',' + yAt(p).toFixed(1)).join(' '));
    const rank = list.findIndex((x) => x.name === c.name);
    pl.setAttribute('stroke', CHART_COLORS[(rank < 0 ? 0 : rank) % CHART_COLORS.length]);
    pl.setAttribute('fill', 'none');
    svg.appendChild(pl);
  }
  const wrap = document.createElement('div');
  wrap.className = 'wp-mini-wrap';
  wrap.appendChild(svg);
  // legend: color swatch + final win probability per player
  const legend = document.createElement('div');
  legend.className = 'wp-legend';
  for (const c of chart) {
    const rank = list.findIndex((x) => x.name === c.name);
    const color = CHART_COLORS[(rank < 0 ? 0 : rank) % CHART_COLORS.length];
    const item = document.createElement('span');
    item.className = 'wp-item';
    const sw = document.createElement('i');
    sw.style.background = color;
    item.appendChild(sw);
    const last = c.probs[c.probs.length - 1] || 0;
    item.appendChild(document.createTextNode(c.name + ' ' + Math.round(last * 100) + '%'));
    legend.appendChild(item);
  }
  wrap.appendChild(legend);
  return wrap;
}

// ---------- win overlay ----------
let winBuiltFor = null; // gameKey the overlay was last built for

function maybeShowWin(prev) {
  const gen = state.started && everyoneDone() ? 1 : 0;
  if (!gen) {
    winEl.hidden = true;
    winBuiltFor = null;
    return;
  }
  const key = gameKey();
  if (winDismissedFor === key) {
    winEl.hidden = true;
    return;
  }
  // build once per finished game: random stat chips must not reshuffle
  // on every 1.5 s poll, and the chart keeps its scrub position
  if (winBuiltFor !== key) {
    winBuiltFor = key;
    buildWin();
  }
  winEl.hidden = false;
}

function gameKey() {
  return state.players.length + ':' + state.players.map((p) => filledCount(p.sheet)).join('');
}

function buildWin() {
  const list = sortedPlayers();
  const winner = list[0].p;
  const head = $('#win-head');
  head.innerHTML = '';
  const trophy = document.createElement('div');
  trophy.className = 'trophy';
  trophy.textContent = '🏆';
  const nm = document.createElement('div');
  nm.className = 'win-name';
  const leaders = countLeaders();
  if (leaders > 1) {
    nm.textContent = 'Draw!';
    nm.classList.remove('win-name');
    nm.style.color = 'var(--accent2)';
    nm.style.fontSize = '26px';
    nm.style.fontWeight = '800';
    nm.textContent = list.slice(0, leaders).map((x) => x.p.name).join(' & ') + ' win!';
  } else {
    nm.textContent = winner.name + ' wins!';
  }
  const sub = document.createElement('div');
  sub.className = 'win-sub';
  sub.textContent = `${winner.totals.grand} points in ${state.players.length} player game`;
  head.appendChild(trophy);
  head.appendChild(nm);
  head.appendChild(sub);

  const st = $('#win-standings');
  st.innerHTML = '';
  list.forEach(({ p, idx }, rank) => {
    const row = document.createElement('div');
    row.className = 'win-row';
    row.textContent = `${rank + 1}. ${p.name}`;
    const pts = document.createElement('span');
    pts.className = 'pts';
    pts.textContent = String(p.totals.grand);
    row.appendChild(pts);
    st.appendChild(row);
  });

  // game-summary chips: a rotating random pool — most games earn more
  // candidate chips than fit, so every visit/show looks a bit different
  const stats = $('#win-stats');
  stats.innerHTML = '';
  const pool = [];
  const add = (t) => pool.push(t);

  const withKniffel = state.players.filter((p) => p.sheet.kniffel === 50);
  if (withKniffel.length) add(`🎲 Kniffel: ${withKniffel.map((p) => p.name).join(', ')}`);
  const withKniffelBonus = state.players.filter((p) => p.totals.kniffelBonus > 0);
  if (withKniffelBonus.length) add(`🎲 bonus Kniffel: ${withKniffelBonus.map((p) => p.name).join(', ')} (+${Math.max(...withKniffelBonus.map((p) => p.totals.kniffelBonus))})`);
  const withBonus = state.players.filter((p) => p.totals.upperBonus > 0);
  add(`📈 63+ bonus: ${withBonus.length ? withBonus.map((p) => p.name).join(', ') : 'nobody'}`);
  const scratchCount = (p) => CAT_ORDER.filter((c) => p.sheet[c] === 0).length;
  const minSc = Math.min(...state.players.map(scratchCount));
  if (minSc === 0) add(`🛡️ flawless: ${state.players.filter((p) => scratchCount(p) === 0).map((p) => p.name).join(', ')} — not a single scratch`);
  else add(`🛡️ toughest nerves: ${state.players.filter((p) => scratchCount(p) === minSc).map((p) => p.name).join(', ')} (only ${minSc} scratch)`);
  const mostScr = Math.max(...state.players.map(scratchCount));
  if (mostScr >= 2) add(`💀 scratch king: ${state.players.filter((p) => scratchCount(p) === mostScr).map((p) => p.name).join(', ')} (${mostScr} crossed out)`);
  const bestCat = (() => {
    let best = null;
    for (const p of state.players) {
      for (const c of CAT_ORDER) {
        if (p.sheet[c] !== null && p.sheet[c] !== undefined && (!best || p.sheet[c] > best.v)) {
          best = { p, c, v: p.sheet[c] };
        }
      }
    }
    return best;
  })();
  if (bestCat && bestCat.v > 0) add(`⭐ best entry: ${bestCat.v} ${CAT_LABELS[bestCat.c]} by ${bestCat.p.name}`);
  // upper-section duel: strongest half-sheet
  const bestUpper = state.players.slice().sort((a, b) => b.totals.upper - a.totals.upper)[0];
  if (bestUpper) add(`🧠 upper master: ${bestUpper.name} (${bestUpper.totals.upper} top${bestUpper.totals.upperBonus ? ' + bonus' : ''})`);
  // tightest finish
  if (list.length >= 2 && list[0].p.totals.grand - list[1].p.totals.grand <= 10) {
    add(`🔥 photo finish: ${list[0].p.totals.grand - list[1].p.totals.grand === 0 ? 'tie at' : 'only ' + (list[0].p.totals.grand - list[1].p.totals.grand) + ' points between'} ${list[0].p.name} & ${list[1].p.name}`);
  }
  // biggest single scratch (largest opportunity zeroed)
  const worstScratch = (() => {
    let w = null;
    for (const p of state.players) {
      for (const c of CAT_ORDER) {
        if (p.sheet[c] === 0 && ['fullHouse', 'smallStraight', 'largeStraight', 'kniffel'].includes(c)) {
          const cost = { fullHouse: 25, smallStraight: 30, largeStraight: 40, kniffel: 50 }[c];
          if (!w || cost > w.cost) w = { p, c, cost };
        }
      }
    }
    return w;
  })();
  if (worstScratch) add(`💀 costliest scratch: ${CAT_LABELS[worstScratch.c]} crossed by ${worstScratch.p.name} (-${worstScratch.cost})`);
  // straight collector
  const straighter = state.players.filter((p) => p.sheet.smallStraight === 30 || p.sheet.largeStraight === 40);
  if (straighter.length) add(`🛣️ straight driver: ${straighter.map((p) => p.name).join(', ')}`);
  // score spread
  if (list.length >= 2) {
    const spread = list[0].p.totals.grand - list[list.length - 1].p.totals.grand;
    if (spread >= 80) add(`🚀 blowout: ${spread} points from ${list[0].p.name} to ${list[list.length - 1].p.name}`);
  }
  // comeback story (from the win-prob chart: min prob of the winner)
  if (state.chart) {
    const wc = state.chart.find((c) => c.name === winner.name);
    if (wc && wc.probs.length > 4) {
      const minP = Math.min(...wc.probs);
      const at = wc.probs.indexOf(minP);
      if (minP < 0.35 && at < wc.probs.length - 2) {
        add(`🔄 comeback: ${winner.name} was down to ${Math.round(minP * 100)}% mid-game`);
      }
    }
  }
  // lucky last entry: the final move decided the winner
  if (list.length >= 2 && list[0].p.totals.grand - list[1].p.totals.grand <= 5) {
    add(`🎯 last-roll drama: ${list[0].p.name} sealed it at the buzzer`);
  }

  // shuffle the pool, keep 4-5 chips
  const out = pool.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  const keep = Math.min(pool.length, 4 + (Math.random() < 0.5 ? 1 : 0));
  for (const t of out.slice(0, keep)) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = t;
    stats.appendChild(chip);
  }

  // win-probability chart over the game
  if (state.chart && state.chart.length) {
    const box = document.createElement('div');
    box.className = 'wp-box-title';
    box.textContent = 'Win probability';
    $('#win-chart').appendChild(box);
    winChart();
  }
}

$('#win-close').addEventListener('click', () => {
  winDismissedFor = gameKey();
  winEl.hidden = true;
});

// ---------- win probability chart (chess.com style) ----------
const CHART_COLORS = ['#ffb74d', '#4db6ac', '#ce93d8', '#e57373', '#64b5f6', '#aed581'];

function winChart() {
  const host = $('#win-chart');
  host.innerHTML = '';
  const chart = state && state.chart;
  const list = sortedPlayers();
  const W = 320;
  const H = 110;
  const padL = 2;
  const padR = 2;
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.classList.add('wp-svg');

  const n = chart ? Math.max(...chart.map((c) => c.probs.length)) : 0;
  const xAt = (i) => padL + ((W - padL - padR) * i) / Math.max(1, n - 1);
  const yAt = (p) => H - 8 - (H - 16) * p;

  // 50% guide line
  const mid = document.createElementNS(svgNS, 'line');
  mid.setAttribute('x1', 0); mid.setAttribute('x2', W);
  mid.setAttribute('y1', yAt(0.5)); mid.setAttribute('y2', yAt(0.5));
  mid.setAttribute('class', 'wp-mid');
  svg.appendChild(mid);

  const curves = [];
  if (chart) {
    for (const c of chart) {
      const pl = document.createElementNS(svgNS, 'polyline');
      const pts = c.probs.map((p, i) => xAt(i).toFixed(1) + ',' + yAt(p).toFixed(1)).join(' ');
      pl.setAttribute('points', pts);
      const color = (CHART_COLORS[list.findIndex((x) => x.p.id === c.id) % CHART_COLORS.length]);
      pl.setAttribute('stroke', color);
      pl.setAttribute('fill', 'none');
      svg.appendChild(pl);
      curves.push({ c, color });
    }
  }

  // scrubber: follow touch/mouse, show probabilities under the finger
  const cross = document.createElementNS(svgNS, 'line');
  cross.setAttribute('class', 'wp-cross');
  cross.setAttribute('y1', 0); cross.setAttribute('y2', H);
  cross.setAttribute('visibility', 'hidden');
  svg.appendChild(cross);

  const box = document.createElement('div');
  box.className = 'wp-tip';
  box.hidden = true;
  host.appendChild(svg);
  host.appendChild(box);

  const legend = document.createElement('div');
  legend.className = 'wp-legend';
  const rowsLeft = [];
  for (const { c, color } of curves) {
    const last = c.probs[c.probs.length - 1];
    const item = document.createElement('span');
    item.className = 'wp-item';
    const sw = document.createElement('i');
    sw.style.background = color;
    item.appendChild(sw);
    const nm = document.createTextNode(c.name + ' ');
    item.appendChild(nm);
    const pc = document.createElement('b');
    pc.textContent = Math.round((last || 0) * 100) + '%';
    item.appendChild(pc);
    item.dataset.ci = String(curves.indexOf({ c, color }));
    legend.appendChild(item);
    rowsLeft.push({ item, pc, c });
  }
  host.appendChild(legend);

  if (curves.length && n > 0) {
    const showAt = (clientX) => {
      const rect = svg.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const idx = Math.round(frac * (n - 1));
      cross.setAttribute('x1', xAt(idx));
      cross.setAttribute('x2', xAt(idx));
      cross.setAttribute('visibility', 'visible');
      box.hidden = false;
      box.textContent = curves.map(({ c, color }) => {
        const v = Math.round((c.probs[idx] || 0) * 100);
        return v + '% ' + c.name;
      }).reverse().join(' · ');
      for (const r of rowsLeft) {
        r.pc.textContent = Math.round((r.c.probs[idx] || 0) * 100) + '%';
      }
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      box.hidden = true;
      for (const r of rowsLeft) {
        const last = r.c.probs[r.c.probs.length - 1] || 0;
        r.pc.textContent = Math.round(last * 100) + '%';
      }
    };
    svg.addEventListener('pointermove', (e) => showAt(e.clientX));
    svg.addEventListener('pointerdown', (e) => showAt(e.clientX));
    svg.addEventListener('pointerleave', hide);
  }
}
$('#win-new-game').addEventListener('click', async () => {
  if (!confirm('Start a new game? All scores will be cleared.')) return;
  winDismissedFor = 0;
  const res = await api('reset', {});
  if (res && res.state) applyState(res.state);
});

$('#win-reset-table').addEventListener('click', async () => {
  if (!confirm('Reset the whole table? All players will be removed and must join again.')) return;
  winDismissedFor = 0;
  const res = await api('reset-table', {});
  if (res && res.state) applyState(res.state);
});

// ---------- render ----------
function render(prev) {
  if (!state) return;
  // win overlay state must be resolved FIRST: render() has early returns
  // (lobby / join screen) and a finished-game overlay would otherwise
  // stay stuck on top of them after a reset
  maybeShowWin(prev);
  const me = state.players.find((p) => p.id === state.you);
  const joined = !!me;

  joinView.hidden = joined;
  gameView.hidden = !joined;
  // burger visible even on the join screen so history/leaderboard are
  // browsable before sitting down
  $('#burger').hidden = !state ? true : false;
  if (!joined) {
    $('#play').hidden = true;
    $('#lobby').hidden = true;
    if (view === 'history') renderHistory();
    else if (view === 'leaderboard') renderLeaderboard();
    const hv = $('#history-view');
    hv.hidden = view !== 'history';
    const lv = $('#leaderboard-view');
    lv.hidden = view !== 'leaderboard';
    return;
  }

  $('#lobby').hidden = state.started;
  $('#play').hidden = !state.started;
  $('#start-btn').hidden = state.started;
  $('#reset-btn').hidden = !(state.started && everyoneDone());
  const note = $('#players-note');
  if (note) {
    note.textContent = state.started
      ? `${state.players.length} player${state.players.length > 1 ? 's' : ''} playing`
      : 'Pick a seat at the table (tap any open spot).';
  }

  // burger is always available; drawer nav works in lobby too
  $('#burger').hidden = false;
  syncDrawer();

  // non-sheet views stay reachable even before a game starts
  if (!state.started) {
    $('#opt-turns').checked = !!state.config.enforceTurns;
    $('#opt-turns-row').style.display = state.players.length >= 2 ? '' : 'none';
    $('#opt-one-device').checked = !!state.oneDevice;
    $('#device-add-row').style.display = state.oneDevice ? '' : 'none';
    renderDeviceList();
    renderTable();
    standingsView.hidden = view !== 'standings';
    sheetEl.hidden = true; // lobby: no stale score sheet next to the seat table
    if (view === 'history') renderHistory();
    else if (view === 'leaderboard') renderLeaderboard();
    const hv = $('#history-view');
    hv.hidden = view !== 'history';
    const lv = $('#leaderboard-view');
    lv.hidden = view !== 'leaderboard';
    return;
  }

  // turn banner (enforceTurns games)
  const tb = $('#turn-banner');
  if (state.config.enforceTurns && state.turn && !everyoneDone()) {
    const cur = state.players.find((p) => p.id === state.turn);
    const mine = state.turn === state.you;
    tb.hidden = false;
    tb.className = mine ? 'your-turn' : '';
    tb.textContent = mine
      ? 'Your turn — pick a category on the Sheet tab'
      : `${cur ? cur.name : '?'} is playing`;
  } else {
    tb.hidden = true;
  }

  // undo button: only for the device whose player made the latest scoring
  // move — nobody else gets to rewind someone else's turn. The server
  // enforces the same rule on /undo-turn.
  const undoBtn = $('#undo-turn-btn');
  if (undoBtn) {
    undoBtn.hidden = !state.started || everyoneDone() || state.lastMover !== state.you;
  }

  // burger + drawer active state only make sense while a game runs
  $('#burger').hidden = !state.started;
  syncDrawer();

  // one-device switcher bar on top
  const devBar = $('#dev-bar');
  const mine = state.mine || [];
  devBar.hidden = !(state.oneDevice && mine.length > 1);
  if (!devBar.hidden) {
    const cur = state.players.find((p) => p.id === state.you);
    $('#dev-name').textContent = cur ? cur.name : '—';
  }

  if (view === 'standings') renderStandings();
  else if (view === 'history') renderHistory();
  else if (view === 'leaderboard') renderLeaderboard();
  else {
    // quick strip: mini standings + peek pill (only on the sheet view)
    $('#quick-strip').hidden = view !== 'sheet';
    renderQuickStandings();
    renderSheet();
  }
  // only the active view is shown
  standingsView.hidden = view !== 'standings';
  sheetEl.hidden = view !== 'sheet';
  const hv = $('#history-view');
  hv.hidden = view !== 'history';
  const lv = $('#leaderboard-view');
  lv.hidden = view !== 'leaderboard';
}

// highlight the drawer entry for the active view + peek state
function syncDrawer() {
  for (const b of drawer.querySelectorAll('.drawer-item[data-view]')) {
    b.classList.toggle('active', b.dataset.view === view);
  }
}

// compact standings row + peek state pill on the sheet view
function renderQuickStandings() {
  const host = $('#quick-standings');
  const peekBtn = $('#peek-btn');
  if (!host || !peekBtn) return;
  peekBtn.classList.toggle('on', peek);
  peekBtn.title = peek ? 'Peek: others hidden' : 'Peek: everyone visible';
  host.innerHTML = '';
  for (const { p } of sortedPlayers()) {
    const chip = document.createElement('div');
    chip.className = 'q-chip' + (p.id === state.you ? ' me' : '') + (p.finished ? ' done' : '');
    const nm = document.createElement('span');
    nm.className = 'q-nm';
    nm.textContent = p.name;
    const sc = document.createElement('span');
    sc.className = 'q-pts';
    // privacy: hide others' totals while peek is on
    sc.textContent = (peek && p.id !== state.you) ? '·' : String(p.totals.grand);
    chip.appendChild(nm);
    chip.appendChild(sc);
    host.appendChild(chip);
  }
}

function everyoneDone() {
  return state.players.length > 0 && state.players.every((p) => p.finished);
}

// long-press detection (500ms) for editing own filled cells
function attachLongPress(el, fn) {
  let timer = null;
  let moved = false;
  const start = (e) => {
    moved = false;
    timer = setTimeout(() => { if (!moved) fn(); }, 500);
  };
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', () => { moved = true; cancel(); }, { passive: true });
  el.addEventListener('touchend', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel, { passive: true });
  el.addEventListener('mousedown', start);
  el.addEventListener('mouseup', cancel);
  el.addEventListener('mouseleave', cancel);
}

function renderSheet() {
  sheetEl.innerHTML = '';
  // semantic table: header names can never wrap onto separate lines the way
  // flex cells could on some mobile browsers
  const table = document.createElement('table');
  table.className = 'sheet-table';
  // your column always first, everyone else after (by seat)
  const me = state.players.find((p) => p.id === state.you);
  const cols = me
    ? [me].concat(state.players.filter((p) => p !== me))
    : state.players;
  const hideOthers = peek && cols.length > 1;
  const shown = hideOthers ? [me] : cols;

  // header row
  const thead = document.createElement('thead');
  const head = row('head-row');
  head.appendChild(cbox('th', 'cat-label', 'player'));
  cols.forEach((p) => {
    if (hideOthers && p !== me) return;
    const th = cbox('th', 'cellbox', '');
    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = p.name;
    th.appendChild(n);
    head.appendChild(th);
  });
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Section header row (upper)
  const secUp = row('sheet-section-header');
  secUp.appendChild(cbox('th', 'cat-label', 'Upper'));
  for (let i = 0; i < shown.length; i++) secUp.appendChild(cbox('td', 'cellbox', ''));
  tbody.appendChild(secUp);

  // category rows
  CAT_ORDER.forEach((cat, idx) => {
    const rowDiv = row('sheet-row' + (cat === 'kniffel' ? ' kniffel-row' : ''));
    rowDiv.appendChild(cbox('th', 'cat-label', CAT_LABELS[cat]));
    cols.forEach((p) => {
      if (hideOthers && p !== me) return;
      const v = p.sheet[cat];
      const c = cbox('td', 'cellbox', '');
      const own = p.id === state.you;
      const myTurn = !state.config.enforceTurns || state.turn === state.you;
      if (v === null || v === undefined) {
        if (state.started && !p.finished && own && myTurn) {
          c.classList.add('scoreable', 'mine');
          c.addEventListener('click', () => openPicker(cat, p.name));
        } else {
          c.classList.add('scoreable');
          c.style.opacity = '0.25';
        }
        c.textContent = '\u00B7';
      } else {
        c.classList.add('filled');
        if (v === 0) c.classList.add('scratch');
        const def = deficitLabel(cat, v);
        if (def) {
          c.appendChild(document.createTextNode(String(v)));
          const s = document.createElement('span');
          s.className = 'cell-def' + (v - DEFICIT_ANCHOR[cat] >= 0 ? ' pos' : ' neg');
          s.textContent = def;
          c.appendChild(s);
        } else {
          c.textContent = String(v);
        }
        const pulse = fxPulses.get(p.id + ':' + cat);
        if (pulse && Date.now() - pulse.t < 2500) {
          c.classList.add('pulse', pulse.cls);
          setTimeout(() => c.classList.remove('pulse', pulse.cls), 1400);
        } else {
          fxPulses.delete(p.id + ':' + cat);
        }
        // own filled cells stay editable at any time — long-press to
        // correct a misentry, even out of turn (server allows edits
        // out of turn but never new entries)
        if (state.started && own) {
          c.classList.add('editable');
          attachLongPress(c, () => openPicker(cat, p.name, true));
        }
      }
      rowDiv.appendChild(c);
    });
    tbody.appendChild(rowDiv);
    if (idx === 5) {
      rowDiv.classList.add('section-div'); // upper | lower split
      // Section header row (lower) inserted after sixes
      const secDn = row('sheet-section-header');
      secDn.appendChild(cbox('th', 'cat-label', 'Lower'));
      for (let i = 0; i < shown.length; i++) secDn.appendChild(cbox('td', 'cellbox', ''));
      tbody.appendChild(secDn);
    }
  });

  // totals rows
  const totals = [
    { label: 'Upper', key: 'upper', cls: 'sum-cell', div: true },
    { label: 'Bonus 63+', key: 'upperBonus', cls: (t) => (t.upperBonus > 0 ? 'bonus-on' : 'bonus-off') },
    { label: 'Lower', key: 'lower', cls: 'sum-cell' },
    { label: 'X-Kniffel', key: 'kniffelBonus', cls: (t) => (t.kniffelBonus > 0 ? 'bonus-on' : 'bonus-off') },
    { label: 'TOTAL', key: 'grand', cls: 'grand-cell' },
  ];
  totals.forEach((row_) => {
    const div = row('sheet-row' + (row_.div ? ' section-div' : ''));
    div.appendChild(cbox('th', 'cat-label', row_.label));
    cols.forEach((p) => {
      if (hideOthers && p !== me) return;
      const cls = typeof row_.cls === 'function' ? row_.cls(p.totals) : row_.cls;
      div.appendChild(cbox('td', 'cellbox ' + cls, String(p.totals[row_.key])));
    });
    tbody.appendChild(div);
  });

  table.appendChild(tbody);
  sheetEl.appendChild(table);
}

function row(cls) {
  const d = document.createElement('tr');
  if (cls) d.className = cls;
  return d;
}
function cbox(tag, cls, text) {
  const d = document.createElement(tag);
  d.className = cls;
  if (text) d.textContent = text;
  return d;
}

refreshLoop();
