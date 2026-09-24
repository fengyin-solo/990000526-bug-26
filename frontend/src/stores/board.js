import { defineStore } from 'pinia'
import { ref } from 'vue'
import { boardApi, columnApi, cardApi } from '../api/index.js'

export const useBoardStore = defineStore('board', () => {
  const boards = ref([])
  const currentBoard = ref(null)
  const columns = ref([])
  const cards = ref({}) // keyed by columnId -> [cards]
  const loading = ref(false)

  // Board actions
  async function fetchBoards() {
    loading.value = true
    try {
      const res = await boardApi.list()
      boards.value = res.data
    } finally {
      loading.value = false
    }
  }

  async function createBoard(name, description) {
    const res = await boardApi.create(name, description)
    boards.value.unshift(res.data)
    return res.data
  }

  async function deleteBoard(id) {
    await boardApi.delete(id)
    boards.value = boards.value.filter(b => b.id !== id)
  }

  // Column actions
  async function fetchColumns(boardId) {
    loading.value = true
    try {
      const res = await columnApi.list(boardId)
      columns.value = res.data
      // Preserve already-loaded cards while initializing new columns; wiping
      // the map here would briefly make every column's count read 0.
      const nextCards = {}
      for (const col of res.data) {
        nextCards[col.id] = cards.value[col.id] || []
      }
      cards.value = nextCards
    } finally {
      loading.value = false
    }
  }

  async function addColumn(boardId, name) {
    const res = await columnApi.create(boardId, name)
    columns.value.push(res.data)
    cards.value[res.data.id] = []
    return res.data
  }

  async function renameColumn(colId, name) {
    const res = await columnApi.update(colId, { name })
    const idx = columns.value.findIndex(c => c.id === colId)
    if (idx !== -1) columns.value[idx] = res.data
    return res.data
  }

  async function deleteColumn(colId) {
    await columnApi.delete(colId)
    columns.value = columns.value.filter(c => c.id !== colId)
    delete cards.value[colId]
  }

  async function reorderColumn(colId, newPosition) {
    const res = await columnApi.update(colId, { position: newPosition })
    // Refresh columns to get correct order
    if (currentBoard.value) {
      await fetchColumns(currentBoard.value.id)
    }
    return res.data
  }

  // Card actions
  async function fetchCards(columnId) {
    const res = await cardApi.list(columnId)
    cards.value[columnId] = res.data
    return res.data
  }

  async function fetchAllCards(boardId) {
    // Fetch cards for all columns in parallel
    const cols = columns.value
    const promises = cols.map(col => cardApi.list(col.id))
    const results = await Promise.all(promises)
    cols.forEach((col, i) => {
      cards.value[col.id] = results[i].data
    })
  }

  async function addCard(columnId, data) {
    const res = await cardApi.create(columnId, data)
    if (!cards.value[columnId]) cards.value[columnId] = []
    cards.value[columnId].push(res.data)
    return res.data
  }

  async function updateCard(cardId, data) {
    const res = await cardApi.update(cardId, data)
    // Update card in the local state
    for (const colId in cards.value) {
      const idx = cards.value[colId].findIndex(c => c.id === cardId)
      if (idx !== -1) {
        cards.value[colId][idx] = res.data
        break
      }
    }
    return res.data
  }

  async function deleteCard(cardId) {
    await cardApi.delete(cardId)
    for (const colId in cards.value) {
      cards.value[colId] = cards.value[colId].filter(c => c.id !== cardId)
    }
  }

  // --- Card moves ----------------------------------------------------------
  // Single source of truth for cross-column movement and in-column reordering,
  // used identically by drag & drop, card menu move, detail dialog and retries.
  //
  // Rules (mirrored by the backend /api/cards/:id/move endpoint):
  //   * position is the insertion index inside the target column
  //   * same-column range is [0, n-1], cross-column range is [0, n]
  //   * the server response is the only canonical result
  //   * on failure the whole board is refetched so local and server state can
  //     never diverge (no card can remain in two columns)
  let moveQueue = Promise.resolve()

  function findCard(cardId) {
    for (const colId in cards.value) {
      const list = cards.value[colId]
      const idx = list.findIndex(c => c.id === cardId)
      if (idx !== -1) return { columnId: Number(colId), index: idx, list }
    }
    return null
  }

  // Rewrite local state to "card is at target index", regardless of its
  // previous state. Idempotent: calling it again with the same arguments
  // produces the same arrays, which is what makes retries safe.
  function applyLocalMove(cardId, targetColumnId, targetIndex) {
    let movedCard = null
    for (const colId in cards.value) {
      const list = cards.value[colId]
      const idx = list.findIndex(c => c.id === cardId)
      if (idx !== -1) {
        movedCard = list[idx]
        cards.value[colId] = list.filter(c => c.id !== cardId)
      }
    }
    if (!movedCard) return false
    if (!cards.value[targetColumnId]) cards.value[targetColumnId] = []
    const list = [...cards.value[targetColumnId]]
    const clamped = Math.min(Math.max(targetIndex, 0), list.length)
    movedCard = { ...movedCard, column_id: targetColumnId }
    list.splice(clamped, 0, movedCard)
    cards.value[targetColumnId] = list
    return true
  }

  function renumberAll() {
    for (const colId in cards.value) {
      cards.value[colId].forEach((card, index) => {
        if (card.position !== index || card.column_id !== Number(colId)) {
          card.position = index
          card.column_id = Number(colId)
        }
      })
    }
  }

  // Recovery standard: reload all cards from the server. Used for every failed
  // move, so drag, menu, dialog and re-entry converge to the same state.
  async function resyncCards() {
    const boardId = currentBoard.value?.id
    if (boardId) await fetchAllCards(boardId)
  }

  function moveCard(cardId, targetColumnId, position) {
    targetColumnId = Number(targetColumnId)
    const task = moveQueue.then(async () => {
      const before = findCard(cardId)
      if (!before) {
        await resyncCards()
        throw new Error('Card not found in current board state')
      }
      if (!columns.value.some(col => Number(col.id) === targetColumnId)) {
        await resyncCards()
        throw new Error('Target column not found in current board state')
      }

      const sameColumn = before.columnId === targetColumnId
      const targetList = cards.value[targetColumnId]
      const upperBound = sameColumn ? targetList.length - 1 : targetList.length
      const targetIndex = position === undefined || position === null
        ? upperBound
        : Math.min(Math.max(Number(position), 0), upperBound)

      if (!(sameColumn && targetIndex === before.index)) {
        applyLocalMove(cardId, targetColumnId, targetIndex)
      }

      try {
        const res = await cardApi.move(cardId, targetColumnId, targetIndex)
        // Canonicalize from the server response: replace card content and
        // position, then realign every column to gap-free index numbering.
        const canonical = res.data
        const local = findCard(cardId)
        if (local) {
          local.list[local.index] = { ...local.list[local.index], ...canonical }
        }
        renumberAll()
        return canonical
      } catch (err) {
        await resyncCards()
        throw err
      }
    })
    // Keep the chain alive even when this individual move fails.
    moveQueue = task.catch(() => {})
    return task
  }

  function clearBoard() {
    currentBoard.value = null
    columns.value = []
    cards.value = {}
  }

  return {
    boards, currentBoard, columns, cards, loading,
    fetchBoards, createBoard, deleteBoard,
    fetchColumns, addColumn, renameColumn, deleteColumn, reorderColumn,
    fetchCards, fetchAllCards, addCard, updateCard, deleteCard, moveCard,
    clearBoard
  }
})
