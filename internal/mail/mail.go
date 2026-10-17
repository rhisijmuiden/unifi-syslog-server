// Package mail sends notifications through a user-configured SMTP server.
// Supports implicit TLS (465), STARTTLS (mandatory or opportunistic), TLS
// 1.2/1.3 minimums, PLAIN/LOGIN/CRAM-MD5/SCRAM-SHA-1/SCRAM-SHA-256 and
// XOAUTH2 with Microsoft 365 client-credentials tokens.
package mail

import (
	"context"
	"crypto/tls"
	"fmt"
	"html"
	"strings"
	"time"

	gomail "github.com/wneessen/go-mail"
	"golang.org/x/oauth2/clientcredentials"

	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

type Mailer struct {
	Meta *store.Meta
}

func (m *Mailer) Configured() bool {
	s := m.Meta.SMTP()
	return s.Enabled && s.Host != "" && s.FromAddress != ""
}

// Send delivers a message. body is plain text; an HTML alternative with the
// app's styling is generated from it.
func (m *Mailer) Send(ctx context.Context, to []string, subject, body string) error {
	return SendWith(ctx, m.Meta.SMTP(), m.Meta.General().InstanceName, to, subject, body)
}

func SendWith(ctx context.Context, s store.SMTPSettings, instance string, to []string, subject, body string) error {
	if s.Host == "" || s.FromAddress == "" {
		return fmt.Errorf("SMTP is niet geconfigureerd")
	}
	var rcpt []string
	for _, t := range to {
		for _, p := range strings.FieldsFunc(t, func(r rune) bool { return r == ',' || r == ';' || r == ' ' }) {
			rcpt = append(rcpt, p)
		}
	}
	if len(rcpt) == 0 {
		rcpt = strings.FieldsFunc(s.DefaultTo, func(r rune) bool { return r == ',' || r == ';' || r == ' ' })
	}
	if len(rcpt) == 0 {
		return fmt.Errorf("geen ontvangers opgegeven")
	}

	tlsCfg := &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: s.SkipVerify}
	if s.MinTLS == "1.3" {
		tlsCfg.MinVersion = tls.VersionTLS13
	}
	opts := []gomail.Option{gomail.WithTimeout(30 * time.Second), gomail.WithTLSConfig(tlsCfg)}
	if s.Port > 0 {
		opts = append(opts, gomail.WithPort(s.Port))
	}
	switch s.Security {
	case "tls":
		opts = append(opts, gomail.WithSSL())
	case "none":
		opts = append(opts, gomail.WithTLSPolicy(gomail.NoTLS))
	case "starttls-optional":
		opts = append(opts, gomail.WithTLSPolicy(gomail.TLSOpportunistic))
	default:
		opts = append(opts, gomail.WithTLSPolicy(gomail.TLSMandatory))
	}
	if s.HELO != "" {
		opts = append(opts, gomail.WithHELO(s.HELO))
	}
	password := s.Password
	switch strings.ToLower(s.Auth) {
	case "", "none":
	case "auto":
		if s.Username != "" {
			opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthAutoDiscover))
		}
	case "plain":
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthPlain))
	case "login":
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthLogin))
	case "cram-md5":
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthCramMD5))
	case "scram-sha-1":
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthSCRAMSHA1))
	case "scram-sha-256":
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthSCRAMSHA256))
	case "xoauth2":
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthXOAUTH2))
		if s.OAuthClientID != "" {
			tok, err := oauthToken(ctx, s)
			if err != nil {
				return fmt.Errorf("OAuth2-token ophalen: %w", err)
			}
			password = tok
		}
	default:
		return fmt.Errorf("onbekende authenticatiemethode %q", s.Auth)
	}
	if s.Auth != "none" && s.Username != "" {
		opts = append(opts, gomail.WithUsername(s.Username), gomail.WithPassword(password))
	}
	c, err := gomail.NewClient(s.Host, opts...)
	if err != nil {
		return err
	}

	msg := gomail.NewMsg()
	if err := msg.FromFormat(s.FromName, s.FromAddress); err != nil {
		return err
	}
	if err := msg.To(rcpt...); err != nil {
		return err
	}
	msg.Subject(subject)
	msg.SetDate()
	msg.SetMessageID()
	msg.SetBodyString(gomail.TypeTextPlain, body)
	msg.AddAlternativeString(gomail.TypeTextHTML, htmlBody(instance, subject, body))
	return c.DialAndSendWithContext(ctx, msg)
}

func oauthToken(ctx context.Context, s store.SMTPSettings) (string, error) {
	scope := s.OAuthScope
	if scope == "" {
		scope = "https://outlook.office365.com/.default"
	}
	cc := clientcredentials.Config{
		ClientID:     s.OAuthClientID,
		ClientSecret: s.OAuthSecret,
		TokenURL:     "https://login.microsoftonline.com/" + s.OAuthTenant + "/oauth2/v2.0/token",
		Scopes:       []string{scope},
	}
	t, err := cc.Token(ctx)
	if err != nil {
		return "", err
	}
	return t.AccessToken, nil
}

func htmlBody(instance, subject, body string) string {
	return `<!doctype html><html><body style="margin:0;background:#0b1020;font-family:Inter,Segoe UI,Arial,sans-serif">
<div style="max-width:640px;margin:32px auto;background:#111827;border-radius:16px;overflow:hidden;border:1px solid #1f2937">
<div style="padding:20px 28px;background:linear-gradient(135deg,#4f46e5,#06b6d4);color:#fff;font-weight:600;font-size:16px">` + html.EscapeString(instance) + `</div>
<div style="padding:28px;color:#e5e7eb"><h2 style="margin:0 0 16px;font-size:20px;color:#fff">` + html.EscapeString(subject) + `</h2>
<pre style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.6;color:#cbd5e1;margin:0">` + html.EscapeString(body) + `</pre></div>
<div style="padding:16px 28px;color:#6b7280;font-size:12px;border-top:1px solid #1f2937">Automatisch verzonden door ` + html.EscapeString(instance) + `</div>
</div></body></html>`
}
