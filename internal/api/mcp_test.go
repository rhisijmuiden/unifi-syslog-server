package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

type bearerTransport string

func (b bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+string(b))
	return http.DefaultTransport.RoundTrip(r)
}

func mcpConnect(t *testing.T, url, token string) *mcp.ClientSession {
	t.Helper()
	c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil)
	cs, err := c.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint: url + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport(token)},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func toolNames(t *testing.T, cs *mcp.ClientSession) []string {
	t.Helper()
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	var n []string
	for _, x := range res.Tools {
		if x.Annotations == nil || !x.Annotations.ReadOnlyHint {
			t.Errorf("tool %s is not marked read-only", x.Name)
		}
		n = append(n, x.Name)
	}
	return n
}

func callText(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (string, bool) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Content) == 0 {
		t.Fatalf("%s: no content", name)
	}
	return res.Content[0].(*mcp.TextContent).Text, res.IsError
}

func TestMCP(t *testing.T) {
	s, h, adminSess := testServer(t)
	srv := httptest.NewServer(h)
	defer srv.Close()
	addUser(t, s.Meta, "viewer", store.RoleViewer, "amsterdam")
	admin, viewer := tokenFor(t, s.Meta, "admin"), tokenFor(t, s.Meta, "viewer")

	// No or a wrong token.
	for _, auth := range []string{"", "Bearer uss_nope"} {
		r, _ := http.NewRequest("POST", srv.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		if auth != "" {
			r.Header.Set("Authorization", auth)
		}
		resp, err := http.DefaultClient.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 || resp.Header.Get("WWW-Authenticate") == "" {
			t.Fatalf("auth %q: status %d", auth, resp.StatusCode)
		}
	}

	// Administrators get every tool, viewers no admin tools.
	adminTools := toolNames(t, mcpConnect(t, srv.URL, admin))
	vs := mcpConnect(t, srv.URL, viewer)
	viewerTools := toolNames(t, vs)
	for _, n := range []string{"search_logs", "count_logs", "top_values", "search_everything", "list_devices", "query_language"} {
		if !slices.Contains(viewerTools, n) {
			t.Errorf("viewer misses %s", n)
		}
	}
	if !slices.Contains(adminTools, "get_system_status") || slices.Contains(viewerTools, "get_system_status") || slices.Contains(viewerTools, "list_alert_rules") {
		t.Fatalf("admin tools: admin %v, viewer %v", adminTools, viewerTools)
	}

	// Tools call the API with the caller's token.
	s.Meta.SaveSearch(&store.SavedSearch{OwnerID: 1, Name: "SSH from outside", Query: "dport:22", Shared: true})
	txt, isErr := callText(t, vs, "list_saved_searches", nil)
	if isErr || !strings.Contains(txt, "SSH from outside") {
		t.Fatalf("saved searches: %v %s", isErr, txt)
	}
	txt, isErr = callText(t, vs, "query_language", nil)
	if isErr || !strings.Contains(txt, "firewall") || !strings.Contains(txt, "dport") {
		t.Fatalf("query language: %s", txt)
	}
	// API errors become tool errors.
	txt, isErr = callText(t, vs, "search_logs", map[string]any{"query": "dport:(", "last": "1h"})
	if !isErr {
		t.Fatalf("invalid query accepted: %s", txt)
	}
	txt, isErr = callText(t, vs, "search_logs", map[string]any{"last": "soon"})
	if !isErr || !strings.Contains(txt, "invalid duration") {
		t.Fatalf("invalid duration: %s", txt)
	}
	// An admin tool is refused for a viewer even when called by name.
	if res, err := vs.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_system_status"}); err == nil && !res.IsError {
		t.Fatal("viewer called an admin tool")
	}

	// The settings page: info for everyone, the switch for admins.
	var info struct {
		Settings store.MCPSettings       `json:"settings"`
		Endpoint string                  `json:"endpoint"`
		Tools    []struct{ Name string } `json:"tools"`
	}
	sess := addUser(t, s.Meta, "viewer2", store.RoleViewer)
	w := call(h, sess, "GET", "/api/mcp", "", nil)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &info) != nil || !info.Settings.Enabled || !strings.HasSuffix(info.Endpoint, "/mcp") || len(info.Tools) != len(viewerTools) {
		t.Fatalf("info: %d %s", w.Code, w.Body)
	}
	if w := call(h, sess, "PUT", "/api/settings/mcp", "application/json", []byte(`{"enabled":false}`)); w.Code != 403 {
		t.Fatalf("viewer changed MCP settings: %d", w.Code)
	}
	if w := call(h, adminSess, "PUT", "/api/settings/mcp", "application/json", []byte(`{"enabled":false}`)); w.Code != 200 {
		t.Fatalf("turn off: %d %s", w.Code, w.Body)
	}
	r, _ := http.NewRequest("POST", srv.URL+"/mcp", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+admin)
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Fatalf("turned off: status %d", resp.StatusCode)
	}
}

func TestMCPDuration(t *testing.T) {
	for in, want := range map[string]string{"15m": "15m0s", "1h": "1h0m0s", "7d": "168h0m0s", "2w": "336h0m0s", "1.5d": "36h0m0s"} {
		d, err := parseMCPDuration(in)
		if err != nil || d.String() != want {
			t.Errorf("%s: %v %v", in, d, err)
		}
	}
	for _, in := range []string{"", "x", "-1h", "0d", "100000d"} {
		if _, err := parseMCPDuration(in); err == nil {
			t.Errorf("%q accepted", in)
		}
	}
}
