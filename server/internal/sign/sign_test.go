package sign

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func devKey(t *testing.T) *Key {
	t.Helper()
	k, err := LoadKey("../../testdata/dev-signing.key")
	if err != nil {
		t.Fatal(err)
	}
	pub, err := os.ReadFile("../../testdata/dev-signing.pub")
	if err != nil {
		t.Fatal(err)
	}
	if k.PublicBase64() != strings.TrimSpace(string(pub)) {
		t.Fatal("dev key and dev public key do not match")
	}
	return k
}

func TestContractEnvelope(t *testing.T) {
	k := devKey(t)
	raw, err := os.ReadFile("../../../testdata/contract/config-envelope.json")
	if err != nil {
		t.Fatal(err)
	}
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatal(err)
	}
	payload, err := VerifyEnvelope(k.Public, ContextConfig, env)
	if err != nil {
		t.Fatal(err)
	}
	if string(payload) != `{"version":7,"note":"contract fixture"}` {
		t.Fatalf("payload = %s", payload)
	}
	// Our own envelope over the same payload must be identical (Ed25519 is deterministic).
	if got := k.Envelope(ContextConfig, payload); got != env {
		t.Fatalf("envelope differs: %+v", got)
	}
	if _, err := VerifyEnvelope(k.Public, ContextPlan, env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("wrong context verified: %v", err)
	}
	env.Payload = "eyJ2ZXJzaW9uIjo4fQ==" // {"version":8}
	if _, err := VerifyEnvelope(k.Public, ContextConfig, env); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("tampered payload verified: %v", err)
	}
}

func TestContractPlanToken(t *testing.T) {
	k := devKey(t)
	raw, err := os.ReadFile("../../../testdata/contract/plan-token.txt")
	if err != nil {
		t.Fatal(err)
	}
	token := strings.TrimSpace(string(raw))
	c, err := VerifyPlanToken(k.Public, token, time.Unix(1790000000, 0))
	if err != nil {
		t.Fatal(err)
	}
	want := PlanClaims{V: 1, Sub: "acc_fixture", Plan: "plus", IAT: 1790000000, EXP: 1792600000}
	if c != want {
		t.Fatalf("claims = %+v", c)
	}
	if again, _ := k.IssuePlanToken(want); again != token {
		t.Fatalf("issued token differs from fixture")
	}
	if _, err := VerifyPlanToken(k.Public, token, time.Unix(1792600000, 0)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired token accepted: %v", err)
	}
	tampered := "x" + token[1:]
	if _, err := VerifyPlanToken(k.Public, tampered, time.Unix(1790000000, 0)); !errors.Is(err, ErrBadSignature) {
		t.Fatalf("tampered token accepted: %v", err)
	}
}
