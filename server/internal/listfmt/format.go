// Package listfmt implements the signed binary list from contracts section 3:
// target hashing, entry encoding, snapshot and delta files, and their publication.
package listfmt

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/rudecompany/colander/server/internal/sign"
)

// File layout sizes.
const (
	HeaderSize  = 32
	EntrySize   = 16
	TrailerSize = 72
	magic       = "CLDL"
	version     = 1
)

// File kinds.
const (
	KindSnapshot uint8 = 0
	KindDelta    uint8 = 1
)

// Flag bits in an entry's flags byte (bits 0-2 hold the platform code).
const (
	FlagItem          uint8 = 1 << 3
	FlagLarge         uint8 = 1 << 4
	FlagImported      uint8 = 1 << 5
	FlagStaffReviewed uint8 = 1 << 6
)

// Test bits in an entry's detail byte (bits 0-1 hold the slop type code).
// The database stores tests with the same bits.
const (
	TestLowEffort    uint8 = 1 << 2
	TestMassProduced uint8 = 1 << 3
	TestHollow       uint8 = 1 << 4
)

// Platforms in code order.
var Platforms = []string{"yt", "tt", "ig", "fb"}

// Verdicts in code order. Code 0 is "removed" and only appears in deltas.
var Verdicts = []string{"removed", "slop", "likely_slop", "ai_made", "disputed", "clear"}

// SlopTypes in code order. Code 0 is none.
var SlopTypes = []string{"", "filler", "bait", "deceptive"}

// Tests and their detail bits, in display order.
var Tests = []struct {
	Name string
	Bit  uint8
}{
	{"low_effort", TestLowEffort},
	{"mass_produced", TestMassProduced},
	{"hollow", TestHollow},
}

// Signals in bit order. The order is part of the wire format.
var Signals = [16]string{
	"platform_label", "content_credentials", "creator_statement", "watermark",
	"high_volume", "mostly_ai", "templated", "near_duplicates", "link_funnel", "cross_posting",
	"rubric_low_effort", "rubric_hollow", "community_consensus", "staff_review", "open_appeal",
	"not_slop_consensus",
}

// Signal masks used by scoring.
const (
	SigPlatformLabel      uint16 = 1 << 0
	SigContentCredentials uint16 = 1 << 1
	SigCreatorStatement   uint16 = 1 << 2
	SigWatermark          uint16 = 1 << 3
	SigHighVolume         uint16 = 1 << 4
	SigMostlyAI           uint16 = 1 << 5
	SigTemplated          uint16 = 1 << 6
	SigNearDuplicates     uint16 = 1 << 7
	SigLinkFunnel         uint16 = 1 << 8
	SigCrossPosting       uint16 = 1 << 9
	SigRubricLowEffort    uint16 = 1 << 10
	SigRubricHollow       uint16 = 1 << 11
	SigCommunityConsensus uint16 = 1 << 12
	SigStaffReview        uint16 = 1 << 13
	SigOpenAppeal         uint16 = 1 << 14
	SigNotSlopConsensus   uint16 = 1 << 15

	// ProvenanceSignals are the signals staff can record as AI evidence.
	ProvenanceSignals = SigPlatformLabel | SigContentCredentials | SigCreatorStatement | SigWatermark
	// BehaviorSignals are the signals staff can record as source behavior.
	BehaviorSignals = SigHighVolume | SigTemplated | SigNearDuplicates | SigLinkFunnel | SigCrossPosting
)

func indexOf(list []string, v string) int {
	return slices.Index(list, v)
}

// PlatformCode returns the platform's code, or false for an unknown platform.
func PlatformCode(p string) (uint8, bool) {
	i := indexOf(Platforms, p)
	return uint8(i), i >= 0
}

// VerdictCode returns the verdict's code (0 for "removed" or unknown).
func VerdictCode(v string) uint8 {
	i := indexOf(Verdicts, v)
	if i < 0 {
		return 0
	}
	return uint8(i)
}

