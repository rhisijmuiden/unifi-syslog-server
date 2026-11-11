// SPDX-License-Identifier: AGPL-3.0-or-later

package api

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

func TestAttackMap(t *testing.T) {
	_, h, tok := testServer(t)

	w := call(h, tok, "GET", "/api/attack-map", "", nil)
	if w.Code != 200 || !json.Valid(w.Body.Bytes()) || w.Body.String() != "{\"firewalls\":[]}\n" {
		t.Fatalf("empty: %d %q", w.Code, w.Body)
	}

	for _, bad := range []string{
		`{"firewalls":[{"country":"Netherlands"}]}`,
		`{"firewalls":[{"country":"NL","lat":91}]}`,
		`{"firewalls":[{"country":"NL"},{"country":"BE"}]}`,
		`{"firewalls":[{"site":"HQ","country":"NL"},{"site":" HQ ","country":"BE"}]}`,
	} {
		if w := call(h, tok, "PUT", "/api/settings/attack-map", "application/json", []byte(bad)); w.Code != 400 {
			t.Errorf("%s: want 400, got %d", bad, w.Code)
		}
	}

	ok := `{"firewalls":[{"site":"","label":" Amsterdam ","country":"nl","lat":52.37,"lon":4.9},{"site":"Branch","label":"Gent","country":"BE"}]}`
	if w := call(h, tok, "PUT", "/api/settings/attack-map", "application/json", []byte(ok)); w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	var got store.AttackMapSettings
	w = call(h, tok, "GET", "/api/attack-map", "", nil)
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Firewalls) != 2 || got.Firewalls[0].Country != "NL" || got.Firewalls[0].Label != "Amsterdam" || got.Firewalls[1].Site != "Branch" {
		t.Fatalf("got %+v", got)
	}
}

func TestAttackMapShares(t *testing.T) {
	_, h, tok := testServer(t)
	fw := `{"firewalls":[{"site":"","label":"HQ","country":"NL"},{"site":"Secret branch","label":"Gent","country":"BE"},{"site":"Other","label":"Paris","country":"FR"}]}`
	if w := call(h, tok, "PUT", "/api/settings/attack-map", "application/json", []byte(fw)); w.Code != 200 {
		t.Fatalf("save firewalls: %d %s", w.Code, w.Body)
	}
	if w := call(h, tok, "POST", "/api/settings/attack-map/shares", "application/json", []byte(`{"name":" "}`)); w.Code != 400 {
		t.Fatalf("empty name: %d", w.Code)
	}
	w := call(h, tok, "POST", "/api/settings/attack-map/shares", "application/json", []byte(`{"name":"Lobby TV","sites":["Secret branch"]}`))
	if w.Code != 200 {
		t.Fatalf("create: %d %s", w.Code, w.Body)
	}
	var sh store.AttackMapShare
	json.Unmarshal(w.Body.Bytes(), &sh)
	if len(sh.Token) < 30 || sh.ID == "" || sh.CreatedBy != "admin" {
		t.Fatalf("share %+v", sh)
	}

	// Without a session: the public config works, site names stay hidden.
	w = call(h, "", "GET", "/api/public/attack-map/"+sh.Token, "", nil)
	if w.Code != 200 {
		t.Fatalf("public: %d %s", w.Code, w.Body)
	}
	body := w.Body.String()
	if strings.Contains(body, "Secret branch") || strings.Contains(body, sh.Token) || strings.Contains(body, "Paris") || !strings.Contains(body, `"site":"s1"`) || !strings.Contains(body, "Lobby TV") {
		t.Fatalf("public config leaks or misses data: %s", body)
	}
	if w := call(h, "", "GET", "/api/public/attack-map/"+sh.Token+"x", "", nil); w.Code != 404 {
		t.Fatalf("wrong token: %d", w.Code)
	}
	if w := call(h, "", "GET", "/api/settings/attack-map/shares", "", nil); w.Code != 401 {
		t.Fatalf("list without session: %d", w.Code)
	}

	// Revoking makes the link stop working.
	if w := call(h, tok, "DELETE", "/api/settings/attack-map/shares/"+sh.ID, "", nil); w.Code != 204 {
		t.Fatalf("delete: %d", w.Code)
	}
	if w := call(h, "", "GET", "/api/public/attack-map/"+sh.Token, "", nil); w.Code != 404 {
		t.Fatalf("revoked: %d", w.Code)
	}
}
