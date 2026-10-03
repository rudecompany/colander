package billing

import (
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/rudecompany/colander/server/internal/billing/billingtest"
)

func TestVerifySignature(t *testing.T) {
	const secret = "whsec_unit"
	now := time.Date(2026, 10, 3, 12, 0, 0, 0, time.UTC)
	payload := []byte(`{"id":"evt_1","type":"invoice.paid"}`)
	good := billingtest.Sign(payload, secret, now)
	ts := "t=" + strconv.FormatInt(now.Unix(), 10)

	ok := []string{
		good,
		good + ",v1=" + "00" + good[len(good)-62:], // an extra v1 from a rolled secret
		ts + ",v1=deadbeef," + good[len(ts)+1:],    // the matching v1 second
		good + ",v0=ignored",
	}
	for _, h := range ok {
		if err := VerifySignature(payload, h, secret, now); err != nil {
			t.Errorf("%q: %v", h, err)
		}
	}
	if err := VerifySignature(payload, good, secret, now.Add(4*time.Minute)); err != nil {
		t.Errorf("within tolerance: %v", err)
	}

	bad := map[string]string{
		"tampered payload": "",
		"wrong secret":     billingtest.Sign(payload, "whsec_other", now),
		"stale":            billingtest.Sign(payload, secret, now.Add(-6*time.Minute)),
		"from the future":  billingtest.Sign(payload, secret, now.Add(6*time.Minute)),
		"no v1":            ts,
		"no timestamp":     good[len(ts)+1:],
		"empty":            "",
		"not hex":          ts + ",v1=zz",
	}
	for name, h := range bad {
		body := payload
		if name == "tampered payload" {
			h, body = good, []byte(`{"id":"evt_1","type":"invoice.paid "}`)
		}
		if err := VerifySignature(body, h, secret, now); !errors.Is(err, ErrSignature) {
			t.Errorf("%s: %v, want ErrSignature", name, err)
		}
	}
	if err := VerifySignature(payload, good, "", now); !errors.Is(err, ErrSignature) {
		t.Error("an empty secret must never verify")
	}
}
