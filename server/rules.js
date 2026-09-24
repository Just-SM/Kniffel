'use strict';

// Kniffel score-sheet rules without dice logic: each category defines the
// set of point values a player may legitimately enter (that is what the
// smart picker shows), plus validation and bonus computation.

const UPPER = ['ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];
const Kinds = [
  { id: 'ones', label: 'Ones', picker: [0, 1, 2, 3, 4, 5] },
  { id: 'twos', label: 'Twos', picker: [0, 2, 4, 6, 8, 10] },
  { id: 'threes', label: 'Threes', picker: [0, 3, 6, 9, 12, 15] },
  { id: 'fours', label: 'Fours', picker: [0, 4, 8, 12, 16, 20] },
  { id: 'fives', label: 'Fives', picker: [0, 5, 10, 15, 20, 25] },
  { id: 'sixes', label: 'Sixes', picker: [0, 6, 12, 18, 24, 30] },
  { id: 'threeKind', label: '3 of a kind', picker: [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] },
  { id: 'fourKind', label: '4 of a kind', picker: [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] },
  { id: 'fullHouse', label: 'Full house', picker: [0, 25] },
  { id: 'smallStraight', label: 'Small straight', picker: [0, 30] },
  { id: 'largeStraight', label: 'Large straight', picker: [0, 40] },
  { id: 'kniffel', label: 'Kniffel', picker: [0, 50] },
  { id: 'chance', label: 'Chance', picker: [0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30] },
];

const CATEGORIES = Object.fromEntries(Kinds.map((c) => [c.id, c]));

const UPPER_BONUS_THRESHOLD = 63;
const UPPER_BONUS = 35;
const KNIFFEL_SCORE = 50;
const KNIFFEL_BONUS = 50;

function isValidValue(catId, value) {
  const cat = CATEGORIES[catId];
  if (!cat) return false;
  if (!Number.isInteger(value)) return false;
  return cat.picker.includes(value);
}

// sheet: { catId: value|null }
function computeTotals(sheet) {
  let upper = 0;
  for (const id of UPPER) upper += sheet[id] || 0;

  let lower = 0;
  let kniffels = 0;
  for (const id of Object.keys(CATEGORIES)) {
    if (UPPER.includes(id)) continue;
    const v = sheet[id] || 0;
    lower += v;
    // A 50 entered outside the Kniffel cell (or a jokered extra Kniffel) is
    // only reachable via the joker rule -> counts as another Kniffel.
    if (id === 'kniffel') {
      if (v === KNIFFEL_SCORE) kniffels += 1;
    } else if (v === KNIFFEL_SCORE && Math.max(...CATEGORIES[id].picker) < KNIFFEL_SCORE) {
      kniffels += 1;
    }
  }

  const upperBonus = upper >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
  const kniffelBonus = Math.max(0, kniffels - 1) * KNIFFEL_BONUS;
  return { upper, upperBonus, lower, kniffelBonus, grand: upper + upperBonus + lower + kniffelBonus };
}

function filledCount(sheet) {
  let n = 0;
  for (const id of Object.keys(CATEGORIES)) if (sheet[id] !== null && sheet[id] !== undefined) n += 1;
  return n;
}

function isFinished(sheet) {
  return filledCount(sheet) === Kinds.length;
}

// Expected grand total for a typical casual game. Center of the
// win-probability model for players with little data yet.
const AVG_GAME = 230;
// Points of standard deviation per unfilled cell, aggregated: how noisy the
// rest of the game is. One cell left -> +-20 swing, full sheet -> +-72.
const SIGMA_PER_SQRT_CELL = 20;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// Standard-normal CDF via the logistic approximation Phi(x) ~ sigmoid(1.702x).
function normCdf(x) {
  return sigmoid(1.702 * x);
}

// chess.com-style after-game eval graph: for every scoring move, the chance
// each player still wins the game at that moment.
// events: [{ pid, grand, filled }] in move order (latest last).
// Returns { [pid]: number[] } — one probability per event index.
function winCurve(events) {
  const curves = {};
  if (!Array.isArray(events) || events.length === 0) return curves;

  const total = {};
  const fills = {};
  const pids = [];
  for (const e of events) {
    if (!(e.pid in total)) { total[e.pid] = 0; fills[e.pid] = 0; pids.push(e.pid); curves[e.pid] = []; }
  }

  // Projected final score: current pace, trusted more as the sheet fills in.
  const proj = (pid) => {
    if (fills[pid] <= 0) return AVG_GAME;
    const pace = (total[pid] * Kinds.length) / fills[pid];
    const trust = Math.min(1, fills[pid] / 6); // early moves are noisy
    return AVG_GAME + (pace - AVG_GAME) * trust;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    total[e.pid] = e.grand;
    fills[e.pid] = e.filled;

    // final move with everyone done -> the actual result, exactly
    if (i === events.length - 1 && pids.every((p) => fills[p] >= Kinds.length)) {
      const best = Math.max(...pids.map((p) => total[p]));
      const winners = pids.filter((p) => total[p] === best);
      for (const p of pids) curves[p].push(+(total[p] === best ? 1 / winners.length : 0).toFixed(3));
      continue;
    }

    // The remaining unfilled cells are the comeback budget: a big lead is
    // only worth little early (lots of dice left to throw) and becomes
    // decisive late. Never exactly 0/1 before the game actually ends.
    const rem = pids.reduce((a, p) => a + (Kinds.length - Math.min(fills[p], Kinds.length)), 0) / pids.length;
    const sigma = SIGMA_PER_SQRT_CELL * Math.sqrt(Math.max(rem, 0.25));
    for (const p of pids) {
      let q = 1;
      for (const o of pids) {
        if (o === p) continue;
        q *= normCdf((proj(p) - proj(o)) / sigma);
      }
      q = Math.max(0.002, Math.min(0.998, q));
      curves[p].push(+q.toFixed(3));
    }
  }
  return curves;
}

module.exports = {
  Kinds,
  CATEGORIES,
  UPPER,
  UPPER_BONUS_THRESHOLD,
  UPPER_BONUS,
  KNIFFEL_SCORE,
  KNIFFEL_BONUS,
  AVG_GAME,
  isValidValue,
  computeTotals,
  filledCount,
  isFinished,
  winCurve,
};