// SlopTypeCode returns the slop type's code (0 for none or unknown).
func SlopTypeCode(t string) uint8 {
	i := indexOf(SlopTypes, t)
	if i < 0 {
		return 0
	}
	return uint8(i)
}

// SignalMask converts signal names to a mask.
func SignalMask(names []string) (uint16, error) {
	var m uint16
	for _, n := range names {
		i := slices.Index(Signals[:], n)
		if i < 0 {
			return 0, fmt.Errorf("unknown signal %q", n)
		}
		m |= 1 << i
	}
	return m, nil
}

// SignalNames lists the signals in mask, in bit order. It never returns nil.
func SignalNames(mask uint16) []string {
	out := []string{}
	for i, n := range Signals {
		if mask&(1<<i) != 0 {
			out = append(out, n)
		}
	}
	return out
}

// TestBits converts test names to detail bits.
func TestBits(names []string) (uint8, error) {
	var b uint8
	for _, n := range names {
		found := false
		for _, t := range Tests {
			if t.Name == n {
				b |= t.Bit
				found = true
			}
		}
		if !found {
			return 0, fmt.Errorf("unknown test %q", n)
		}
	}
	return b, nil
}

// TestNames lists the tests set in bits. It never returns nil.
func TestNames(bits uint8) []string {
	out := []string{}
	for _, t := range Tests {
		if bits&t.Bit != 0 {
			out = append(out, t.Name)
		}
	}
	return out
}

// TargetKey builds the target key from contracts 2.3. targetType is "source" or "item".
func TargetKey(platform, targetType, id string) string {
	t := "s"
	if targetType == "item" {
		t = "i"
	}
	return platform + ":" + t + ":" + id
}

// Hash is the first 8 bytes of SHA-256 over the target key.
func Hash(key string) [8]byte {
	sum := sha256.Sum256([]byte(key))
	var h [8]byte
	copy(h[:], sum[:8])
	return h
}

var epoch = time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)

// Day is the number of whole days since 2020-01-01 UTC, as stored in an entry's updated field.
func Day(t time.Time) uint16 {
	d := int(t.Sub(epoch).Hours() / 24)
	if t.Before(epoch) {
		d = 0
	}
	return uint16(min(d, 0xFFFF))
}

// Entry is one 16-byte list entry.
type Entry struct {
	Hash    [8]byte
	Verdict uint8
	Flags   uint8
	Signals uint16
	Detail  uint8
	Updated uint16
}

// Bytes encodes the entry.
func (e Entry) Bytes() [EntrySize]byte {
	var b [EntrySize]byte
	copy(b[:8], e.Hash[:])
	b[8] = e.Verdict
	b[9] = e.Flags
	binary.LittleEndian.PutUint16(b[10:], e.Signals)
	b[12] = e.Detail
	binary.LittleEndian.PutUint16(b[14:], e.Updated)
	return b
}

// ParseEntry decodes 16 bytes into an entry.
func ParseEntry(b []byte) Entry {
	var e Entry
	copy(e.Hash[:], b[:8])
	e.Verdict = b[8]
	e.Flags = b[9]
	e.Signals = binary.LittleEndian.Uint16(b[10:])
	e.Detail = b[12]
	e.Updated = binary.LittleEndian.Uint16(b[14:])
	return e
}

// List is a decoded snapshot or delta.
type List struct {
	Kind     uint8
	Sequence uint64
	Base     uint64
	Created  uint32
	Entries  []Entry
	KeyID    [8]byte
}

// SortEntries sorts entries by hash, bytewise ascending.
func SortEntries(entries []Entry) {
	slices.SortFunc(entries, func(a, b Entry) int { return bytes.Compare(a.Hash[:], b.Hash[:]) })
}

