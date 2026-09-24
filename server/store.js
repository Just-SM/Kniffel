'use strict';

// Minimal dependency-free archive for played games: one JSON file, loaded at
// boot, rewritten (atomically) whenever a game is archived.

const fs = require('fs');
const path = require('path');

const FILE = process.env.KNIFFEL_DATA
  || path.join(__dirname, '..', 'data', 'games.json');

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(j.games)) return j;
  } catch (e) { /* first run or unreadable -> start empty */ }
  return { version: 1, games: [] };
}

function save(db) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, FILE);
  } catch (e) {
    console.error('game archive save failed:', e.message);
  }
}

module.exports = { load, save, FILE };