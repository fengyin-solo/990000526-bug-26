/**
 * In-memory fake of src/api/index.js for store tests. Holds a canonical
 * "server" dataset and applies the same move rules the backend endpoint does
 * (park-and-rebuild, gap-free renumbering, index clamping).
 */

let failMove = false;
let moveCallCount = 0;
let onMoveHook = null;

const server = {
  columns: [
    { id: 1, board_id: 1, name: 'A', position: 0, card_count: 0 },
    { id: 2, board_id: 1, name: 'B', position: 1, card_count: 0 }
  ],
  cards: []
};

function seed() {
  server.cards = [
    { id: 101, column_id: 1, position: 0, title: 'a0', description: 'd-a0', priority: 'medium', due_date: null },
    { id: 102, column_id: 1, position: 1, title: 'a1', description: 'd-a1', priority: 'medium', due_date: null },
    { id: 103, column_id: 1, position: 2, title: 'a2', description: 'd-a2', priority: 'medium', due_date: null },
    { id: 201, column_id: 2, position: 0, title: 'b0', description: 'd-b0', priority: 'medium', due_date: null },
    { id: 202, column_id: 2, position: 1, title: 'b1', description: 'd-b1', priority: 'medium', due_date: null }
  ];
}
seed();

export function resetState() {
  failMove = false;
  moveCallCount = 0;
  onMoveHook = null;
  seed();
}

export function failNext(flag = true) {
  failMove = flag;
}

export function setHandler({ onMove } = {}) {
  onMoveHook = onMove || null;
}

function clone(card) {
  return { ...card };
}

function applyMove(cardId, targetColumnId, requestedIndex) {
  const card = server.cards.find(c => c.id === cardId);
  if (!card) throw Object.assign(new Error('not found'), { response: { status: 404 } });
  if (!server.columns.some(col => col.id === targetColumnId)) {
    throw Object.assign(new Error('bad col'), { response: { status: 404 } });
  }
  const peers = server.cards.filter(c => c.column_id === targetColumnId && c.id !== cardId)
    .sort((a, b) => a.position - b.position || a.id - b.id);
  const upper = peers.length;
  const index = requestedIndex === undefined || requestedIndex === null
    ? upper
    : Math.min(Math.max(Number(requestedIndex), 0), upper);

  card.column_id = targetColumnId;
  card.position = -1;
  peers.forEach(p => { p.position = -1; });
  peers.splice(Math.min(index, peers.length), 0, card);
  peers.forEach((p, i) => { p.position = i; });
  return clone(card);
}

export const boardApi = {
  list: async () => ({ data: [{ id: 1, name: 'B' }] }),
  create: async () => ({ data: {} }),
  delete: async () => ({ data: {} })
};

export const columnApi = {
  list: async boardId => ({
    data: server.columns
      .filter(c => c.board_id === boardId)
      .sort((a, b) => a.position - b.position)
      .map(c => ({ ...c, card_count: server.cards.filter(x => x.column_id === c.id).length }))
  }),
  create: async () => ({ data: {} }),
  update: async (id, data) => ({ data: { ...server.columns.find(c => c.id === id), ...data } }),
  delete: async () => ({ data: {} })
};

export const cardApi = {
  list: async columnId => ({
    data: server.cards
      .filter(c => c.column_id === columnId)
      .sort((a, b) => a.position - b.position)
      .map(clone)
  }),
  create: async () => ({ data: {} }),
  update: async (id, data) => {
    const card = server.cards.find(c => c.id === id);
    Object.assign(card, data);
    return { data: clone(card) };
  },
  delete: async () => ({ data: {} }),
  move: async (id, columnId, position) => {
    moveCallCount += 1;
    if (onMoveHook) onMoveHook({ id, columnId, position, count: moveCallCount });
    if (failMove) {
      failMove = false;
      throw Object.assign(new Error('move failed'), { response: { status: 500 } });
    }
    return { data: applyMove(id, Number(columnId), position) };
  }
};

export default {};
