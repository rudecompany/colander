package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
)

// ListTarget is a rated source alias or item, the raw material of a list entry.
type ListTarget struct {
	Platform      string
	TargetType    string // source | item
	ID            string // the alias or item ID
	State         State
	SourceVerdict string // for items: their source's verdict
}

// ListTargets returns one row per alias of every rated source and one per rated item.
func (s *Store) ListTargets(ctx context.Context) ([]ListTarget, error) {
	rows, err := s.DB.QueryContext(ctx, `
		SELECT a.platform, 'source', a.alias, s.verdict, s.signals, s.detail, s.flags, ifnull(s.changed_at, 0), ''
		FROM sources s JOIN source_aliases a ON a.source_id = s.id WHERE s.verdict IS NOT NULL
		UNION ALL
		SELECT i.platform, 'item', i.item_id, i.verdict, i.signals, i.detail, i.flags, ifnull(i.changed_at, 0), ifnull(s.verdict, '')
		FROM items i JOIN sources s ON s.id = i.source_id WHERE i.verdict IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ListTarget
	for rows.Next() {
		var t ListTarget
		if err := rows.Scan(&t.Platform, &t.TargetType, &t.ID, &t.State.Verdict, &t.State.Signals, &t.State.Detail,
			&t.State.Flags, &t.State.ChangedAt, &t.SourceVerdict); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ListEntry is one published entry: the 16 encoded bytes and the target key it came from.
type ListEntry struct {
	Hash  [8]byte
	Entry [16]byte
	Key   string
}

// Sequence describes one published list version.
type Sequence struct {
	Seq       int64
	CreatedAt int64
}

// PublishList makes the published entries equal want. When anything differs it records a new
// sequence holding every change (removed returns the encoded removal for a dropped entry) and
// prunes sequences created before pruneBefore, always keeping the latest.
func (s *Store) PublishList(ctx context.Context, want map[[8]byte]ListEntry, removed func(old [16]byte) [16]byte,
	now, pruneBefore int64) (Sequence, bool, error) {
	var seq Sequence
	changed := false
	err := s.Tx(ctx, func(tx *sql.Tx) error {
		have := map[[8]byte][16]byte{}
		rows, err := tx.QueryContext(ctx, `SELECT hash, entry FROM list_entries`)
		if err != nil {
			return err
		}
		for rows.Next() {
			var h, e []byte
			if err := rows.Scan(&h, &e); err != nil {
				rows.Close()
				return err
			}
			have[[8]byte(h)] = [16]byte(e)
		}
		rows.Close()
		if err := tx.QueryRowContext(ctx, `SELECT ifnull(max(seq), 0), ifnull(max(created_at), 0) FROM list_sequences`).
			Scan(&seq.Seq, &seq.CreatedAt); err != nil {
			return err
		}

		type change struct {
			hash  [8]byte
			entry [16]byte
			key   string
			drop  bool
		}
		var changes []change
		for h, w := range want {
			if old, ok := have[h]; !ok || !bytes.Equal(old[:], w.Entry[:]) {
				changes = append(changes, change{hash: h, entry: w.Entry, key: w.Key})
			}
		}
		for h, old := range have {
			if _, ok := want[h]; !ok {
				changes = append(changes, change{hash: h, entry: removed(old), drop: true})
			}
		}
		if len(changes) == 0 && seq.Seq > 0 {
			return nil
		}
		changed = true
		seq = Sequence{Seq: seq.Seq + 1, CreatedAt: now}
		if _, err := tx.ExecContext(ctx, `INSERT INTO list_sequences (seq, created_at) VALUES (?, ?)`, seq.Seq, now); err != nil {
			return err
		}
		for _, c := range changes {
			if c.drop {
				if _, err := tx.ExecContext(ctx, `DELETE FROM list_entries WHERE hash = ?`, c.hash[:]); err != nil {
					return err
				}
			} else if _, err := tx.ExecContext(ctx, `INSERT INTO list_entries (hash, entry, target_key) VALUES (?, ?, ?)
				ON CONFLICT (hash) DO UPDATE SET entry = excluded.entry, target_key = excluded.target_key`,
				c.hash[:], c.entry[:], c.key); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO list_changes (seq, hash, entry) VALUES (?, ?, ?)`, seq.Seq, c.hash[:], c.entry[:]); err != nil {
				return err
			}
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM list_sequences WHERE created_at < ? AND seq < ?`, pruneBefore, seq.Seq)
		return err
	})
	return seq, changed, err
}

// LatestSequence returns the newest published sequence (zero when nothing was published).
func (s *Store) LatestSequence(ctx context.Context) (Sequence, error) {
	var seq Sequence
	err := s.DB.QueryRowContext(ctx, `SELECT ifnull(max(seq), 0), ifnull(max(created_at), 0) FROM list_sequences`).Scan(&seq.Seq, &seq.CreatedAt)
	return seq, err
}

// PublishedEntries returns every published entry with the sequence they belong to, in one read.
func (s *Store) PublishedEntries(ctx context.Context) (Sequence, [][16]byte, error) {
	tx, err := s.DB.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return Sequence{}, nil, err
	}
	defer tx.Rollback()
	var seq Sequence
	if err := tx.QueryRowContext(ctx, `SELECT ifnull(max(seq), 0), ifnull(max(created_at), 0) FROM list_sequences`).Scan(&seq.Seq, &seq.CreatedAt); err != nil {
		return seq, nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT entry FROM list_entries`)
	if err != nil {
		return seq, nil, err
	}
	defer rows.Close()
	var out [][16]byte
	for rows.Next() {
		var e []byte
		if err := rows.Scan(&e); err != nil {
			return seq, nil, err
		}
		out = append(out, [16]byte(e))
	}
	return seq, out, rows.Err()
}

// SequenceCreated returns when a sequence was published, or ErrNotFound when it is unknown or pruned.
func (s *Store) SequenceCreated(ctx context.Context, seq int64) (int64, error) {
	var at int64
	err := s.DB.QueryRowContext(ctx, `SELECT created_at FROM list_sequences WHERE seq = ?`, seq).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return at, err
}

// ChangesSince returns the final state of every hash changed after since, up to and including upTo.
func (s *Store) ChangesSince(ctx context.Context, since, upTo int64) ([][16]byte, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT hash, entry FROM list_changes WHERE seq > ? AND seq <= ? ORDER BY seq`, since, upTo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	latest := map[[8]byte][16]byte{}
	for rows.Next() {
		var h, e []byte
		if err := rows.Scan(&h, &e); err != nil {
			return nil, err
		}
		latest[[8]byte(h)] = [16]byte(e)
	}
	out := make([][16]byte, 0, len(latest))
	for _, e := range latest {
		out = append(out, e)
	}
	return out, rows.Err()
}

// AddListRequests adds n anonymous list requests to the given hour bucket (unix hour) and prunes week-old buckets.
func (s *Store) AddListRequests(ctx context.Context, hour int64, n int64) error {
	if _, err := s.DB.ExecContext(ctx, `INSERT INTO list_requests (hour, count) VALUES (?, ?)
		ON CONFLICT (hour) DO UPDATE SET count = count + excluded.count`, hour, n); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx, `DELETE FROM list_requests WHERE hour < ?`, hour-24*7)
	return err
}

// ListRequestsSince sums list requests in hour buckets at or after fromHour.
func (s *Store) ListRequestsSince(ctx context.Context, fromHour int64) (int64, error) {
	var n int64
	err := s.DB.QueryRowContext(ctx, `SELECT ifnull(sum(count), 0) FROM list_requests WHERE hour >= ?`, fromHour).Scan(&n)
	return n, err
}
