/**
 * Unit tests for the board store's unified moveCard rules.
 * Run from frontend/: node --test --experimental-loader ./store.test.loader.js store.test.js
 *
 * The api layer is replaced by an in-memory mock that simulates the server's
 * canonicalization (the same rules covered by the backend HTTP tests), so we
 * can verify serialization, clamping and the resync-on-failure recovery.
 */
import test from 'node:test';
import assert from 'node:assert';
import { createPinia, setActivePinia } from 'pinia';
import { setHandler, failNext, resetState } from './mock-api.js';

let useBoardStore;

test.before(async () => {
  setActivePinia(createPinia());
  ({ useBoardStore } = await import('./src/stores/board.js'));
});

function freshBoard() {
  resetState();
  const store = useBoardStore();
  store.currentBoard = { id: 1, name: 'B' };
  store.columns = [
    { id: 1, name: 'A', position: 0, card_count: 0 },
    { id: 2, name: 'B', position: 1, card_count: 0 }
  ];
  // A: a0,a1,a2 ; B: b0,b1
  store.cards = {
    1: [
      { id: 101, column_id: 1, position: 0, title: 'a0', description: 'd-a0' },
      { id: 102, column_id: 1, position: 1, title: 'a1', description: 'd-a1' },
      { id: 103, column_id: 1, position: 2, title: 'a2', description: 'd-a2' }
    ],
    2: [
      { id: 201, column_id: 2, position: 0, title: 'b0', description: 'd-b0' },
      { id: 202, column_id: 2, position: 1, title: 'b1', description: 'd-b1' }
    ]
  };
  setHandler({
    // GET cards per column, served from a mutable mirror the server updates
    getList: columnId => null
  });
  return store;
}

function titles(store, columnId) {
  return store.cards[columnId].map(c => c.position + ':' + c.title);
}

test('basic cross-column move: local state and positions canonicalize to server', async () => {
  const store = freshBoard();
  const moved = await store.moveCard(102, 2, 1);
  assert.strictEqual(moved.column_id, 2);
  assert.strictEqual(moved.position, 1);
  assert.deepStrictEqual(titles(store, 1), ['0:a0', '1:a2']);
  assert.deepStrictEqual(titles(store, 2), ['0:b0', '1:a1', '2:b1']);
  // content preserved
  assert.strictEqual(store.cards[2][1].description, 'd-a1');
  assert.strictEqual(store.cards[2][1].title, 'a1');
});

test('local out-of-range index is clamped to shared upper bound', async () => {
  const store = freshBoard();
  await store.moveCard(103, 2, 99);
  assert.deepStrictEqual(titles(store, 2), ['0:b0', '1:b1', '2:a2']);
  await store.moveCard(101, 2, -10);
  assert.deepStrictEqual(titles(store, 2), ['0:a0', '1:b0', '2:b1', '3:a2']);
});

test('same-column reorder within range works and renumbers', async () => {
  const store = freshBoard();
  await store.moveCard(101, 1, 2);
  assert.deepStrictEqual(titles(store, 1), ['0:a1', '1:a2', '2:a0']);
});

test('no-op same-column move performs no request churn and keeps state', async () => {
  const store = freshBoard();
  let calls = 0;
  setHandler({ onMove: () => { calls += 1; } });
  await store.moveCard(102, 1, 1);
  // still one API call (idempotent canonicalization) but arrays unchanged
  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(titles(store, 1), ['0:a0', '1:a1', '2:a2']);
});

test('consecutive rapid moves serialize and converge (source/target never错位)', async () => {
  const store = freshBoard();
  // Fire all three without awaiting, like multiple quick drags.
  const results = await Promise.all([
    store.moveCard(101, 2, 1),
    store.moveCard(102, 2, 1),
    store.moveCard(103, 2, 0)
  ]);
  assert.strictEqual(results.length, 3);
  assert.deepStrictEqual(titles(store, 1), []);
  assert.deepStrictEqual(titles(store, 2), ['0:a2', '1:b0', '2:a1', '3:a0', '4:b1']);
  // every card id exists exactly once
  const all = [...store.cards[1], ...store.cards[2]];
  assert.strictEqual(all.length, 5);
  assert.strictEqual(new Set(all.map(c => c.id)).size, 5);
});

test('failed move triggers full resync: card cannot remain in two places', async () => {
  const store = freshBoard();
  // Server keeps canonical state untouched because the failing request never
  // mutated it; the mock's GET endpoints return that canonical state.
  failNext(true);
  await assert.rejects(() => store.moveCard(102, 2, 1), /move failed/);

  // Optimistic local change must be rolled back via resync — a1 is back in
  // column A and there is no duplicate anywhere.
  assert.deepStrictEqual(titles(store, 1), ['0:a0', '1:a1', '2:a2']);
  assert.deepStrictEqual(titles(store, 2), ['0:b0', '1:b1']);
  const count102 = Object.values(store.cards).flat().filter(c => c.id === 102).length;
  assert.strictEqual(count102, 1);
  assert.strictEqual(store.cards[1].find(c => c.id === 102).column_id, 1);
});

test('after a failure the next (retry) move still works through the queue', async () => {
  const store = freshBoard();
  failNext(true);
  await assert.rejects(() => store.moveCard(102, 2, 0), /move failed/);
  // Retry the same intent — must converge.
  const moved = await store.moveCard(102, 2, 0);
  assert.strictEqual(moved.column_id, 2);
  assert.deepStrictEqual(titles(store, 2), ['0:a1', '1:b0', '2:b1']);
  assert.deepStrictEqual(titles(store, 1), ['0:a0', '1:a2']);
});

test('re-entering the board (refetch) shows exactly the server positions', async () => {
  const store = freshBoard();
  await store.moveCard(103, 2, 2);
  // Simulate leaving and re-entering: columns + cards are freshly fetched.
  await store.fetchColumns(1);
  await store.fetchAllCards(1);
  assert.deepStrictEqual(titles(store, 1), ['0:a0', '1:a1']);
  assert.deepStrictEqual(titles(store, 2), ['0:b0', '1:b1', '2:a2']);
});

test('fetchColumns preserves already-loaded cards instead of zeroing counts', async () => {
  const store = freshBoard();
  await store.fetchColumns(1);
  assert.strictEqual(store.cards[1].length, 3);
  assert.strictEqual(store.cards[2].length, 2);
});
