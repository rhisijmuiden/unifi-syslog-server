package api

import (
	"encoding/json"
	"testing"
	"time"
)

type globalResult struct {
	Groups []globalGroup `json:"groups"`
}

func globalCall(t *testing.T, s *Server, tok, q string) map[string]globalGroup {
	t.Helper()
	w := call(s.Handler(), tok, "GET", "/api/global-search?q="+q, "", nil)
	if w.Code != 200 {
		t.Fatalf("global search %q: %d %s", q, w.Code, w.Body)
	}
	var out globalResult
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	m := map[string]globalGroup{}
	for _, g := range out.Groups {
		m[g.Type] = g
	}
	return m
}

func TestGlobalSearch(t *testing.T) {
	s, h, admin := testServer(t)
	viewer := addUser(t, s.Meta, "vic", "viewer", "branch")
	now := time.Now()
	s.Meta.TouchDevice("U6-Pro", "U6PRO", "aa:bb:cc:00:00:01", "8.0.1", "hq", "10.0.0.2", now)
	s.Meta.TouchDevice("U6-Lite", "U6LITE", "aa:bb:cc:00:00:02", "8.0.1", "branch", "10.1.0.2", now)

	if w, _ := jsonCall(t, h, admin, "POST", "/api/alerts", `{"name":"U6 offline","query":"host:U6*","threshold":1,"window_minutes":5,"cooldown_minutes":60,"enabled":true}`); w.Code != 200 {
		t.Fatalf("alert: %d %s", w.Code, w.Body)
	}
	if w, _ := jsonCall(t, h, admin, "POST", "/api/saved-searches", `{"name":"Private U6 search","query":"host:U6*"}`); w.Code != 200 {
		t.Fatalf("saved search: %d %s", w.Code, w.Body)
	}

	// Every word must match; the best title match comes first.
	g := globalCall(t, s, admin, "u6")
	if g["device"].Total != 2 || g["alert"].Total != 1 || g["saved_search"].Total != 1 {
		t.Fatalf("admin: %+v", g)
	}
	if it := g["alert"].Items[0]; it.Link != "/alerts?edit=1" {
		t.Errorf("alert link: %+v", it)
	}
	if g := globalCall(t, s, admin, "u6+branch"); g["device"].Total != 1 || g["device"].Items[0].Title != "U6-Lite" {
		t.Errorf("two words: %+v", g["device"])
	}

	// Viewers only see their sites, no administration and no private
	// searches of others.
	g = globalCall(t, s, viewer, "u6")
	if g["device"].Total != 1 || g["device"].Items[0].Title != "U6-Lite" {
		t.Errorf("viewer devices: %+v", g["device"])
	}
	if _, ok := g["alert"]; ok {
		t.Error("viewer sees alerts")
	}
	if _, ok := g["saved_search"]; ok {
		t.Error("viewer sees a private saved search")
	}
	if _, ok := globalCall(t, s, viewer, "default")["site"]; ok {
		t.Error("viewer sees the default site")
	}
	if g := globalCall(t, s, admin, "default"); g["site"].Total != 1 {
		t.Errorf("admin site: %+v", g["site"])
	}
	if g := globalCall(t, s, admin, "vic"); g["user"].Total != 1 || g["user"].Items[0].Link == "" {
		t.Errorf("users: %+v", g["user"])
	}
	if g := globalCall(t, s, admin, "+"); len(g) != 0 {
		t.Errorf("empty query: %+v", g)
	}
}

func TestGlobalLogQuery(t *testing.T) {
	for in, want := range map[string]string{
		"category:firewall":  "category:firewall",
		"connection refused": "connection refused",
		"nosuchfield:x":      `"nosuchfield:x"`,
		`say "hi`:            `"say hi"`,
	} {
		if got := globalLogQuery(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}
