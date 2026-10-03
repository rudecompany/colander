// Package mail sends Colander's few emails through the Resend HTTP API.
// In dev mode, or when no API key is set, messages are printed instead of sent.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Mailer sends plain-text email.
type Mailer struct {
	APIKey   string
	From     string
	Dev      bool
	Endpoint string
	HTTP     *http.Client
	Out      io.Writer // where dev mode prints messages
	Log      *slog.Logger

	mu sync.Mutex // keeps printed messages whole
}

// New returns a mailer for the Resend API.
func New(apiKey, from string, dev bool, out io.Writer, log *slog.Logger) *Mailer {
	if from == "" {
		from = "Colander <hello@colander.local>"
	}
	return &Mailer{APIKey: apiKey, From: from, Dev: dev, Endpoint: "https://api.resend.com/emails",
		HTTP: &http.Client{Timeout: 10 * time.Second}, Out: out, Log: log}
}

// Send delivers one message.
func (m *Mailer) Send(ctx context.Context, to, subject, body string) error {
	if m.Dev {
		m.mu.Lock()
		defer m.mu.Unlock()
		_, err := fmt.Fprintf(m.Out, "\n==== Colander dev mail (not sent) ====\nTo: %s\nSubject: %s\n\n%s\n======================================\n\n",
			to, subject, body)
		return err
	}
	if m.APIKey == "" {
		m.Log.Warn("email not sent: RESEND_API_KEY is not set", "subject", subject)
		return fmt.Errorf("email delivery is not configured")
	}
	payload, err := json.Marshal(map[string]any{"from": m.From, "to": []string{to}, "subject": subject, "text": body})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.Endpoint, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+m.APIKey)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("resend: status %d: %s", resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

// SignIn is the sign-in email.
func SignIn(link string) (subject, body string) {
	return "Your Colander sign-in link", "Here is your link to sign in to Colander:\n\n" + link +
		"\n\nIt works once and expires in 20 minutes.\n" +
		"If you did not ask to sign in, you can ignore this email.\n\nColander"
}

// Appeal is the email a creator gets after filing an appeal.
func Appeal(sourceName, sourceNoun, code, link string) (subject, body string) {
	return "Your Colander appeal for " + sourceName,
		"We received your appeal for " + sourceName + ".\n\n" +
			"To show that you run this " + sourceNoun + ", add this code to its description:\n\n    " + code + "\n\n" +
			"Then open this link and choose Verify:\n\n" + link + "\n\n" +
			"Keep this link to yourself. It shows the status of your appeal.\n" +
			"Once the code is verified, the " + sourceNoun + " shows as Disputed for every Colander user while staff review your case, " +
			"and you can remove the code.\n" +
			"The outcome and the reasoning are published in the decision log.\n\nColander"
}
