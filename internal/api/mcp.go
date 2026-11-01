package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/rhisijmuiden/unify-syslog-server/internal/query"
	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
	"github.com/rhisijmuiden/unify-syslog-server/internal/unifi"
	"github.com/rhisijmuiden/unify-syslog-server/internal/version"
)

// The MCP endpoint lets AI assistants (Claude, ChatGPT, Copilot, Cursor …)
// search the logs with the Model Context Protocol. It speaks Streamable
// HTTP at /mcp and needs an API token. Every tool calls the REST API
// internally with that token, so roles, sites, read-only tokens and the
// audit log work exactly as for scripts.

const mcpClientHeader = "X-Uss-Mcp-Client"

var mcpSchemas = mcp.NewSchemaCache()

// mcpHandler serves /mcp.
func (s *Server) mcpHandler() http.Handler {
	h := mcp.NewStreamableHTTPHandler(s.mcpServerFor, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
		// Every request needs an API token, which a browser cannot add
		// to a rebinding attack, and the server often runs behind a
		// reverse proxy on the same host.
		DisableLocalhostProtection: true,
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.Meta.MCP().Enabled {
			jerr(w, 404, "the MCP server is turned off (Administration → AI assistants)")
			return
		}
		tok := bearer(r)
		if tok == "" {
			w.Header().Set("WWW-Authenticate", `Bearer realm="unify-syslog"`)
			jerr(w, 401, "an API token is required (Authorization: Bearer uss_…)")
			return
		}
		t, u, err := s.Meta.TokenUser(tok)
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="unify-syslog", error="invalid_token"`)
			jerr(w, 401, "invalid or expired API token")
			return
		}
		s.Meta.TouchToken(t, clientIP(r))
		r.Header.Set(mcpClientHeader, clientIP(r))
		r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
		h.ServeHTTP(w, r.WithContext(context.WithValue(context.WithValue(r.Context(), userKey, u), tokenKey, t)))
	})
}

// mcpServerFor builds the MCP server for one request, with the tools the
// token's user may use.
func (s *Server) mcpServerFor(r *http.Request) *mcp.Server {
	srv := mcp.NewServer(&mcp.Implementation{Name: "unifi-syslog-server", Title: "UniFi Syslog Server", Version: version.Version},
		&mcp.ServerOptions{Instructions: mcpInstructions, SchemaCache: mcpSchemas})
	admin := false
	if u := user(r); u != nil {
		admin = u.IsAdmin()
	}
	for _, t := range s.mcpTools() {
		if t.admin && !admin {
			continue
		}
		t.add(srv)
	}
	return srv
}

const mcpInstructions = `UniFi Syslog Server collects syslog from UniFi gateways, switches, access points, Protect and Access, parses it into fields (category, action, rule, src/dst IP and port, client, SSID, GeoIP …) and stores it in ClickHouse.

Tips:
- Call query_language first if you are not sure how to write a query. Queries look like: category:firewall action:block dport:22 -src:10.0.0.0/8
- Narrow the time range with "last" (15m, 1h, 24h, 7d, 30d) or from/to (RFC 3339). Without it the last 24 hours are used.
- Use count_logs and top_values to summarise large result sets instead of reading many rows with search_logs.
- Results only contain the sites the API token's user may see.`

// ---------------------------------------------------------------- tools

type mcpTool struct {
	tool  *mcp.Tool
	admin bool
	add   func(*mcp.Server)
}

// mcpCall is the context of one tool call.
type mcpCall struct {
	s      *Server
	header http.Header
}

// api calls the REST API with the caller's token and decodes the JSON
// answer into out.
func (c *mcpCall) api(ctx context.Context, method, path string, body, out any) error {
	var rd *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	// A fresh chi routing context: the one of the /mcp request would
	// make the router skip routing.
	req, err := http.NewRequestWithContext(context.WithValue(ctx, chi.RouteCtxKey, nil), method, path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", c.header.Get("Authorization"))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = c.header.Get(mcpClientHeader) + ":0"
	w := &bufferedResponse{header: http.Header{}, code: 200}
	c.s.apiRouter.ServeHTTP(w, req)
	if w.code >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(w.body.Bytes(), &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("%s %s: HTTP %d", method, path, w.code)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(w.body.Bytes(), out)
}

type bufferedResponse struct {
	header http.Header
	body   bytes.Buffer
	code   int
	wrote  bool
}

func (b *bufferedResponse) Header() http.Header { return b.header }
func (b *bufferedResponse) Write(p []byte) (int, error) {
	b.wrote = true
	return b.body.Write(p)
}
func (b *bufferedResponse) WriteHeader(code int) {
	if !b.wrote {
		b.code, b.wrote = code, true
	}
}

// addMCPTool registers a read-only tool whose result is returned as JSON.
func addMCPTool[In any](s *Server, list *[]mcpTool, admin bool, t *mcp.Tool, fn func(context.Context, *mcpCall, In) (any, error)) {
	t.Annotations = &mcp.ToolAnnotations{ReadOnlyHint: true, IdempotentHint: true, OpenWorldHint: new(bool)}
	*list = append(*list, mcpTool{tool: t, admin: admin, add: func(srv *mcp.Server) {
		mcp.AddTool(srv, t, func(ctx context.Context, req *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
			c := &mcpCall{s: s, header: http.Header{}}
			if req.Extra != nil && req.Extra.Header != nil {
				c.header = req.Extra.Header
			}
			ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
			defer cancel()
			v, err := fn(ctx, c, in)
			if err != nil {
				return nil, nil, err
			}
			b, err := json.Marshal(v)
			if err != nil {
				return nil, nil, err
			}
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: string(b)}}}, nil, nil
		})
	}})
}

// mcpRange is the time range and site filter most tools take.
type mcpRange struct {
	Last  string   `json:"last,omitempty" jsonschema:"How far back to look: 15m, 1h, 6h, 24h, 7d, 30d … Ignored when from is set. Default 24h."`
	From  string   `json:"from,omitempty" jsonschema:"Start of the range, RFC 3339, e.g. 2026-10-31T08:00:00Z"`
	To    string   `json:"to,omitempty" jsonschema:"End of the range, RFC 3339. Default now."`
	Sites []string `json:"sites,omitempty" jsonschema:"Only these sites (see list_sites). Default all sites the user may see."`
}

func (m mcpRange) resolve() (from, to time.Time, err error) {
	to = time.Now()
	if m.To != "" {
		if to, err = parseMCPTime(m.To); err != nil {
			return
		}
	}
	if m.From != "" {
		from, err = parseMCPTime(m.From)
		return
	}
	d := 24 * time.Hour
	if m.Last != "" {
		if d, err = parseMCPDuration(m.Last); err != nil {
			return
		}
	}
	from = to.Add(-d)
	return
}

func (m mcpRange) req(q string) (store.SearchReq, error) {
	from, to, err := m.resolve()
	if err != nil {
		return store.SearchReq{}, err
	}
	if !from.Before(to) {
		return store.SearchReq{}, errors.New("from must be before to")
	}
	return store.SearchReq{Query: q, From: from, To: to, Sites: m.Sites}, nil
}

func (m mcpRange) values() (url.Values, error) {
	from, to, err := m.resolve()
	if err != nil {
		return nil, err
	}
	v := url.Values{"from": {from.UTC().Format(time.RFC3339)}, "to": {to.UTC().Format(time.RFC3339)}}
	if len(m.Sites) > 0 {
		v.Set("sites", strings.Join(m.Sites, ","))
	}
	return v, nil
}

func parseMCPTime(s string) (time.Time, error) {
	for _, l := range []string{time.RFC3339, "2006-01-02T15:04", "2006-01-02 15:04", "2006-01-02"} {
		if t, err := time.ParseInLocation(l, strings.TrimSpace(s), time.Local); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid time %q (use RFC 3339, e.g. 2026-10-31T08:00:00Z)", s)
}

func parseMCPDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	mult := time.Duration(0)
	switch {
	case strings.HasSuffix(s, "d"):
		mult = 24 * time.Hour
	case strings.HasSuffix(s, "w"):
		mult = 7 * 24 * time.Hour
	}
	var d time.Duration
	if mult != 0 {
		n, err := strconv.ParseFloat(s[:len(s)-1], 64)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("invalid duration %q (use e.g. 15m, 1h, 7d)", s)
		}
		d = time.Duration(n * float64(mult))
	} else {
		var err error
		if d, err = time.ParseDuration(s); err != nil || d <= 0 {
			return 0, fmt.Errorf("invalid duration %q (use e.g. 15m, 1h, 7d)", s)
		}
	}
	if d > 3650*24*time.Hour {
		return 0, errors.New("the range can be at most ten years")
	}
	return d, nil
}

