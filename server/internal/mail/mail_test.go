package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResendAndDevMode(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"id":"email_1"}`))
	}))
	defer srv.Close()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	m := New("re_test", "Colander <hello@colander.test>", false, nil, log)
	m.Endpoint = srv.URL
	subject, body := SignIn("https://colander.test/auth/callback?token=t")
	if err := m.Send(context.Background(), "maya@example.test", subject, body); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer re_test" || got["from"] != "Colander <hello@colander.test>" || got["subject"] != subject ||
		got["to"].([]any)[0] != "maya@example.test" || !strings.Contains(got["text"].(string), "token=t") {
		t.Fatalf("resend request: auth %q body %v", auth, got)
	}

	var out bytes.Buffer
	dev := New("re_test", "", true, &out, log)
	dev.Endpoint = "http://127.0.0.1:1" // must not be called
	if err := dev.Send(context.Background(), "maya@example.test", subject, body); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "token=t") || !strings.Contains(out.String(), "not sent") {
		t.Fatalf("dev output = %q", out.String())
	}
}
