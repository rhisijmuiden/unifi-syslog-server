// SPDX-License-Identifier: AGPL-3.0-or-later

package api

import (
	"encoding/json"
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