// Encode sorts the entries, writes the file and signs it.
func Encode(k *sign.Key, l List) ([]byte, error) {
	entries := slices.Clone(l.Entries)
	SortEntries(entries)
	for i := 1; i < len(entries); i++ {
		if entries[i].Hash == entries[i-1].Hash {
			return nil, fmt.Errorf("duplicate hash %x", entries[i].Hash)
		}
	}
	out := make([]byte, HeaderSize, HeaderSize+EntrySize*len(entries)+TrailerSize)
	copy(out, magic)
	out[4] = version
	out[5] = l.Kind
	binary.LittleEndian.PutUint64(out[8:], l.Sequence)
	binary.LittleEndian.PutUint64(out[16:], l.Base)
	binary.LittleEndian.PutUint32(out[24:], l.Created)
	binary.LittleEndian.PutUint32(out[28:], uint32(len(entries)))
	for _, e := range entries {
		b := e.Bytes()
		out = append(out, b[:]...)
	}
	sig := k.Sign(out)
	out = append(out, k.ID[:]...)
	return append(out, sig...), nil
}

// ErrInvalid wraps every reason a list file is rejected.
var ErrInvalid = errors.New("invalid list file")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// Decode verifies data against pub and decodes it. It rejects a bad magic, version, kind,
// length, sort order, key id or signature, and removed entries inside a snapshot.
func Decode(data []byte, pub ed25519.PublicKey) (*List, error) {
	if len(data) < HeaderSize+TrailerSize {
		return nil, invalid("too short")
	}
	if string(data[:4]) != magic {
		return nil, invalid("bad magic")
	}
	if data[4] != version {
		return nil, invalid("unsupported version %d", data[4])
	}
	l := &List{
		Kind:     data[5],
		Sequence: binary.LittleEndian.Uint64(data[8:]),
		Base:     binary.LittleEndian.Uint64(data[16:]),
		Created:  binary.LittleEndian.Uint32(data[24:]),
	}
	if l.Kind != KindSnapshot && l.Kind != KindDelta {
		return nil, invalid("unknown kind %d", l.Kind)
	}
	count := int(binary.LittleEndian.Uint32(data[28:]))
	if len(data) != HeaderSize+EntrySize*count+TrailerSize {
		return nil, invalid("length %d does not match %d entries", len(data), count)
	}
	body := data[:len(data)-TrailerSize]
	trailer := data[len(data)-TrailerSize:]
	copy(l.KeyID[:], trailer[:8])
	if l.KeyID != sign.KeyID(pub) {
		return nil, invalid("signed by an unknown key")
	}
	if !ed25519.Verify(pub, body, trailer[8:]) {
		return nil, invalid("signature does not verify")
	}
	l.Entries = make([]Entry, count)
	for i := range count {
		off := HeaderSize + i*EntrySize
		e := ParseEntry(data[off : off+EntrySize])
		if i > 0 && bytes.Compare(l.Entries[i-1].Hash[:], e.Hash[:]) >= 0 {
			return nil, invalid("entries not sorted or duplicated at %d", i)
		}
		if e.Verdict > 5 || (e.Verdict == 0 && l.Kind == KindSnapshot) {
			return nil, invalid("bad verdict %d at %d", e.Verdict, i)
		}
		l.Entries[i] = e
	}
	return l, nil
}

// Apply returns the entries of snap after applying delta. The delta's base must be the snapshot's sequence.
func Apply(snap, delta *List) ([]Entry, error) {
	if delta.Kind != KindDelta || delta.Base != snap.Sequence {
		return nil, fmt.Errorf("delta from %d does not apply to sequence %d", delta.Base, snap.Sequence)
	}
	byHash := make(map[[8]byte]Entry, len(snap.Entries))
	for _, e := range snap.Entries {
		byHash[e.Hash] = e
	}
	for _, e := range delta.Entries {
		if e.Verdict == 0 {
			delete(byHash, e.Hash)
		} else {
			byHash[e.Hash] = e
		}
	}
	out := make([]Entry, 0, len(byHash))
	for _, e := range byHash {
		out = append(out, e)
	}
	SortEntries(out)
	return out, nil
}
