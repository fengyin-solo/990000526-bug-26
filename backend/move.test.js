/**
 * End-to-end checks for the unified card move rules.
 * Run from backend/: node --test move.test.js
 *
 * Starts the real API against a throwaway database file, then exercises
 * PUT /api/cards/:id/move over HTTP exactly like the frontend does.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Module = require('node:module');

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-move-'));
const TMP_DB = path.join(TMP_DIR, 'test.db');

// Redirect the hardcoded data/taskboard.db connection to a throwaway file
// without modifying any tracked source file.
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'better-sqlite3') {
    const Database = realLoad.call(this, request, parent, isMain);
    function PatchedDatabase(filename, options) {
      if (typeof filename === 'string' && filename.endsWith('taskboard.db')) {
        filename = TMP_DB;
      }
      return new Database(filename, options);
    }
    PatchedDatabase.prototype = Database.prototype;
    return PatchedDatabase;
  }
  return realLoad.call(this, request, parent, isMain);
};

test.after(() => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

const express = require('express');
const cors = require('cors');
const { initDb } = require('./db/init');
const columnRoutes = require('./routes/columns');
const cardRoutes = require('./routes/cards');
const authRoutes = require('./routes/auth');
const boardRoutes = require('./routes/boards');

const app = express();
app.use(cors());
app.use(express.json());
initDb();
app.use('/api/auth', authRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api', columnRoutes);
app.use('/api', cardRoutes);

let server, base, token;

async function api(method, url, body, useToken = true) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(useToken ? { Authorization: 'Bearer ' + token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function cardsOf(columnId) {
  return (await api('GET', `/api/columns/${columnId}/cards`)).data;
}

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const username = 'user_' + Math.random().toString(36).slice(2, 8);
  let r = await api('POST', '/api/auth/register', { username, password: 'secret' }, false);
  if (r.status !== 201) {
    r = await api('POST', '/api/auth/login', { username, password: 'secret' }, false);
  }
  token = r.data.token;
  assert.ok(token);
});

test.after(() => new Promise(resolve => server.close(resolve)));

async function setupBoard() {
  const board = (await api('POST', '/api/boards', { name: 'B' })).data;
  const mkCol = name => api('POST', `/api/boards/${board.id}/columns`, { name }).then(r => r.data);
  const colA = await mkCol('A');
  const colB = await mkCol('B');
  const mkCard = (colId, title) =>
    api('POST', `/api/columns/${colId}/cards`, { title, priority: 'medium' }).then(r => r.data);
  const a0 = await mkCard(colA.id, 'a0');
  const a1 = await mkCard(colA.id, 'a1');
  const a2 = await mkCard(colA.id, 'a2');
  const b0 = await mkCard(colB.id, 'b0');
  const b1 = await mkCard(colB.id, 'b1');
  return { board, colA, colB, a0, a1, a2, b0, b1 };
}

test('cross-column move inserts at requested index and renumbers both columns gap-free', async () => {
  const { colA, colB, a1 } = await setupBoard();
  const res = await api('PUT', `/api/cards/${a1.id}/move`, { columnId: colB.id, position: 1 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.column_id, colB.id);
  assert.strictEqual(res.data.position, 1);
  assert.strictEqual(res.data.title, 'a1'); // content untouched
  assert.strictEqual(res.data.description, '');

  const a = await cardsOf(colA.id);
  const b = await cardsOf(colB.id);
  assert.deepStrictEqual(a.map(c => [c.title, c.position]), [['a0', 0], ['a2', 1]]);
  assert.deepStrictEqual(b.map(c => [c.title, c.position]), [['b0', 0], ['a1', 1], ['b1', 2]]);
});

test('position above upper bound is clamped (no gap, no duplicate)', async () => {
  const { colA, colB, a2 } = await setupBoard();
  const res = await api('PUT', `/api/cards/${a2.id}/move`, { columnId: colB.id, position: 99 });
  assert.strictEqual(res.data.position, 2);
  const b = await cardsOf(colB.id);
  assert.deepStrictEqual(b.map(c => [c.title, c.position]), [['b0', 0], ['b1', 1], ['a2', 2]]);
  const a = await cardsOf(colA.id);
  assert.deepStrictEqual(a.map(c => c.position), [0, 1]);
});

test('negative position is clamped to zero', async () => {
  const { colB, a0 } = await setupBoard();
  const res = await api('PUT', `/api/cards/${a0.id}/move`, { columnId: colB.id, position: -5 });
  assert.strictEqual(res.data.position, 0);
  const b = await cardsOf(colB.id);
  assert.deepStrictEqual(b.map(c => [c.title, c.position]), [['a0', 0], ['b0', 1], ['b1', 2]]);
});

test('same-column reorder compacts to gap-free sequence', async () => {
  const { colA, a0 } = await setupBoard();
  const res = await api('PUT', `/api/cards/${a0.id}/move`, { columnId: colA.id, position: 2 });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.position, 2);
  const a = await cardsOf(colA.id);
  assert.deepStrictEqual(a.map(c => [c.title, c.position]), [['a1', 0], ['a2', 1], ['a0', 2]]);
});

test('same-column move cannot exceed n-1', async () => {
  const { colA, a0 } = await setupBoard();
  const res = await api('PUT', `/api/cards/${a0.id}/move`, { columnId: colA.id, position: 99 });
  assert.strictEqual(res.data.position, 2);
  const a = await cardsOf(colA.id);
  assert.deepStrictEqual(a.map(c => c.position), [0, 1, 2]);
});

test('retried identical move is idempotent (card exists exactly once, same placement)', async () => {
  const { colA, colB, a1 } = await setupBoard();
  const body = { columnId: colB.id, position: 0 };
  const first = await api('PUT', `/api/cards/${a1.id}/move`, body);
  assert.strictEqual(first.status, 200);
  const second = await api('PUT', `/api/cards/${a1.id}/move`, body);
  assert.strictEqual(second.status, 200);
  const a = await cardsOf(colA.id);
  const b = await cardsOf(colB.id);
  assert.deepStrictEqual(a.map(c => c.title), ['a0', 'a2']);
  assert.deepStrictEqual(b.map(c => c.title), ['a1', 'b0', 'b1']);
  assert.deepStrictEqual(b.map(c => c.position), [0, 1, 2]);
  assert.strictEqual(a.length + b.length, 5);
});

test('multiple sequential cross-column moves converge with no gaps or duplicated cards', async () => {
  const { colA, colB, a0, a1, a2 } = await setupBoard();
  await api('PUT', `/api/cards/${a0.id}/move`, { columnId: colB.id, position: 1 });
  await api('PUT', `/api/cards/${a1.id}/move`, { columnId: colB.id, position: 1 });
  await api('PUT', `/api/cards/${a2.id}/move`, { columnId: colB.id, position: 0 });

  const a = await cardsOf(colA.id);
  const b = await cardsOf(colB.id);
  assert.deepStrictEqual(a, []);
  assert.deepStrictEqual(b.map(c => [c.title, c.position]), [
    ['a2', 0], ['b0', 1], ['a1', 2], ['a0', 3], ['b1', 4]
  ]);
  const ids = b.map(c => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('moving back and forth leaves both columns contiguous and content intact', async () => {
  const { colA, colB, a1, b0 } = await setupBoard();
  await api('PUT', `/api/cards/${a1.id}/move`, { columnId: colB.id, position: 2 });
  await api('PUT', `/api/cards/${b0.id}/move`, { columnId: colA.id, position: 0 });
  await api('PUT', `/api/cards/${a1.id}/move`, { columnId: colA.id, position: 1 });
  const a = await cardsOf(colA.id);
  const b = await cardsOf(colB.id);
  assert.deepStrictEqual(a.map(c => [c.title, c.position]), [['b0', 0], ['a1', 1], ['a0', 2], ['a2', 3]]);
  assert.deepStrictEqual(b.map(c => [c.title, c.position]), [['b1', 0]]);
  const movedA1 = a.find(c => c.title === 'a1');
  assert.strictEqual(movedA1.priority, 'medium');
});

test('invalid inputs are rejected and leave state untouched', async () => {
  const { colA, colB, a0 } = await setupBoard();
  assert.strictEqual((await api('PUT', `/api/cards/${a0.id}/move`, { position: 0 })).status, 400);
  assert.strictEqual((await api('PUT', `/api/cards/${a0.id}/move`, { columnId: colB.id, position: 1.5 })).status, 400);
  assert.strictEqual((await api('PUT', `/api/cards/${a0.id}/move`, { columnId: 999999, position: 0 })).status, 404);
  const a = await cardsOf(colA.id);
  assert.deepStrictEqual(a.map(c => [c.title, c.position]), [['a0', 0], ['a1', 1], ['a2', 2]]);
});
