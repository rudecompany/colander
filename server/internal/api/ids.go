package api

import (
	"regexp"
	"strings"

	lf "github.com/rudecompany/colander/server/internal/listfmt"
)

// Canonical ID formats from contracts 2.2. Lowercasing is applied where the contract asks for it;
// anything else malformed is rejected so adapter bugs surface instead of silently not matching.
var (
	ytChannel = regexp.MustCompile(`^UC[A-Za-z0-9_-]{22}$`)
	ytHandle  = regexp.MustCompile(`^@[\p{Ll}\p{Lo}\p{Lm}\p{N}._·-]{1,100}$`)
	ytVideo   = regexp.MustCompile(`^[A-Za-z0-9_-]{11}$`)
	ttUser    = regexp.MustCompile(`^@[a-z0-9._]{1,64}$`)
	numeric   = regexp.MustCompile(`^[0-9]{1,30}$`)
	igUser    = regexp.MustCompile(`^[a-z0-9._]{1,30}$`)
	igCode    = regexp.MustCompile(`^[A-Za-z0-9_-]{4,64}$`)
	fbVanity  = regexp.MustCompile(`^[a-z0-9._-]{1,100}$`)
	fbPost    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,100}$`)
)

func validPlatform(p string) bool {
	_, ok := lf.PlatformCode(p)
	return ok
}

// CanonicalSource returns the canonical source ID, or false when id is not one.
func CanonicalSource(platform, id string) (string, bool) {
	switch platform {
	case "yt":
		if ytChannel.MatchString(id) {
			return id, true
		}
		id = strings.ToLower(id)
		return id, ytHandle.MatchString(id)
	case "tt":
		id = strings.ToLower(id)
		return id, ttUser.MatchString(id)
	case "ig":
		id = strings.ToLower(id)
		return id, igUser.MatchString(id)
	case "fb":
		id = strings.ToLower(id)
		return id, numeric.MatchString(id) || fbVanity.MatchString(id)
	}
	return "", false
}

// CanonicalItem returns the canonical item ID, or false when id is not one.
func CanonicalItem(platform, id string) (string, bool) {
	switch platform {
	case "yt":
		return id, ytVideo.MatchString(id)
	case "tt":
		return id, numeric.MatchString(id)
	case "ig":
		return id, igCode.MatchString(id)
	case "fb":
		return id, fbPost.MatchString(id)
	}
	return "", false
}

var sourceNoun = map[string]string{"yt": "channel", "tt": "profile", "ig": "profile", "fb": "page"}
