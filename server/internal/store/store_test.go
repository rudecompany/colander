package store

import (
	"context"
	"path/filepath"
	"testing"
)

// Reopening applies no migration twice, and a YouTube lookup that links a handle to a channel ID
// folds the two sources into the older one.
func TestMigrateAndMerge(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "c.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	if s, err = Open(ctx, path); err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	byHandle, err := s.EnsureSource(ctx, "yt", "@ancientwondersdaily", "Ancient Wonders Daily AI", 1)
	if err != nil {
		t.Fatal(err)
	}
	const channel = "UCzzzzzzzzzzzzzzzzzzzzz1"
	byID, err := s.EnsureSource(ctx, "yt", channel, "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.SaveTags(ctx, "h1", []TagInput{{ClientID: "c1", Platform: "yt", TargetType: "source", TargetID: channel,
		SourceID: channel, Verdict: "slop", CreatedAt: 1}}, 1); err != nil {
		t.Fatal(err)
	}
	keep, err := s.SetYouTube(ctx, byID, YouTubeInfo{ChannelID: channel, Handle: "@AncientWondersDaily"}, 2)
	if err != nil || keep != byHandle {
		t.Fatalf("merge kept %d (err %v), want %d", keep, err, byHandle)
	}
	src, err := s.GetSource(ctx, keep)
	if err != nil || len(src.Aliases) != 2 || src.Aliases[0] != channel || src.Name != "Ancient Wonders Daily AI" {
		t.Fatalf("merged source = %+v (err %v)", src, err)
	}
	d, err := s.LoadSourceData(ctx, keep, 2)
	if err != nil || len(d.Votes) != 1 {
		t.Fatalf("tags did not follow the merge: %+v (err %v)", d, err)
	}
}
