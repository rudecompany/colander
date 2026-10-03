package listfmt

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/rudecompany/colander/server/internal/sign"
	"github.com/rudecompany/colander/server/internal/store"
)

// Publisher turns the stored verdicts into signed list versions. It keeps the current snapshot
// in memory and builds deltas from the stored changes.
type Publisher struct {
	Store       *store.Store
	Key         *sign.Key
	Now         func() time.Time
	MinInterval time.Duration // at most one publication per interval
	Retention   time.Duration // deltas are served from sequences this recent
	Log         *slog.Logger

	mu       sync.RWMutex
	seq      store.Sequence
	snapshot []byte
	deltas   map[int64][]byte

	wake chan struct{}
}

// NewPublisher returns a publisher with the contract's timings: 10 seconds and 30 days.
func NewPublisher(st *store.Store, key *sign.Key, log *slog.Logger) *Publisher {
	return &Publisher{Store: st, Key: key, Now: time.Now, MinInterval: 10 * time.Second,
		Retention: 30 * 24 * time.Hour, Log: log, wake: make(chan struct{}, 1)}
}

// Request asks for a publication. Requests made while one is pending coalesce.
func (p *Publisher) Request() {
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// Run publishes on request, at most once per MinInterval, until ctx ends.
func (p *Publisher) Run(ctx context.Context) {
	var last time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-p.wake:
		}
		if wait := p.MinInterval - time.Since(last); wait > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
		}
		last = time.Now()
		if err := p.Publish(ctx); err != nil && ctx.Err() == nil {
			p.Log.Error("list publication failed", "err", err)
		}
	}
}

// Publish writes a new sequence when the rated targets differ from the published list,
// then refreshes the in-memory snapshot if the stored sequence moved.
func (p *Publisher) Publish(ctx context.Context) error {
	now := p.Now()
	targets, err := p.Store.ListTargets(ctx)
	if err != nil {
		return err
	}
	want := make(map[[8]byte]store.ListEntry, len(targets))
	for _, t := range targets {
		// An item entry exists only when its own verdict differs from its source's, or its source is mixed.
		if t.TargetType == "item" && t.State.Verdict == t.SourceVerdict && !t.SourceMixed {
			continue
		}
		pc, _ := PlatformCode(t.Platform)
		flags := pc | t.State.Flags
		if t.TargetType == "item" {
			flags |= FlagItem
		}
		key := TargetKey(t.Platform, t.TargetType, t.ID)
		e := Entry{Hash: Hash(key), Verdict: VerdictCode(t.State.Verdict), Flags: flags, Signals: t.State.Signals,
			Detail: t.State.Detail, Updated: Day(time.Unix(t.State.ChangedAt, 0))}
		want[e.Hash] = store.ListEntry{Hash: e.Hash, Entry: e.Bytes(), Key: key}
	}
	removed := func(old [EntrySize]byte) [EntrySize]byte {
		o := ParseEntry(old[:])
		return Entry{Hash: o.Hash, Flags: o.Flags & (FlagItem | 7), Updated: Day(now)}.Bytes()
	}
	seq, changed, err := p.Store.PublishList(ctx, want, removed, now.Unix(), now.Add(-p.Retention).Unix())
	if err != nil {
		return err
	}
	if changed {
		p.Log.Info("list published", "sequence", seq.Seq, "entries", len(want))
	}
	p.mu.RLock()
	current := p.seq.Seq == seq.Seq && p.snapshot != nil
	p.mu.RUnlock()
	if current {
		return nil
	}
	return p.reload(ctx)
}

// reload rebuilds the in-memory snapshot from the published entries.
func (p *Publisher) reload(ctx context.Context) error {
	seq, raw, err := p.Store.PublishedEntries(ctx)
	if err != nil {
		return err
	}
	entries := make([]Entry, len(raw))
	for i, r := range raw {
		entries[i] = ParseEntry(r[:])
	}
	snap, err := Encode(p.Key, List{Kind: KindSnapshot, Sequence: uint64(seq.Seq), Created: uint32(seq.CreatedAt), Entries: entries})
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.seq, p.snapshot, p.deltas = seq, snap, map[int64][]byte{}
	p.mu.Unlock()
	return nil
}

// Snapshot returns the current snapshot bytes and their sequence (nil before the first publication).
func (p *Publisher) Snapshot() ([]byte, store.Sequence) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.snapshot, p.seq
}

// Delta returns the coalesced delta from since to the current sequence, with the HTTP status it
// deserves: 200 with bytes, 204 when since is current, 410 when since is unknown or too old.
func (p *Publisher) Delta(ctx context.Context, since int64) ([]byte, int, error) {
	p.mu.RLock()
	seq, cached, ready := p.seq, p.deltas[since], p.snapshot != nil
	p.mu.RUnlock()
	switch {
	case !ready:
		return nil, http.StatusGone, nil
	case since == seq.Seq:
		return nil, http.StatusNoContent, nil
	case since > seq.Seq || since <= 0:
		return nil, http.StatusGone, nil
	}
	created, err := p.Store.SequenceCreated(ctx, since)
	if errors.Is(err, store.ErrNotFound) || (err == nil && created < p.Now().Add(-p.Retention).Unix()) {
		return nil, http.StatusGone, nil
	}
	if err != nil {
		return nil, 0, err
	}
	if cached != nil {
		return cached, http.StatusOK, nil
	}
	raw, err := p.Store.ChangesSince(ctx, since, seq.Seq)
	if err != nil {
		return nil, 0, err
	}
	entries := make([]Entry, len(raw))
	for i, r := range raw {
		entries[i] = ParseEntry(r[:])
	}
	b, err := Encode(p.Key, List{Kind: KindDelta, Sequence: uint64(seq.Seq), Base: uint64(since), Created: uint32(seq.CreatedAt), Entries: entries})
	if err != nil {
		return nil, 0, err
	}
	p.mu.Lock()
	// ponytail: the delta cache is dropped whenever it grows past 256 bases; an LRU if clients spread wider.
	if p.seq == seq {
		if len(p.deltas) >= 256 {
			clear(p.deltas)
		}
		p.deltas[since] = b
	}
	p.mu.Unlock()
	return b, http.StatusOK, nil
}
