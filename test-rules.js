'use strict';

const assert = require('assert');
const {
  Kinds,
  isValidValue,
  computeTotals,
  filledCount,
  isFinished,
} = require('./server/rules');

// upper singles
assert.deepStrictEqual(computeTotals({ ones: 5, twos: 8 }), { upper: 13, upperBonus: 0, lower: 0, kniffelBonus: 0, grand: 13 });
// upper bonus
assert.strictEqual(computeTotals({ ones: 5, twos: 10, threes: 15, fours: 12, fives: 10, sixes: 12 }).upperBonus, 35);
// full house + kniffel bonus
const bonusSheet = { twos: 12, threes: 9, fullHouse: 25, kniffel: 50, chance: 24 };
let t = computeTotals(bonusSheet);
assert.strictEqual(t.upper, 21);
assert.strictEqual(t.lower, 99);
assert.strictEqual(t.kniffelBonus, 0);
// second kniffel: kniffel already 50, chance can also be entered via joker; model second kniffel as bonus column
assert.strictEqual(computeTotals({ kniffel: 50, chance: 50, fourKind: 20 }).kniffelBonus, 50);
assert.strictEqual(computeTotals({ kniffel: 0, chance: 50 }).kniffelBonus, 0);

// pickers
for (const c of Kinds) assert.ok(c.picker.every((v) => isValidValue(c.id, v)), c.id);
assert.strictEqual(isValidValue('fullHouse', 20), false);
assert.strictEqual(isValidValue('fullHouse', 25), true);
assert.strictEqual(isValidValue('smallStraight', 30), true);
assert.strictEqual(isValidValue('largeStraight', 25), false);
assert.strictEqual(isValidValue('kniffel', 50), true);
assert.strictEqual(isValidValue('ones', 6), false);
assert.strictEqual(isValidValue('sixes', 30), true);
assert.strictEqual(isValidValue('chance', 4), false);
assert.strictEqual(isValidValue('nope', 5), false);
assert.strictEqual(isValidValue('chance', 5.5), false);

// fill/finish
const empty = Object.fromEntries(Kinds.map((c) => [c.id, null]));
assert.strictEqual(filledCount(empty), 0);
assert.strictEqual(isFinished(empty), false);
const full = Object.fromEntries(Kinds.map((c) => [c.id, c.picker[0]]));
assert.strictEqual(filledCount(full), Kinds.length);
assert.strictEqual(isFinished(full), true);

// grand total math: upper 65 -> bonus; kniffel 50; chance scratch
t = computeTotals({ ones: 5, twos: 10, threes: 15, fours: 20, fives: 5, sixes: 18, kniffel: 50, fullHouse: 25, smallStraight: 30, largeStraight: 40, chance: 23, threeKind: 17, fourKind: 0 });
assert.strictEqual(t.upper, 73);
assert.strictEqual(t.upperBonus, 35);
assert.strictEqual(t.lower, 185);
assert.strictEqual(t.grand, 293);

console.log('all rules tests passed');