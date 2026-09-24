const express = require('express');
const { getDb } = require('../db/init');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

// Helper: verify card ownership through column -> board -> user
function getCardWithOwnership(db, cardId, userId) {
  return db.prepare(`
    SELECT c.*, col.board_id, b.user_id 
    FROM cards c
    JOIN columns col ON c.column_id = col.id
    JOIN boards b ON col.board_id = b.id
    WHERE c.id = ?
  `).get(cardId);
}

function verifyColumnOwnership(db, columnId, userId) {
  return db.prepare(`
    SELECT col.*, b.user_id 
    FROM columns col 
    JOIN boards b ON col.board_id = b.id 
    WHERE col.id = ?
  `).get(columnId, userId);
}

// GET /api/columns/:columnId/cards - Get cards in column
router.get('/columns/:columnId/cards', (req, res) => {
  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    const cards = db.prepare(`
      SELECT * FROM cards 
      WHERE column_id = ? 
      ORDER BY position ASC
    `).all(req.params.columnId);

    db.close();
    res.json(cards);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to fetch cards' });
  }
});

// POST /api/columns/:columnId/cards - Add card
router.post('/columns/:columnId/cards', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Card title is required' });
  }

  const db = getDb();
  try {
    const col = db.prepare(`
      SELECT col.*, b.user_id FROM columns col 
      JOIN boards b ON col.board_id = b.id 
      WHERE col.id = ?
    `).get(req.params.columnId);

    if (!col || col.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Column not found' });
    }

    // Get max position in this column
    const maxPos = db.prepare('SELECT MAX(position) AS maxPos FROM cards WHERE column_id = ?').get(req.params.columnId);
    const newPosition = (maxPos.maxPos ?? -1) + 1;

    const result = db.prepare(`
      INSERT INTO cards (column_id, title, description, priority, due_date, position) 
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.columnId,
      title.trim(),
      description || '',
      priority || 'medium',
      due_date || null,
      newPosition
    );

    const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
    db.close();
    res.status(201).json(card);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to create card' });
  }
});

// PUT /api/cards/:id - Update card
router.put('/cards/:id', (req, res) => {
  const { title, description, priority, due_date } = req.body;
  const db = getDb();

  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    const updates = [];
    const params = [];

    if (title !== undefined) { updates.push('title = ?'); params.push(title.trim()); }
    if (description !== undefined) { updates.push('description = ?'); params.push(description); }
    if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
    if (due_date !== undefined) { updates.push('due_date = ?'); params.push(due_date || null); }

    updates.push("updated_at = datetime('now')");

    if (updates.length > 0) {
      params.push(req.params.id);
      db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to update card' });
  }
});

// DELETE /api/cards/:id - Delete card
router.delete('/cards/:id', (req, res) => {
  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    db.prepare('DELETE FROM cards WHERE id = ?').run(req.params.id);

    // Reorder remaining cards in the column
    db.prepare(`
      UPDATE cards SET position = position - 1 
      WHERE column_id = ? AND position > ?
    `).run(card.column_id, card.position);

    db.close();
    res.json({ message: 'Card deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// PUT /api/cards/:id/move - Move card to another column (or reorder within one)
//
// Unified position rule shared by drag, menu move, detail dialog and retries:
//   - position is the insertion index in the target column's card list
//   - valid range: [0, peerCount], where peerCount is the number of other
//     cards in the target column (n-1 for same-column reorder, n for a
//     cross-column move)
//   - out-of-range positions are clamped to the range, never to a gap
//   - on success every affected column is normalized back to a gap-free 0..n-1
//     sequence, so a retry or a fresh page load always observes the same state
router.put('/cards/:id/move', (req, res) => {
  const { columnId } = req.body;
  const position = req.body.position;

  const targetColumnId = Number(columnId);
  if (!Number.isInteger(targetColumnId)) {
    return res.status(400).json({ error: 'Target column ID is required' });
  }

  const db = getDb();
  try {
    const cardId = Number(req.params.id);
    const card = getCardWithOwnership(db, cardId, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column belongs to same board and user
    const targetCol = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ? AND col.board_id = ?
    `).get(targetColumnId, card.board_id);

    if (!targetCol || targetCol.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Target column not found in this board' });
    }

    const sameColumn = card.column_id === targetColumnId;

    // Clamp to the single valid range, regardless of how the move was requested.
    // peerCount counts the other cards currently in the target column; after
    // the moved card is parked out, they occupy slots 0..peerCount-1, so the
    // last valid insertion index is peerCount (both same- and cross-column).
    const peerCount = db.prepare(`
      SELECT COUNT(*) AS n FROM cards WHERE column_id = ? AND id != ?
    `).get(targetColumnId, cardId).n;
    const upperBound = peerCount;
    let targetPosition;
    if (position === undefined || position === null) {
      targetPosition = upperBound;
    } else {
      const requested = Number(position);
      if (!Number.isInteger(requested)) {
        db.close();
        return res.status(400).json({ error: 'Position must be an integer' });
      }
      targetPosition = Math.min(Math.max(requested, 0), upperBound);
    }

    const renumberStmt = db.prepare('UPDATE cards SET position = ? WHERE id = ?');
    const renumberColumn = (columnIdToCompact) => {
      const ids = db.prepare(`
        SELECT id FROM cards
        WHERE column_id = ?
        ORDER BY position ASC, id ASC
      `).all(columnIdToCompact).map(row => row.id);
      ids.forEach((id, index) => renumberStmt.run(index, id));
    };

    const applyMove = db.transaction(() => {
      // Park the moved card outside the position slots so no unique ordering
      // tie is possible while the columns are rebuilt.
      db.prepare(`
        UPDATE cards
        SET column_id = ?, position = -1, updated_at = datetime('now')
        WHERE id = ?
      `).run(targetColumnId, cardId);

      // Compact the source column first for cross-column moves.
      if (!sameColumn) {
        renumberColumn(card.column_id);
      }

      // Rebuild the target column around the moved card. This is idempotent,
      // so a retried request converges to the same gap-free result.
      const targetIds = db.prepare(`
        SELECT id FROM cards
        WHERE column_id = ? AND id != ?
        ORDER BY position ASC, id ASC
      `).all(targetColumnId, cardId).map(row => row.id);
      targetIds.splice(targetPosition, 0, cardId);
      targetIds.forEach((id, index) => renumberStmt.run(index, id));
    });

    applyMove();

    // Card content (title/description/priority/due_date) is untouched.
    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

module.exports = router;
