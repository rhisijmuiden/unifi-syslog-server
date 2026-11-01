package mcpbridge

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type echoIn struct {
	Text string `json:"text"`
}

func testServer(t *testing.T, jsonResponse bool) *httptest.Server {
	srv := mcp.NewServer(&mcp.Implementation{Name: "t", Version: "1"}, nil)
	mcp.AddTool(srv, &mcp.Tool{Name: "echo"}, func(ctx context.Context, req *mcp.CallToolRequest, in echoIn) (*mcp.CallToolResult, any, error) {
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: in.Text}}}, nil, nil
	})
	h := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return srv }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: jsonResponse})
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer uss_good" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(401)
			io.WriteString(w, `{"error":"invalid or expired API token"}`)
			return
		}
		h.ServeHTTP(w, r)
	}))
	t.Cleanup(ts.Close)
	return ts
}

func run(t *testing.T, url, token string, lines ...string) []map[string]any {
	t.Helper()
	pr, pw := io.Pipe()
	b := &Bridge{URL: url + "/mcp", Token: token, Client: http.DefaultClient, Out: pw}
	in := strings.Join(lines, "\n") + "\n"
	go func() { b.Run(context.Background(), strings.NewReader(in)); pw.Close() }()
	var out []map[string]any
	sc := bufio.NewScanner(pr)
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("not JSON: %s", sc.Text())
		}
		out = append(out, m)
	}
	return out
}

const initMsg = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"c","version":"1"}}}`

func TestBridge(t *testing.T) {
	for _, jsonResp := range []bool{true, false} {
		ts := testServer(t, jsonResp)
		out := run(t, ts.URL, "uss_good", initMsg,
			`{"jsonrpc":"2.0","method":"notifications/initialized"}`,
			`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hello"}}}`)
		if len(out) != 2 {
			t.Fatalf("json=%v: %d answers: %v", jsonResp, len(out), out)
		}
		var got string
		for _, m := range out {
			if m["id"].(float64) == 2 {
				b, _ := json.Marshal(m["result"])
				got = string(b)
			}
		}
		if !strings.Contains(got, "hello") {
			t.Fatalf("json=%v: tool answer %v", jsonResp, out)
		}
	}

	// A refused token becomes a JSON-RPC error for the request.
	ts := testServer(t, true)
	out := run(t, ts.URL, "uss_bad", initMsg)
	if len(out) != 1 || out[0]["error"] == nil || !strings.Contains(out[0]["error"].(map[string]any)["message"].(string), "invalid or expired") {
		t.Fatalf("bad token: %v", out)
	}
}

func TestEndpoint(t *testing.T) {
	for in, want := range map[string]string{
		"syslog.example.com:8080":          "https://syslog.example.com:8080/mcp",
		"https://syslog.example.com:8080/": "https://syslog.example.com:8080/mcp",
		"http://10.0.0.5:8080/mcp":         "http://10.0.0.5:8080/mcp",
	} {
		if got, err := Endpoint(in); err != nil || got != want {
			t.Errorf("%s: %s %v", in, got, err)
		}
	}
	if _, err := Endpoint("ftp://x"); err == nil {
		t.Error("ftp accepted")
	}
}