// compactRow drops empty and internal fields from a log row, so a model
// reads fewer tokens.
func compactRow(r store.Row, raw bool) map[string]any {
	out := map[string]any{"ts": r.TS.UTC().Format(time.RFC3339Nano), "severity": severityName(r.Severity)}
	str := map[string]string{
		"site": r.Site, "hostname": r.Hostname, "source_ip": r.SourceIP, "device_model": r.DeviceModel, "device_mac": r.DeviceMAC,
		"app": r.App, "category": r.Category, "event": r.EventType, "action": r.Action, "rule": r.Rule,
		"src_ip": r.SrcIP, "dst_ip": r.DstIP, "proto": r.Proto, "in": r.InIf, "out": r.OutIf,
		"client_mac": r.ClientMAC, "client_name": r.ClientName, "client_ip": r.ClientIP, "ssid": r.SSID,
		"message": truncate(r.Message, 2000),
	}
	for k, v := range str {
		if v != "" {
			out[k] = v
		}
	}
	if r.SrcPort != 0 {
		out["src_port"] = r.SrcPort
	}
	if r.DstPort != 0 {
		out["dst_port"] = r.DstPort
	}
	if len(r.Fields) > 0 {
		out["fields"] = r.Fields
	}
	if raw && r.Raw != "" {
		out["raw"] = truncate(r.Raw, 4000)
	}
	return out
}

