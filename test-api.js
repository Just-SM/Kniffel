'use strict';

// End-to-end check of the REST API (run against a live test server).
const BASE = 'http://localhost:' + (process.env.PORT || 3199);

function makePlayer(name) {
  let kid = null;
  return {
    name,
    async call(path, body) {
      const res = await fetch(BASE + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(kid ? { cookie: 'kid=' + kid } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setKid = res.headers.get('set-cookie');
      if (setKid) kid = /kid=([^;]+)/.exec(setKid)[1];
      return res.json();
    },
  };
}

function assert(cond, label) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
  if (!cond) process.exitCode = 1;
}

(async () => {
  const A = makePlayer('Alex');
  const B = makePlayer('Sam');
  const C = makePlayer('Kim');

  const st0 = await A.call('state');
  assert(st0.started === false && st0.players.length === 0, 'fresh room');

  const j1 = await A.call('join', { name: 'Alex' });
  const j2 = await B.call('join', { name: 'Sam' });
  const j3 = await C.call('join', { name: 'Kim' });
  assert(j1.ok && j2.ok && j3.ok && j3.state.players.length === 3, 'three seats');
  assert(j3.state.players.every((p, i) => p.seat === i), 'seats filled in order');

  const swap = await C.call('seat', { seat: 0 });
  const seatOrder = swap.state.players.map((p) => ({ n: p.name, s: p.seat }));
  assert(swap.ok && seatOrder[0].s === 0 && seatOrder.find((x) => x.n === 'Alex').s === 2, 'seat swap works');

  const cfg = await A.call('config', { enforceTurns: true });
  assert(cfg.ok && cfg.state.config.enforceTurns === true, 'config toggle');

  const started = await A.call('start', {});
  assert(started.ok && started.state.started === true, 'start');

  const locked = await A.call('config', { enforceTurns: false });
  assert(locked.ok === false, 'config locked after start');
  const moved = await A.call('seat', { seat: 0 });
  assert(moved.ok === false, 'seat locked after start');

  const st = started.state;
  const turn1 = st.turn;
  assert(!!turn1, 'turn assigned');

  // whoever's turn it is scores, turn passes clockwise
  const first = st.players.find((p) => p.id === turn1);
  const caller = [A, B, C].find((c) => c.name !== undefined && first.name.startsWith(c.name.slice(0, 2)));
  const r1 = await caller.call('score', { category: 'ones', value: 3 });
  assert(r1.ok, 'current player can score');
  const st1b = (await caller.call('state'));
  assert(st1b.turn !== turn1, 'turn advanced');

  // enforced turn rejection for others (new entries only)
  const wrong = [A, B, C].filter((c) => c !== caller);
  const rWrong = await wrong[0].call('score', { category: 'twos', value: 4 });
  assert(rWrong.ok === false && /turn/.test(rWrong.error), 'other player rejected');

  // out-of-turn correction of an already-filled cell is allowed and does
  // not advance the turn: caller already filled 'ones', their turn has
  // moved on, but they may still fix that entry.
  const stAfter = await caller.call('state');
  if (stAfter.turn !== turn1) {
    const reEdit = await caller.call('score', { category: 'ones', value: 2 });
    assert(reEdit.ok === true, 'out-of-turn edit of filled cell allowed');
    const stEd = await caller.call('state');
    const ed = stEd.players.find((p) => p.id === stEd.you);
    assert(ed.sheet.ones === 2, 'out-of-turn edit applied');
    assert(stEd.turn === stAfter.turn, 'edit does not advance turn');
    // out-of-turn NEW entry is still rejected for the caller too
    const reNew = await caller.call('score', { category: 'twos', value: 4 });
    if (stEd.turn !== stEd.you) {
      assert(reNew.ok === false && /turn/.test(reNew.error), 'out-of-turn new entry rejected');
    }
  }

  // bad: value still validated
  const rBad = await caller.call('score', { category: 'twos', value: 999 });
  assert(rBad.ok === false, 'invalid value rejected');

  // free-for-all mode: turn enforcement can be re-checked after reset
  const reset0 = await caller.call('reset', {});
  assert(reset0.ok, 'reset mid-test');
  const cfgOff = await A.call('config', { enforceTurns: false });
  assert(cfgOff.ok && cfgOff.state.config.enforceTurns === false, 'config off after reset');
  const s2 = await A.call('start', {});
  const gh = await A.call('score', { category: 'fullHouse', value: 25 });
  const kn = await A.call('score', { category: 'kniffel', value: 50 });
  const ch = await A.call('score', { category: 'chance', value: 24 });
  const fresh = await A.call('state');
  const me = fresh.players.find((p) => p.id === fresh.you);
  const other = await B.call('state');
  const otherMe = other.players.find((p) => p.id === other.you);
  assert(me.sheet.fullHouse === 25 && me.sheet.kniffel === 50 && me.sheet.chance === 24, 'scores kept');
  assert(otherMe.sheet.fullHouse === null, 'isolation between players');
  assert(me.totals.kniffelBonus === 0 && me.totals.lower === 99 && me.totals.grand === 99, 'totals');

  const edit = await A.call('score', { category: 'chance', value: 20 });
  const afterEdit = await A.call('state');
  const meEdited = afterEdit.players.find((p) => p.id === afterEdit.you);
  assert(edit.ok && meEdited.sheet.chance === 20 && meEdited.totals.grand === 95, 'own overwrite allowed');
  const editB = await B.call('score', { category: 'ones', value: 3 });
  assert(editB.ok, 'B edits own sheet');

  const dupcat = await A.call('score', { category: 'fullHouse', value: 25 });
  assert(dupcat.ok === true, 'own refill allowed (edit mode)');

  const st1 = await B.call('state');
  assert(st1.players.length === 3, 'three players visible over poll');
  const bYou = st1.players.find((p) => p.id === st1.you);
  assert(bYou.sheet.ones === 3 && bYou.sheet.chance === null, 'B own sheet correct');
  const aSeen = st1.players.find((p) => p.name === 'Alex');
  assert(!!aSeen, 'A visible over poll');

  const reset = await A.call('reset', {});
  assert(reset.ok && reset.state.players.every((p) => p.sheet.fullHouse === null && p.sheet.ones === null), 'reset clears sheets');

  const l = await A.call('leave', {});
  assert(l.ok && l.state.players.length === 2, 'leave removes seat');
})().catch((e) => { console.error('E2E CRASH', e); process.exit(1); });