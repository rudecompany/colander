package scoring

import "strings"

// Plain-language signal clauses, worded after SIGNAL_TEXT in packages/shared/src/verdicts.ts.
var signalPhrase = [16]string{
	"the platform labels it AI-generated",
	"Content Credentials say it was made with AI",
	"the creator says it is AI-made",
	"a generator watermark is visible",
	"it posts at a volume no person could sustain",
	"most recent items are AI-made",
	"it uses one template across titles and thumbnails",
	"it has many near-duplicate items",
	"it routes viewers off the platform",
	"other pages share the same captions",
	"taggers found little human effort",
	"taggers found it hollow",
	"it is tagged as slop by the community",
	"staff review confirmed it",
	"an appeal is open",
	"the community says it is not slop",
}

var verdictWord = map[string]string{
	"slop": "Slop", "likely_slop": "Likely slop", "ai_made": "AI-made", "disputed": "Disputed", "clear": "Clear",
}

// VerdictWord returns the display word for a verdict ("Not rated" for none).
func VerdictWord(v string) string {
	if w, ok := verdictWord[v]; ok {
		return w
	}
	return "Not rated"
}

func sentence(parts []string) string {
	if len(parts) == 0 {
		return ""
	}
	s := parts[0]
	switch {
	case len(parts) == 2:
		s = parts[0] + " and " + parts[1]
	case len(parts) > 2:
		s = strings.Join(parts[:len(parts)-1], ", ") + ", and " + parts[len(parts)-1]
	}
	return strings.ToUpper(s[:1]) + s[1:] + "."
}

// communityReason explains a verdict the scoring pass set, in plain words built from the signals.
func communityReason(r Result, in Input, importSource string) string {
	switch {
	case r.Verdict == "":
		return "Not rated any more. The remaining evidence does not meet any verdict rule."
	case r.Rule == 1:
		return "An appeal is open, so this shows as Disputed while staff review it."
	case r.Rule == 3:
		return "The community says it is not slop."
	case r.Rule == 5:
		return "Tags are split between slop and not slop, so this shows as Disputed."
	}
	var parts []string
	if !in.Item && in.Imported != "" {
		name := importSource
		if name == "" {
			name = "an imported"
		}
		parts = append(parts, "listed on the "+name+" seed list")
	} else if r.Provenance.Signals == 0 {
		parts = append(parts, "taggers agree it is AI-made")
	}
	for i, p := range signalPhrase {
		if r.Signals&(1<<i) != 0 {
			parts = append(parts, p)
		}
	}
	out := VerdictWord(r.Verdict) + ". " + sentence(parts)
	switch {
	case r.Rule != 6:
	case r.CappedBy == "large":
		out += " Held at Likely slop until staff review it, because it has a large audience."
	case r.CappedBy == "imported":
		out += " Held at Likely slop until staff review the imported entry."
	case r.CappedBy == "audience":
		out += " Held at Likely slop until staff review it, because its audience size is unknown."
	case r.CappedBy == "lapsed":
		out += " Held at Likely slop until staff review it again, because the earlier verdict expired."
	}
	return out
}

// escalationSummary describes why rule 6 was capped, for the review queue.
func escalationSummary(cappedBy string) string {
	switch cappedBy {
	case "large":
		return "Scores as Slop, held at Likely slop: large source needs staff review"
	case "imported":
		return "Scores as Slop, held at Likely slop: imported entry not yet reviewed"
	case "audience":
		return "Scores as Slop, held at Likely slop: audience size unknown, needs staff review"
	default:
		return "Verdict expired and scores as Slop again: held at Likely slop until reviewed"
	}
}
