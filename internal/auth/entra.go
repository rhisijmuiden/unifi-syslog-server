// Package auth implements Microsoft Entra ID (Azure AD) single sign-on via
// OpenID Connect with PKCE.
package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

type Entra struct {
	Meta *store.Meta

	mu       sync.Mutex
	key      string
	provider *oidc.Provider
	pending  map[string]pending
}

type pending struct {
	verifier string
	nonce    string
	expires  time.Time
}

type Identity struct {
	Subject  string
	Username string
	Email    string
	Name     string
	Groups   []string
}

func (e *Entra) issuer(s store.SSOSettings) string {
	return "https://login.microsoftonline.com/" + s.TenantID + "/v2.0"
}

func (e *Entra) RedirectURL(base string) string {
	return strings.TrimRight(base, "/") + "/api/auth/entra/callback"
}

func (e *Entra) config(ctx context.Context, base string) (*oauth2.Config, *oidc.Provider, store.SSOSettings, error) {
	s := e.Meta.SSO()
	if !s.Enabled || s.TenantID == "" || s.ClientID == "" {
		return nil, nil, s, errors.New("Entra SSO is niet ingeschakeld")
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.provider == nil || e.key != s.TenantID {
		p, err := oidc.NewProvider(ctx, e.issuer(s))
		if err != nil {
			return nil, nil, s, fmt.Errorf("OIDC discovery: %w", err)
		}
		e.provider, e.key = p, s.TenantID
	}
	return &oauth2.Config{
		ClientID:     s.ClientID,
		ClientSecret: s.ClientSecret,
		Endpoint:     e.provider.Endpoint(),
		RedirectURL:  e.RedirectURL(base),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}, e.provider, s, nil
}

// Begin returns the authorization URL and the state value to store in a cookie.
func (e *Entra) Begin(ctx context.Context, base string) (string, string, error) {
	cfg, _, _, err := e.config(ctx, base)
	if err != nil {
		return "", "", err
	}
	state := store.RandomToken(16)
	verifier := oauth2.GenerateVerifier()
	nonce := store.RandomToken(16)
	e.mu.Lock()
	if e.pending == nil {
		e.pending = map[string]pending{}
	}
	for k, v := range e.pending {
		if time.Now().After(v.expires) {
			delete(e.pending, k)
		}
	}
	e.pending[state] = pending{verifier: verifier, nonce: nonce, expires: time.Now().Add(10 * time.Minute)}
	e.mu.Unlock()
	url := cfg.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier), oidc.Nonce(nonce), oauth2.SetAuthURLParam("response_mode", "query"))
	return url, state, nil
}

func (e *Entra) Finish(ctx context.Context, base, state, code string) (*Identity, error) {
	e.mu.Lock()
	p, ok := e.pending[state]
	delete(e.pending, state)
	e.mu.Unlock()
	if !ok || time.Now().After(p.expires) {
		return nil, errors.New("ongeldige of verlopen aanmeldsessie")
	}
	cfg, prov, s, err := e.config(ctx, base)
	if err != nil {
		return nil, err
	}
	tok, err := cfg.Exchange(ctx, code, oauth2.VerifierOption(p.verifier))
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return nil, errors.New("geen id_token ontvangen")
	}
	idt, err := prov.Verifier(&oidc.Config{ClientID: s.ClientID}).Verify(ctx, raw)
	if err != nil {
		return nil, fmt.Errorf("id_token: %w", err)
	}
	if idt.Nonce != p.nonce {
		return nil, errors.New("nonce mismatch")
	}
	var c struct {
		OID               string   `json:"oid"`
		PreferredUsername string   `json:"preferred_username"`
		Email             string   `json:"email"`
		Name              string   `json:"name"`
		Groups            []string `json:"groups"`
		TID               string   `json:"tid"`
	}
	if err := idt.Claims(&c); err != nil {
		return nil, err
	}
	if !strings.EqualFold(c.TID, s.TenantID) && !strings.Contains(s.TenantID, ".") {
		return nil, errors.New("verkeerde tenant")
	}
	id := &Identity{Subject: first(c.OID, idt.Subject), Username: first(c.PreferredUsername, c.Email), Email: first(c.Email, c.PreferredUsername), Name: c.Name, Groups: c.Groups}
	if s.AllowedGroup != "" && !contains(id.Groups, s.AllowedGroup) && !contains(id.Groups, s.AdminGroupID) {
		return nil, errors.New("je account is geen lid van de toegestane groep")
	}
	return id, nil
}

// Role maps group membership to an application role.
func (e *Entra) Role(id *Identity) string {
	s := e.Meta.SSO()
	if s.AdminGroupID != "" && contains(id.Groups, s.AdminGroupID) {
		return "admin"
	}
	if s.DefaultRole == "admin" {
		return "admin"
	}
	return "viewer"
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if strings.EqualFold(x, s) {
			return true
		}
	}
	return false
}

func first(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

