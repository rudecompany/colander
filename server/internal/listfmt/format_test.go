package listfmt

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/rudecompany/colander/server/internal/sign"
)

const contractDir = "../../../testdata/contract/"

type fixtureEntry struct {
	Key           string   `json:"key"`
	Verdict       string   `json:"verdict"`
	Signals       []string `json:"signals"`
	SlopType      string   `json:"slop_type"`
	Tests         []string `json:"tests"`
	Large         bool     `json:"large"`
	Imported      bool     `json:"imported"`
	StaffReviewed bool     `json:"staff_reviewed"`
	Updated       string   `json:"updated"`
	Hash          string   `json:"hash"`
}

type fixtureList struct {
	Sequence uint64         `json:"sequence"`
	Base     uint64         `json:"base"`
	Created  uint32         `json:"created"`
	Entries  []fixtureEntry `json:"entries"`
}

type fixture struct {
	KeyID           string      `json:"key_id"`
	PublicKey       string      `json:"public_key"`
	Snapshot        fixtureList `json:"snapshot"`
	Delta           fixtureList `json:"delta"`
	AfterDeltaCount int         `json:"after_delta_count"`
}

func devKey(t testing.TB) *sign.Key {
	t.Helper()
	k, err := sign.LoadKey("../../testdata/dev-signing.key")
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func readFile(t testing.TB, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(contractDir + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func toEntry(t *testing.T, f fixtureEntry) Entry {
	t.Helper()
	parts := strings.SplitN(f.Key, ":", 3)
	pc, ok := PlatformCode(parts[0])
	if !ok {
		t.Fatalf("bad platform in %s", f.Key)
	}
	flags := pc
	if parts[1] == "i" {
		flags |= FlagItem
	}
	if f.Large {
		flags |= FlagLarge
	}
	if f.Imported {
		flags |= FlagImported
	}
	if f.StaffReviewed {
		flags |= FlagStaffReviewed
	}
	sig, err := SignalMask(f.Signals)
	if err != nil {
		t.Fatal(err)
	}
	tests, err := TestBits(f.Tests)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := time.Parse(time.RFC3339, f.Updated)
	if err != nil {
		t.Fatal(err)
	}
	e := Entry{
		Hash:    Hash(f.Key),
		Verdict: VerdictCode(f.Verdict),
		Flags:   flags,
		Signals: sig,
		Detail:  SlopTypeCode(f.SlopType) | tests,
		Updated: Day(updated),
	}
	if got := hex.EncodeToString(e.Hash[:]); got != f.Hash {
		t.Fatalf("hash of %s = %s, fixture says %s", f.Key, got, f.Hash)
	}
	return e
}

func TestContractFixtures(t *testing.T) {
	var fx fixture
	if err := json.Unmarshal(readFile(t, "list-expected.json"), &fx); err != nil {
		t.Fatal(err)
	}
	k := devKey(t)
	if k.KeyIDHex() != fx.KeyID || k.PublicBase64() != fx.PublicKey {
		t.Fatalf("dev key does not match the fixture key")
	}

	build := func(kind uint8, fl fixtureList) []byte {
		entries := make([]Entry, len(fl.Entries))
		for i, fe := range fl.Entries {
			entries[i] = toEntry(t, fe)
		}
		// Reverse so Encode has to sort.
		for i, j := 0, len(entries)-1; i < j; i, j = i+1, j-1 {
			entries[i], entries[j] = entries[j], entries[i]
		}
		b, err := Encode(k, List{Kind: kind, Sequence: fl.Sequence, Base: fl.Base, Created: fl.Created, Entries: entries})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	wantSnap := readFile(t, "list-snapshot.bin")
	wantDelta := readFile(t, "list-delta.bin")
	if got := build(KindSnapshot, fx.Snapshot); !bytes.Equal(got, wantSnap) {
		t.Fatalf("snapshot bytes differ from fixture")
	}
	if got := build(KindDelta, fx.Delta); !bytes.Equal(got, wantDelta) {
		t.Fatalf("delta bytes differ from fixture")
	}

	snap, err := Decode(wantSnap, k.Public)
	if err != nil {
		t.Fatal(err)
	}
	delta, err := Decode(wantDelta, k.Public)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Sequence != 42 || delta.Base != 42 || delta.Sequence != 43 || len(snap.Entries) != 7 {
		t.Fatalf("decoded headers wrong: %+v / %+v", snap, delta)
	}
	for i, fe := range fx.Snapshot.Entries {
		if snap.Entries[i] != toEntry(t, fe) {
			t.Fatalf("snapshot entry %d decoded as %+v", i, snap.Entries[i])
		}
	}
	after, err := Apply(snap, delta)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != fx.AfterDeltaCount {
		t.Fatalf("after delta: %d entries, want %d", len(after), fx.AfterDeltaCount)
	}
	cat := Hash("yt:s:@catrescuetales")
	for _, e := range after {
		if e.Hash == cat && e.Verdict != VerdictCode("slop") {
			t.Fatalf("delta did not move @catrescuetales to slop")
		}
		if e.Hash == Hash("yt:i:dQw4w9WgXcQ") {
			t.Fatalf("delta did not remove the item entry")
		}
	}
}

func TestDecodeRejects(t *testing.T) {
	k := devKey(t)
	good := readFile(t, "list-snapshot.bin")

	tampered := bytes.Clone(good)
	tampered[HeaderSize+8] ^= 1 // flip a verdict bit inside the signed body
	short := good[:len(good)-1]
	wrongCount := bytes.Clone(good)
	binary.LittleEndian.PutUint32(wrongCount[28:], 8)

	// Unsorted: a correctly signed file whose entries are out of order.
	a, b := Entry{Hash: [8]byte{2}, Verdict: 1}, Entry{Hash: [8]byte{1}, Verdict: 1}
	unsorted := make([]byte, HeaderSize)
	copy(unsorted, "CLDL")
	unsorted[4] = 1
	binary.LittleEndian.PutUint32(unsorted[28:], 2)
	ab, bb := a.Bytes(), b.Bytes()
	unsorted = append(append(unsorted, ab[:]...), bb[:]...)
	sig := k.Sign(unsorted)
	unsorted = append(append(unsorted, k.ID[:]...), sig...)

	other, _ := sign.NewKey(bytes.Repeat([]byte{7}, 32))

	for name, data := range map[string][]byte{
		"tampered": tampered, "short": short, "wrong count": wrongCount, "unsorted": unsorted,
	} {
		if _, err := Decode(data, k.Public); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: want ErrInvalid, got %v", name, err)
		}
	}
	if _, err := Decode(good, other.Public); !errors.Is(err, ErrInvalid) {
		t.Errorf("wrong key: want ErrInvalid, got %v", err)
	}
}

// A full sync of 50,000 sources must stay under 2 MB, even with two aliases per source.
func TestSnapshotSize(t *testing.T) {
	k := devKey(t)
	const sources = 50_000
	entries := make([]Entry, 0, sources*2)
	seen := map[[8]byte]bool{}
	for len(entries) < sources*2 {
		var h [8]byte
		rand.Read(h[:])
		if seen[h] {
			continue
		}
		seen[h] = true
		entries = append(entries, Entry{Hash: h, Verdict: 1, Signals: 0xFFFF, Updated: Day(time.Now())})
	}
	b, err := Encode(k, List{Kind: KindSnapshot, Sequence: 1, Entries: entries})
	if err != nil {
		t.Fatal(err)
	}
	if len(b) != HeaderSize+EntrySize*len(entries)+TrailerSize || len(b) >= 2<<20 {
		t.Fatalf("snapshot of %d entries is %d bytes", len(entries), len(b))
	}
	if _, err := Decode(b, k.Public); err != nil {
		t.Fatal(err)
	}
}