var severityNames = []string{"emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"}

func severityName(s uint8) string {
	if int(s) < len(severityNames) {
		return severityNames[s]
	}
	return strconv.Itoa(int(s))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// filterJSON keeps the items of a JSON list that belong to site and
// contain every word of text, up to limit.
func filterJSON(items []map[string]any, site, text string, limit int) map[string]any {
	words := strings.Fields(strings.ToLower(text))
	out := []map[string]any{}
	total := 0
	for _, it := range items {
		if site != "" {
			if v, _ := it["site"].(string); !strings.EqualFold(v, site) {
				continue
			}
		}
		if len(words) > 0 {
			b, _ := json.Marshal(it)
			hay := strings.ToLower(string(b))
			ok := true
			for _, w := range words {
				if !strings.Contains(hay, w) {
					ok = false
					break
				}
			}
			if !ok {
				continue
			}
		}
		total++
		if len(out) < limit {
			out = append(out, it)
		}
	}
	return map[string]any{"total": total, "returned": len(out), "items": out}
}

func clampLimit(n, def, max int) int {
	if n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// ---------------------------------------------------------------- inputs

type mcpSearchIn struct {
	Query string `json:"query,omitempty" jsonschema:"Query in the query language (see query_language), e.g. category:firewall action:block dport:22. Empty matches everything."`
	mcpRange
	Limit       int    `json:"limit,omitempty" jsonschema:"Maximum rows, 1-200. Default 50."`
	OldestFirst bool   `json:"oldest_first,omitempty" jsonschema:"Return the oldest rows first instead of the newest."`
	Before      string `json:"before,omitempty" jsonschema:"Paging: only rows older than this ts (the ts of the last row of the previous page)."`
	IncludeRaw  bool   `json:"include_raw,omitempty" jsonschema:"Also return the raw syslog line of every row."`
}

type mcpCountIn struct {
	Query string `json:"query,omitempty" jsonschema:"Query in the query language. Empty counts everything."`
	mcpRange
	GroupBy string `json:"group_by,omitempty" jsonschema:"Also count per value of: category, severity, site, action, hostname, app or event_type."`
}

type mcpTopIn struct {
	Field string `json:"field" jsonschema:"Field to rank: src_ip, dst_ip, dst_port, rule, action, category, site, hostname, app, event_type, proto, severity, client_mac, client_name, client_ip, ssid, device_model, device_name, in_if, out_if, src_country, dst_country, src_as, dst_as, src_name, dst_name, classification, camera, door, user."`
	Query string `json:"query,omitempty" jsonschema:"Only messages matching this query, e.g. category:firewall action:block."`
	mcpRange
	N int `json:"n,omitempty" jsonschema:"Number of values, 1-100. Default 10."`
}

type mcpEverythingIn struct {
	Q string `json:"q" jsonschema:"Words to look for: a device or client name, MAC, IP address, site, rule … or a query in the query language."`
	mcpRange
}

type mcpDevicesIn struct {
	Site   string `json:"site,omitempty" jsonschema:"Only devices of this site."`
	Status string `json:"status,omitempty" jsonschema:"Only devices with this status: active, silent or inactive."`
	Filter string `json:"filter,omitempty" jsonschema:"Only devices whose name, model, MAC, IP or notes contain every word."`
	Days   int    `json:"days,omitempty" jsonschema:"Count messages over this many days. Default 7."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum devices, 1-500. Default 100."`
}

type mcpClientsIn struct {
	Site   string `json:"site,omitempty" jsonschema:"Only clients of this site."`
	Filter string `json:"filter,omitempty" jsonschema:"Only clients whose name, hostname, MAC or IP contain every word."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum clients, 1-500. Default 100."`
}

type mcpNone struct{}

// ---------------------------------------------------------------- tool list

func (s *Server) mcpTools() []mcpTool {
	var l []mcpTool

	addMCPTool(s, &l, false, &mcp.Tool{Name: "search_logs", Title: "Search logs",
		Description: "Search the syslog messages and return matching rows, newest first. Rows have ts, site, hostname, category, severity, action, rule, src_ip/dst_ip/ports, client and message. Use count_logs or top_values to summarise instead of reading many rows."},
		func(ctx context.Context, c *mcpCall, in mcpSearchIn) (any, error) {
			req, err := in.req(in.Query)
			if err != nil {
				return nil, err
			}
			req.Limit = clampLimit(in.Limit, 50, 200)
			req.Asc = in.OldestFirst
			if in.Before != "" {
				if req.Before, err = parseMCPTime(in.Before); err != nil {
					return nil, err
				}
			}
			var res struct {
				Rows   []store.Row `json:"rows"`
				TookMS int64       `json:"took_ms"`
			}
			if err := c.api(ctx, "POST", "/api/search", req, &res); err != nil {
				return nil, err
			}
			rows := make([]map[string]any, len(res.Rows))
			for i, r := range res.Rows {
				rows[i] = compactRow(r, in.IncludeRaw)
			}
			out := map[string]any{"query": req.Query, "from": req.From.UTC().Format(time.RFC3339), "to": req.To.UTC().Format(time.RFC3339), "returned": len(rows), "rows": rows}
			if len(rows) == req.Limit && len(res.Rows) > 0 {
				out["next_before"] = res.Rows[len(res.Rows)-1].TS.UTC().Format(time.RFC3339Nano)
			}
			return out, nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "count_logs", Title: "Count logs",
		Description: "Count the messages matching a query, over time (about 120 buckets for the range) and optionally per value of a field. Good for questions like 'how many', 'when did it start' and 'is it getting worse'."},
		func(ctx context.Context, c *mcpCall, in mcpCountIn) (any, error) {
			req, err := in.req(in.Query)
			if err != nil {
				return nil, err
			}
			body := searchBody{SearchReq: req, GroupBy: in.GroupBy}
			var res struct {
				Buckets []store.Bucket `json:"buckets"`
				Step    int            `json:"step"`
				Total   uint64         `json:"total"`
			}
			if err := c.api(ctx, "POST", "/api/search/histogram", body, &res); err != nil {
				return nil, err
			}
			type point struct {
				T     string `json:"t"`
				Count uint64 `json:"count"`
			}
			per := map[time.Time]uint64{}
			byKey := map[string]uint64{}
			for _, b := range res.Buckets {
				per[b.T] += b.Count
				if in.GroupBy != "" {
					byKey[b.Key] += b.Count
				}
			}
			times := make([]time.Time, 0, len(per))
			for t := range per {
				times = append(times, t)
			}
			sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
			pts := make([]point, len(times))
			for i, t := range times {
				pts[i] = point{t.UTC().Format(time.RFC3339), per[t]}
			}
			out := map[string]any{"query": req.Query, "from": req.From.UTC().Format(time.RFC3339), "to": req.To.UTC().Format(time.RFC3339),
				"total": res.Total, "bucket_seconds": res.Step, "buckets": pts}
			if in.GroupBy != "" {
				out["by_"+in.GroupBy] = byKey
			}
			return out, nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "top_values", Title: "Top values",
		Description: "The most frequent values of a field among matching messages, with counts. For example the top blocked source IPs (field src_ip, query category:firewall action:block) or the busiest SSIDs."},
		func(ctx context.Context, c *mcpCall, in mcpTopIn) (any, error) {
			req, err := in.req(in.Query)
			if err != nil {
				return nil, err
			}
			body := searchBody{SearchReq: req, Field: in.Field, N: clampLimit(in.N, 10, 100)}
			var items []store.TopItem
			if err := c.api(ctx, "POST", "/api/search/top", body, &items); err != nil {
				return nil, err
			}
			return map[string]any{"field": in.Field, "query": req.Query, "from": req.From.UTC().Format(time.RFC3339), "to": req.To.UTC().Format(time.RFC3339), "values": items}, nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "search_everything", Title: "Search everything",
		Description: "Search the whole application at once: devices, clients, sites, categories and saved searches (for administrators also alert rules, channels, probes, forwarding, controllers and users), plus how many log messages match and the newest five."},
		func(ctx context.Context, c *mcpCall, in mcpEverythingIn) (any, error) {
			var groups, logs map[string]any
			if err := c.api(ctx, "GET", "/api/global-search?"+url.Values{"q": {in.Q}}.Encode(), nil, &groups); err != nil {
				return nil, err
			}
			v, err := in.values()
			if err != nil {
				return nil, err
			}
			v.Set("q", in.Q)
			var lg struct {
				Query string      `json:"query"`
				Count uint64      `json:"count"`
				Rows  []store.Row `json:"rows"`
				Error string      `json:"error"`
			}
			if err := c.api(ctx, "GET", "/api/global-search/logs?"+v.Encode(), nil, &lg); err != nil {
				return nil, err
			}
			rows := make([]map[string]any, len(lg.Rows))
			for i, r := range lg.Rows {
				rows[i] = compactRow(r, false)
			}
			logs = map[string]any{"query": lg.Query, "count": lg.Count, "newest": rows}
			if lg.Error != "" {
				logs["error"] = lg.Error
			}
			return map[string]any{"matches": groups["groups"], "logs": logs}, nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "get_overview", Title: "Overview",
		Description: "The overview dashboard for a time range: message totals per category and severity, and top lists (blocked sources and ports, firewall and IPS rules, Wi-Fi clients, SSIDs, senders, DHCP clients, countries)."},
		func(ctx context.Context, c *mcpCall, in mcpRange) (any, error) {
			v, err := in.values()
			if err != nil {
				return nil, err
			}
			var out map[string]any
			err = c.api(ctx, "GET", "/api/dashboard?"+v.Encode(), nil, &out)
			return out, err
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "list_sites", Title: "List sites",
		Description: "Every site (location) with its devices, senders and message counts of the last 24 hours."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var out any
			err := c.api(ctx, "GET", "/api/sites/overview", nil, &out)
			return out, err
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "list_devices", Title: "List devices",
		Description: "The UniFi device inventory (gateways, switches, access points …) with status (active, silent, inactive), last seen, firmware and message and error counts."},
		func(ctx context.Context, c *mcpCall, in mcpDevicesIn) (any, error) {
			days := in.Days
			if days <= 0 {
				days = 7
			}
			var items []map[string]any
			if err := c.api(ctx, "GET", "/api/devices?days="+strconv.Itoa(days), nil, &items); err != nil {
				return nil, err
			}
			if in.Status != "" {
				kept := items[:0]
				for _, d := range items {
					if st, _ := d["status"].(string); strings.EqualFold(st, in.Status) {
						kept = append(kept, d)
					}
				}
				items = kept
			}
			return filterJSON(items, in.Site, in.Filter, clampLimit(in.Limit, 100, 500)), nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "list_clients", Title: "List clients",
		Description: "Known network clients (phones, laptops, IoT …) with name, hostname, MAC, IP address and site, from DHCP logs and UniFi controllers."},
		func(ctx context.Context, c *mcpCall, in mcpClientsIn) (any, error) {
			var items []map[string]any
			if err := c.api(ctx, "GET", "/api/clients", nil, &items); err != nil {
				return nil, err
			}
			return filterJSON(items, in.Site, in.Filter, clampLimit(in.Limit, 100, 500)), nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "get_firmware_status", Title: "Firmware status",
		Description: "Firmware versions per device model and the devices that run outdated firmware."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var out any
			err := c.api(ctx, "GET", "/api/firmware", nil, &out)
			return out, err
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "list_categories", Title: "List categories",
		Description: "The categories (named queries such as Firewall blocks or Wi-Fi) with their query and the number of messages in the time range."},
		func(ctx context.Context, c *mcpCall, in mcpRange) (any, error) {
			var cats []store.Category
			if err := c.api(ctx, "GET", "/api/categories", nil, &cats); err != nil {
				return nil, err
			}
			v, err := in.values()
			if err != nil {
				return nil, err
			}
			var stats []struct {
				ID    int64  `json:"id"`
				Count uint64 `json:"count"`
			}
			c.api(ctx, "GET", "/api/categories/stats?"+v.Encode(), nil, &stats)
			counts := map[int64]uint64{}
			for _, st := range stats {
				counts[st.ID] = st.Count
			}
			out := make([]map[string]any, len(cats))
			for i, x := range cats {
				out[i] = map[string]any{"name": x.Name, "description": x.Description, "query": x.Query, "count": counts[x.ID]}
			}
			return out, nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "list_saved_searches", Title: "List saved searches",
		Description: "Saved searches: your own and the shared ones, with name, description, query and time range. Run one with search_logs or count_logs using its query."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var out any
			err := c.api(ctx, "GET", "/api/saved-searches", nil, &out)
			return out, err
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "get_probe_status", Title: "Probe status",
		Description: "Remote probes (on-site syslog collectors): name, site, online, version and buffered messages."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var out any
			err := c.api(ctx, "GET", "/api/probes/summary", nil, &out)
			return out, err
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "query_language", Title: "Query language",
		Description: "How to write queries for search_logs, count_logs and top_values, with examples and every field name."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			f := query.Fields()
			sort.Strings(f)
			return map[string]any{"syntax": queryHelp, "fields": f, "categories": unifi.AllCategories}, nil
		})

	addMCPTool(s, &l, false, &mcp.Tool{Name: "server_info", Title: "Server info",
		Description: "Version, uptime and storage of the server, and the role and sites of the user the API token belongs to."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var info, me any
			if err := c.api(ctx, "GET", "/api/info", nil, &info); err != nil {
				return nil, err
			}
			c.api(ctx, "GET", "/api/me", nil, &me)
			return map[string]any{"server": info, "user": me}, nil
		})

	addMCPTool(s, &l, true, &mcp.Tool{Name: "list_alert_rules", Title: "List alert rules",
		Description: "Alert rules with their query, condition, threshold, window, channels and when they last fired. Administrators only."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var out any
			err := c.api(ctx, "GET", "/api/alerts", nil, &out)
			return out, err
		})

	addMCPTool(s, &l, true, &mcp.Tool{Name: "get_system_status", Title: "System status",
		Description: "Health of the server: current issues, messages per second, dropped and rejected messages, disks, ClickHouse, and the state of probes, forwarding, notifications and backups. Administrators only."},
		func(ctx context.Context, c *mcpCall, _ mcpNone) (any, error) {
			var out map[string]any
			if err := c.api(ctx, "GET", "/api/system/status", nil, &out); err != nil {
				return nil, err
			}
			// The per-10-second rate series is long and rarely useful to a model.
			if in, ok := out["ingest"].(map[string]any); ok {
				delete(in, "series")
			}
			return out, nil
		})

	return l
}

const queryHelp = `Words are AND-ed. field:value matches a field; a bare word or "a phrase" searches the message.
- OR between terms: dport:22 OR dport:3389. Parentheses group: -(category:firewall action:allow)
- A leading - negates: -category:dns
- Wildcards: rule:"WAN_IN-D-*", client:aa:bb:*
- Networks: src:203.0.113.0/24. Ranges: dport:1..1024. Comparisons: severity:<=warning
- ip matches source or destination, port matches either port.
- Extra parser fields: field.<name>:value, e.g. field.signature_id:2210050
Examples:
  category:firewall action:block                 blocked traffic
  category:firewall action:block country:CN      blocked traffic to or from a country (GeoIP)
  category:ips                                   intrusion prevention alerts
  category:wifi client:aa:bb:cc:dd:ee:ff         one Wi-Fi client
  category:dhcp client_name:"iPhone*"            DHCP leases of iPhones
  severity:<=error                               errors and worse
  "authentication failure"                       an exact phrase
  category:protect event:person_detected         people detected by UniFi Protect`

// ---------------------------------------------------------------- settings

// mcpInfo tells the AI assistants page whether MCP is on, where the
// endpoint is and which tools the user gets.
func (s *Server) mcpInfo(w http.ResponseWriter, r *http.Request) {
	type tool struct {
		Name        string `json:"name"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Admin       bool   `json:"admin"`
	}
	tools := []tool{}
	admin := user(r).IsAdmin()
	for _, t := range s.mcpTools() {
		if t.admin && !admin {
			continue
		}
		tools = append(tools, tool{t.tool.Name, t.tool.Title, t.tool.Description, t.admin})
	}
	base := s.baseURL(r)
	// The web port serves HTTPS too, with a self-signed certificate unless
	// tls_cert is set; stdio clients then pin its key.
	https := strings.Replace(base, "http://", "https://", 1)
	jsonOut(w, map[string]any{
		"settings":    s.Meta.MCP(),
		"base_url":    https,
		"endpoint":    https + "/mcp",
		"self_signed": s.Cfg == nil || s.Cfg.TLSCert == "",
		"pin":         s.TLSPin,
		"version":     version.Version,
		"repo":        version.Repo,
		"tools":       tools,
	})
}

func (s *Server) putMCP(w http.ResponseWriter, r *http.Request) {
	var v store.MCPSettings
	if err := decode(r, &v); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if err := s.Meta.SetSetting("mcp", v); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	state := "off"
	if v.Enabled {
		state = "on"
	}
	s.audit_(r, "settings_mcp", "MCP server "+state)
	s.mcpInfo(w, r)
}
