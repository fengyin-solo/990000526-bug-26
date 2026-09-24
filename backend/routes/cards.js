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

    // Renumber remaining cards in the column to dense positions
    const remaining = db.prepare(`
      SELECT id FROM cards WHERE column_id = ? ORDER BY position ASC
    `).all(card.column_id);
    remaining.forEach((row, i) => {
      db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(i, row.id);
    });

    db.close();
    res.json({ message: 'Card deleted' });
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to delete card' });
  }
});

// PUT /api/cards/:id/move - Move card to another column / position
router.put('/cards/:id/move', (req, res) => {
  const { columnId, position } = req.body;
  if (!columnId) {
    return res.status(400).json({ error: 'Target column ID is required' });
  }

  const db = getDb();
  try {
    const card = getCardWithOwnership(db, req.params.id, req.user.id);
    if (!card || card.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Card not found' });
    }

    // Verify target column belongs to same board and user
    const targetCol = db.prepare(`
      SELECT col.*, b.user_id FROM columns col
      JOIN boards b ON col.board_id = b.id
      WHERE col.id = ? AND col.board_id = ?
    `).get(columnId, card.board_id);

    if (!targetCol || targetCol.user_id !== req.user.id) {
      db.close();
      return res.status(404).json({ error: 'Target column not found in this board' });
    }

    const oldColumnId = card.column_id;
    const targetColumnId = targetCol.id;

    // Canonical rules (must match the frontend store):
    //  - position is a 0-based dense index in the destination column
    //  - allowed upper bound is the destination length *after* the card is
    //    removed, so same-column moves can never leave a gap
    //  - missing / invalid position means "append to end"
    const targetCountRow = db.prepare(
      'SELECT COUNT(*) AS cnt FROM cards WHERE column_id = ?'
    ).get(targetColumnId);
    const upperBound = targetCountRow.cnt - (oldColumnId === targetColumnId ? 1 : 0);

    let newPosition;
    if (position === undefined || position === null) {
      newPosition = upperBound;
    } else {
      newPosition = Math.trunc(Number(position));
      // Only non-negative integers are valid positions; negative or NaN
      // values fall back to the end of the column.
      if (!Number.isInteger(newPosition) || newPosition < 0) {
        newPosition = upperBound;
      }
      newPosition = Math.min(newPosition, upperBound);
    }

    if (oldColumnId === targetColumnId && card.position === newPosition) {
      db.close();
      return res.json(card);
    }

    // Apply the move and renumber to dense 0..n-1 positions atomically.
    const moveTxn = db.transaction(() => {
      if (oldColumnId === targetColumnId) {
        // Reorder within the same column: snapshot the other cards in
        // their current order, move the card, then compress to dense.
        const others = db.prepare(`
          SELECT id, position FROM cards
          WHERE column_id = ? AND id != ?
          ORDER BY position ASC
        `).all(targetColumnId, card.id);

        db.prepare(`
          UPDATE cards SET position = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(newPosition, card.id);

        others.forEach((row, i) => {
          const densePos = i >= newPosition ? i + 1 : i;
          if (row.position !== densePos) {
            db.prepare('UPDATE cards SET position = ? WHERE id = ?').run(densePos, row.id);
          }
        });
      } else {
        // Close the gap in the old column and open one in the new column.
        db.prepare(`
          UPDATE cards SET position = position - 1
          WHERE column_id = ? AND position > ?
        `).run(oldColumnId, card.position);

        db.prepare(`
          UPDATE cards SET position = position + 1
          WHERE column_id = ? AND position >= ?
        `).run(targetColumnId, newPosition);

        db.prepare(`
          UPDATE cards SET column_id = ?, position = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(targetColumnId, newPosition, card.id);
      }
    });
    moveTxn();

    const updated = db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id);
    db.close();
    res.json(updated);
  } catch (err) {
    db.close();
    res.status(500).json({ error: 'Failed to move card' });
  }
});

module.exports = router;
