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
      // Initialize cards map
      cards.value = {}
      for (const col of res.data) {
        cards.value[col.id] = []
      }
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
    // Refresh column order and re-pull cards so the cards map stays in sync.
    if (currentBoard.value) {
      await fetchColumns(currentBoard.value.id)
      await fetchAllCards(currentBoard.value.id)
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

  // Serialize move requests per card so consecutive moves (drag, menu,
  // retry) are applied in the exact order the user issued them.
  const moveQueues = {} // cardId -> Promise
  // Resync epoch per card: a failed move resyncs the board and raises the
  // epoch, invalidating moves already queued against stale local state.
  const moveEpochs = {} // cardId -> number

  // Canonical move rules shared by drag, card menu and detail dialog:
  //  - position is a 0-based dense index in the destination column
  //  - allowed range is [0, destination length after removing the card]
  //  - position == null / undefined / out of range -> append to end
  function resolveMove(cardId, targetColumnId, position) {
    let sourceColumnId = null
    let card = null
    for (const colId in cards.value) {
      const idx = cards.value[colId].findIndex(c => c.id === cardId)
      if (idx !== -1) {
        sourceColumnId = colId
        card = cards.value[colId][idx]
        break
      }
    }
    if (!card) return null

    const destKey = targetColumnId === null || targetColumnId === undefined
      ? sourceColumnId
      : String(targetColumnId)
    if (!cards.value[destKey]) return null

    const destCurrentLength = cards.value[destKey].length
    const sameColumn = destKey === sourceColumnId
    // Canonical range is [0, length-after-removal] in every case:
    //   - cross column / menu move : length of destination
    //   - same column              : length - 1
    // The index is always interpreted AFTER removing the card, i.e. the
    // same definition the move API uses. A missing / invalid position
    // means "append to end".
    const upperBound = Math.max(0, destCurrentLength - (sameColumn ? 1 : 0))
    let index
    if (position === null || position === undefined) {
      index = upperBound
    } else {
      const raw = Math.trunc(position)
      // Only integers inside [0, upperBound] are real positions; anything
      // else (negative, NaN, too large) falls back to the end of column.
      index = Number.isInteger(raw) && raw >= 0
        ? Math.min(raw, upperBound)
        : upperBound
    }
    return { card, sourceColumnId, destKey, index }
  }

  function applyMoveLocal(cardId, targetColumnId, position) {
    const resolved = resolveMove(cardId, targetColumnId, position)
    if (!resolved) return null
    const { card, sourceColumnId, destKey, index } = resolved

    const sourceIndex = cards.value[sourceColumnId].findIndex(c => c.id === cardId)
    const unchanged = destKey === sourceColumnId && sourceIndex === index
    if (!unchanged) {
      cards.value[sourceColumnId].splice(sourceIndex, 1)
      card.column_id = Number(destKey)
      cards.value[destKey].splice(index, 0, card)
    }
    renumberColumn(sourceColumnId)
    renumberColumn(destKey)
    return { destKey, index, unchanged }
  }

  function renumberColumn(colId) {
    if (!cards.value[colId]) return
    cards.value[colId].forEach((c, i) => {
      c.column_id = Number(colId)
      c.position = i
    })
  }

  function moveCard(cardId, targetColumnId, position) {
    const epoch = moveEpochs[cardId] || 0

    const run = async () => {
      // Stale if an earlier move of this card failed and resynced the board.
      if ((moveEpochs[cardId] || 0) !== epoch) {
        const err = new Error('superseded by resync')
        err.superseded = true
        throw err
      }

      // Optimistic local transition following the canonical rules.
      const preview = applyMoveLocal(cardId, targetColumnId, position)
      if (!preview) return null
      const { destKey, index, unchanged } = preview

      // Already at the canonical destination/position: nothing to persist.
      if (unchanged) {
        return cards.value[destKey].find(c => c.id === cardId) || null
      }

      try {
        const res = await cardApi.move(cardId, Number(destKey), index)
        // Adopt the server record as authoritative for the moved card;
        // the surrounding cards keep the same dense reindexing.
        for (const colId in cards.value) {
          const idx = cards.value[colId].findIndex(c => c.id === cardId)
          if (idx !== -1) {
            cards.value[colId][idx] = { ...cards.value[colId][idx], ...res.data }
            renumberColumn(colId)
            break
          }
        }
        return res.data
      } catch (err) {
        if (err?.superseded) throw err
        // Single recovery standard for drag, menu move and retry:
        // raise the epoch to invalidate stale queued moves, drop optimistic
        // state and resync the whole board from the server.
        moveEpochs[cardId] = epoch + 1
        if (currentBoard.value) {
          await fetchAllCards(currentBoard.value.id).catch(() => {})
        }
        throw err
      }
    }

    const previous = moveQueues[cardId] || Promise.resolve()
    const current = previous.then(run, run)
    moveQueues[cardId] = current.catch(() => {})
    return current
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
