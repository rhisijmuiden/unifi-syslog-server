// SPDX-License-Identifier: AGPL-3.0-or-later

// Package mcpbridge connects an MCP client that only speaks stdio (such
// as Claude Desktop) to the server's Streamable HTTP endpoint at /mcp. It
// reads JSON-RPC messages, one per line, from stdin, posts each to the
// server with the API token and writes the answers to stdout.
package mcpbridge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/rhisijmuiden/unify-syslog-server/internal/tlscert"
)

type Bridge struct {
	URL      string
	Token    string
	Client   *http.Client
	Out      io.Writer
	Log      io.Writer
	outMu    sync.Mutex
	mu       sync.Mutex
	protocol string
	session  string
	wg       sync.WaitGroup
}

// Main runs the bridge with command line flags and environment variables;
// name is the command shown in the usage text.
func Main(name string, args []string) error {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	u := fs.String("url", os.Getenv("USS_MCP_URL"), "server address, e.g. https://syslog.example.com:8080 (or $USS_MCP_URL)")
	tok := fs.String("token", "", "API token uss_… (better: $USS_MCP_TOKEN, so it is not visible in the process list)")
	pin := fs.String("pin", os.Getenv("USS_MCP_PIN"), "trust the server certificate with this public key pin (self-signed certificate; or $USS_MCP_PIN)")
	insecure := fs.Bool("insecure", false, "do not verify the server certificate at all")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Usage: %s --url https://syslog.example.com:8080 [--pin …]\n\n"+
			"Connects an MCP client that uses stdio (Claude Desktop, …) to UniFi Syslog Server.\n"+
			"Set the API token in USS_MCP_TOKEN.\n\n", name)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *tok == "" {
		*tok = os.Getenv("USS_MCP_TOKEN")
	}
	if *u == "" || *tok == "" {
		fs.Usage()
		return errors.New("--url and an API token (USS_MCP_TOKEN) are required")
	}
	endpoint, err := Endpoint(*u)
	if err != nil {
		return err
	}
	host := ""
	if p, err := url.Parse(endpoint); err == nil {
		host = p.Hostname()
	}
	tc := tlscert.ClientConfig(host, *pin)
	if *insecure {
		tc = &tls.Config{InsecureSkipVerify: true}
	}
	b := &Bridge{URL: endpoint, Token: *tok, Out: os.Stdout, Log: os.Stderr, Client: &http.Client{
		Timeout:   2 * time.Minute,
		Transport: &http.Transport{Proxy: http.ProxyFromEnvironment, TLSClientConfig: tc, ForceAttemptHTTP2: true},
	}}
	return b.Run(context.Background(), os.Stdin)
}

// Endpoint turns a server address into the URL of its MCP endpoint.
func Endpoint(s string) (string, error) {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("invalid server address %q", s)
	}
	if u.Path == "" || u.Path == "/" {
		u.Path = "/mcp"
	}
	return u.String(), nil
}

// Run copies messages until stdin is closed.
func (b *Bridge) Run(ctx context.Context, in io.Reader) error {
	r := bufio.NewReaderSize(in, 1<<16)
	for {
		line, err := r.ReadBytes('\n')
		if msg := bytes.TrimSpace(line); len(msg) > 0 {
			var m struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
			}
			json.Unmarshal(msg, &m)
			cp := append([]byte(nil), msg...)
			if m.Method == "initialize" {
				// Later requests send the negotiated protocol version.
				b.handle(ctx, cp, m.ID, true)
			} else {
				b.wg.Add(1)
				go func() {
					defer b.wg.Done()
					b.handle(ctx, cp, m.ID, false)
				}()
			}
		}
		if err != nil {
			b.wg.Wait()
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func (b *Bridge) handle(ctx context.Context, msg []byte, id json.RawMessage, initialize bool) {
	req, err := http.NewRequestWithContext(ctx, "POST", b.URL, bytes.NewReader(msg))
	if err != nil {
		b.fail(id, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+b.Token)
	b.mu.Lock()
	if b.protocol != "" {
		req.Header.Set("Mcp-Protocol-Version", b.protocol)
	}
	if b.session != "" {
		req.Header.Set("Mcp-Session-Id", b.session)
	}
	b.mu.Unlock()
	resp, err := b.Client.Do(req)
	if err != nil {
		b.fail(id, "cannot reach the syslog server: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if sid := resp.Header.Get("Mcp-Session-Id"); sid != "" {
		b.mu.Lock()
		b.session = sid
		b.mu.Unlock()
	}
	if resp.StatusCode == http.StatusAccepted || resp.StatusCode == http.StatusNoContent {
		return
	}
	ct, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if resp.StatusCode >= 300 && ct != "text/event-stream" {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		var e struct {
			Error any `json:"error"`
		}
		// A JSON-RPC error from the MCP server is passed on as is.
		if json.Unmarshal(body, &e) == nil {
			if _, ok := e.Error.(map[string]any); ok {
				b.write(body)
				return
			}
			if s, ok := e.Error.(string); ok && s != "" {
				b.fail(id, fmt.Sprintf("syslog server: %s (HTTP %d)", s, resp.StatusCode))
				return
			}
		}
		b.fail(id, fmt.Sprintf("syslog server answered HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body))))
		return
	}
	if ct == "text/event-stream" {
		b.readEvents(resp.Body, initialize)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		b.fail(id, err.Error())
		return
	}
	if initialize {
		b.learnProtocol(body)
	}
	b.write(body)
}

// readEvents passes on the data of every server-sent event.
func (b *Bridge) readEvents(r io.Reader, initialize bool) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<16), 64<<20)
	var data []byte
	flush := func() {
		if len(bytes.TrimSpace(data)) > 0 {
			if initialize {
				b.learnProtocol(data)
			}
			b.write(data)
		}
		data = nil
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "data:"):
			if len(data) > 0 {
				data = append(data, '\n')
			}
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " ")...)
		}
	}
	flush()
}

func (b *Bridge) learnProtocol(body []byte) {
	var m struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"result"`
	}
	if json.Unmarshal(body, &m) == nil && m.Result.ProtocolVersion != "" {
		b.mu.Lock()
		b.protocol = m.Result.ProtocolVersion
		b.mu.Unlock()
	}
}

// write sends one message to stdout on a single line.
func (b *Bridge) write(msg []byte) {
	var buf bytes.Buffer
	if err := json.Compact(&buf, bytes.TrimSpace(msg)); err != nil {
		if b.Log != nil {
			fmt.Fprintf(b.Log, "unify-syslog-mcp: invalid answer from the server: %v\n", err)
		}
		return
	}
	buf.WriteByte('\n')
	b.outMu.Lock()
	b.Out.Write(buf.Bytes())
	b.outMu.Unlock()
}

// fail answers a request with a JSON-RPC error; notifications get none.
func (b *Bridge) fail(id json.RawMessage, msg string) {
	if b.Log != nil {
		fmt.Fprintln(b.Log, "unify-syslog-mcp:", msg)
	}
	if len(id) == 0 || string(id) == "null" {
		return
	}
	out, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32603, "message": msg}})
	b.write(out)
}
