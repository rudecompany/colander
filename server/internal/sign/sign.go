// Package sign holds the server's Ed25519 key and every signed format built on it:
// list signatures, signed JSON envelopes and plan tokens (contracts sections 3, 4 and 5).
package sign

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Context strings keep the uses of the single key apart.
const (
	ContextConfig = "colander:config:v1"
	ContextPlan   = "colander:plan:v1"
)

// Key is the server's signing key.
type Key struct {
	priv ed25519.PrivateKey
	// Public is the raw 32-byte public key.
	Public ed25519.PublicKey
	// ID is the first 8 bytes of SHA-256 over the public key.
	ID [8]byte
}

// KeyID returns the 8-byte key id of a public key.
func KeyID(pub ed25519.PublicKey) [8]byte {
	sum := sha256.Sum256(pub)
	var id [8]byte
	copy(id[:], sum[:8])
	return id
}

// NewKey builds a key from a 32-byte seed.
func NewKey(seed []byte) (*Key, error) {
	if len(seed) != ed25519.SeedSize {
		return nil, fmt.Errorf("signing key seed must be %d bytes, got %d", ed25519.SeedSize, len(seed))
	}
	priv := ed25519.NewKeyFromSeed(seed)
	pub := priv.Public().(ed25519.PublicKey)
	return &Key{priv: priv, Public: pub, ID: KeyID(pub)}, nil
}

// LoadKey reads a key file holding the base64 of a 32-byte seed.
func LoadKey(path string) (*Key, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read signing key: %w", err)
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, fmt.Errorf("decode signing key %s: %w", path, err)
	}
	return NewKey(seed)
}

// GenerateKeyFile writes a new random seed to path and refuses to overwrite an existing file.
func GenerateKeyFile(path string) (*Key, error) {
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return nil, err
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, err
		}
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, err
	}
	if _, err := f.WriteString(base64.StdEncoding.EncodeToString(seed) + "\n"); err != nil {
		f.Close()
		return nil, err
	}
	if err := f.Close(); err != nil {
		return nil, err
	}
	return NewKey(seed)
}

// PublicBase64 is the public key in the form the extension trusts (base64 of the raw key).
func (k *Key) PublicBase64() string { return base64.StdEncoding.EncodeToString(k.Public) }

// KeyIDHex is the key id as lowercase hex.
func (k *Key) KeyIDHex() string { return hex.EncodeToString(k.ID[:]) }

// Sign signs msg as is. Lists use it directly over header and entries.
func (k *Key) Sign(msg []byte) []byte { return ed25519.Sign(k.priv, msg) }

func contextMessage(context string, payload []byte) []byte {
	msg := make([]byte, 0, len(context)+1+len(payload))
	msg = append(msg, context...)
	msg = append(msg, 0)
	return append(msg, payload...)
}

// Envelope is the signed JSON envelope from contracts section 4.
type Envelope struct {
	KID     string `json:"kid"`
	Payload string `json:"payload"`
	Sig     string `json:"sig"`
}

// Envelope signs payload under context.
func (k *Key) Envelope(context string, payload []byte) Envelope {
	return Envelope{
		KID:     k.KeyIDHex(),
		Payload: base64.StdEncoding.EncodeToString(payload),
		Sig:     base64.StdEncoding.EncodeToString(ed25519.Sign(k.priv, contextMessage(context, payload))),
	}
}

// ErrBadSignature is returned for any envelope or token that fails verification.
var ErrBadSignature = errors.New("signature does not verify")

// VerifyEnvelope checks env against pub and context and returns the payload bytes.
func VerifyEnvelope(pub ed25519.PublicKey, context string, env Envelope) ([]byte, error) {
	id := KeyID(pub)
	if env.KID != hex.EncodeToString(id[:]) {
		return nil, fmt.Errorf("envelope key id %q does not match", env.KID)
	}
	payload, err := base64.StdEncoding.DecodeString(env.Payload)
	if err != nil {
		return nil, fmt.Errorf("envelope payload: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(env.Sig)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, ErrBadSignature
	}
	if !ed25519.Verify(pub, contextMessage(context, payload), sig) {
		return nil, ErrBadSignature
	}
	return payload, nil
}

// PlanClaims is the payload of a plan token (contracts section 5).
type PlanClaims struct {
	V     int    `json:"v"`
	Sub   string `json:"sub"`
	Plan  string `json:"plan"`
	Trial bool   `json:"trial"`
	IAT   int64  `json:"iat"`
	EXP   int64  `json:"exp"`
}

// IssuePlanToken signs claims into the compact token form.
func (k *Key) IssuePlanToken(c PlanClaims) (string, error) {
	payload, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	sig := ed25519.Sign(k.priv, contextMessage(ContextPlan, payload))
	enc := base64.RawURLEncoding
	return enc.EncodeToString(payload) + "." + enc.EncodeToString(sig), nil
}

// ErrExpired is returned for a plan token whose exp has passed.
var ErrExpired = errors.New("plan token expired")

// VerifyPlanToken checks a plan token's signature and expiry and returns its claims.
func VerifyPlanToken(pub ed25519.PublicKey, token string, now time.Time) (PlanClaims, error) {
	var c PlanClaims
	payloadPart, sigPart, ok := strings.Cut(strings.TrimSpace(token), ".")
	if !ok {
		return c, ErrBadSignature
	}
	enc := base64.RawURLEncoding
	payload, err := enc.DecodeString(payloadPart)
	if err != nil {
		return c, ErrBadSignature
	}
	sig, err := enc.DecodeString(sigPart)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return c, ErrBadSignature
	}
	if !ed25519.Verify(pub, contextMessage(ContextPlan, payload), sig) {
		return c, ErrBadSignature
	}
	dec := json.NewDecoder(bytes.NewReader(payload))
	if err := dec.Decode(&c); err != nil {
		return c, ErrBadSignature
	}
	if c.V != 1 || c.Sub == "" {
		return c, ErrBadSignature
	}
	if now.Unix() >= c.EXP {
		return c, ErrExpired
	}
	return c, nil
}
