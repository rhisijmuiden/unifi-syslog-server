package api

import (
	"context"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/rhisijmuiden/unify-syslog-server/internal/query"
	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

// ---------------------------------------------------------------- global search

// Results per type; the total says how many more matched.
const globalLimit = 8

type globalItem struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Subtitle string `json:"subtitle,omitempty"`
	// Badge is a short status word such as "disabled" or "offline".
	Badge string `json:"badge,omitempty"`
	// Link is the UI path that opens the item.
	Link  string `json:"link"`
	score int
}

type globalGroup struct {
	Type  string       `json:"type"`
	Total int          `json:"total"`
	Items []globalItem `json:"items"`
}

// globalMatcher matches items whose text contains every word of the query.
type globalMatcher struct {
	q     string
	words []string
}

func newGlobalMatcher(q string) globalMatcher {
	q = strings.ToLower(strings.TrimSpace(q))
	return globalMatcher{q: q, words: strings.Fields(q)}
}

// score is 0 when the item does not match, higher for better matches of
// the title.
func (m globalMatcher) score(title string, other ...string) int {
	if len(m.words) == 0 {
		return 0
	}
	t := strings.ToLower(title)
	hay := t + "\n" + strings.ToLower(strings.Join(other, "\n"))
	for _, w := range m.words {
		if !strings.Contains(hay, w) {
			return 0
		}
	}
	switch {
	case t == m.q:
		return 4
	case strings.HasPrefix(t, m.q):
		return 3
	case strings.Contains(t, m.q):
		return 2
	}
	return 1
}

type globalCollector struct {
	m      globalMatcher
	groups map[string]*globalGroup
	order  []string
}

func (c *globalCollector) add(typ string, it globalItem, title string, other ...string) {
	it.score = c.m.score(title, other...)
	if it.score == 0 {
		return
	}
	if it.Title == "" {
		it.Title = title
	}
	g := c.groups[typ]
	if g == nil {
		g = &globalGroup{Type: typ}
		c.groups[typ] = g
		c.order = append(c.order, typ)
	}
	g.Total++
	g.Items = append(g.Items, it)
}

func (c *globalCollector) result() []globalGroup {
	out := make([]globalGroup, 0, len(c.order))
	for _, typ := range c.order {
		g := c.groups[typ]
		sort.SliceStable(g.Items, func(i, j int) bool {
			if g.Items[i].score != g.Items[j].score {
				return g.Items[i].score > g.Items[j].score
			}
			return strings.ToLower(g.Items[i].Title) < strings.ToLower(g.Items[j].Title)
		})
		if len(g.Items) > globalLimit {
			g.Items = g.Items[:globalLimit]
		}
		out = append(out, *g)
	}
	return out
}

func siteName(s string) string {
	if s == "" {
		return store.DefaultSite
	}
	return s
}

func editLink(page string, id int64) string {
	return page + "?edit=" + strconv.FormatInt(id, 10)
}

func savedSearchLink(x store.SavedSearch) string {
	q := url.Values{}
	if x.Query != "" {
		q.Set("q", x.Query)
	}
	if x.Preset != "" {
		q.Set("preset", x.Preset)
	}
	if x.Preset == "custom" {
		q.Set("from", x.From)
		q.Set("to", x.To)
	}
	if x.Site != "" {
		q.Set("site", x.Site)
	}
	if len(q) == 0 {
		return "/logs"
	}
	return "/logs?" + q.Encode()
}

// globalSearch searches everything a user may see in the configuration
// database: devices, clients, sites, categories and saved searches, and for
// administrators also alerts, channels, probes, forwarding, controllers and
// users. Logs are searched separately by globalSearchLogs, since that can
// take a while.
func (s *Server) globalSearch(w http.ResponseWriter, r *http.Request) {
	u := user(r)
	c := &globalCollector{m: newGlobalMatcher(r.URL.Query().Get("q")), groups: map[string]*globalGroup{}}
	if len(c.m.words) == 0 {
		jsonOut(w, map[string]any{"groups": []globalGroup{}})
		return
	}

	for _, d := range s.Meta.Devices() {
		if !u.SiteAllowed(d.Site) {
			continue
		}
		key := first(d.MAC, d.Hostname, d.SourceIP)
		host := d.Hostname
		if d.Name == "" {
			host = "" // already the title
		}
		c.add("device", globalItem{
			ID:       d.Key,
			Subtitle: strings.Join(nonEmpty(host, d.Model, d.MAC, d.SourceIP, siteName(d.Site)), " · "),
			Link:     "/devices?" + url.Values{"q": {key}}.Encode(),
		}, first(d.Name, d.Hostname, d.MAC, d.SourceIP), d.Hostname, d.Model, d.MAC, d.SourceIP, d.Version, d.Notes, d.Site)
	}

	if s.Enrich != nil {
		for _, cl := range s.Enrich.Clients() {
			if !u.SiteAllowed(cl.Site) {
				continue
			}
			c.add("client", globalItem{
				ID:       cl.MAC,
				Subtitle: strings.Join(nonEmpty(cl.Hostname, cl.MAC, cl.IP, siteName(cl.Site)), " · "),
				Link:     "/clients?" + url.Values{"q": {cl.MAC}}.Encode(),
			}, first(cl.Name, cl.Hostname, cl.MAC), cl.Hostname, cl.MAC, cl.IP, cl.Site)
		}
	}

	for _, site := range s.Meta.Sites() {
		if !u.SiteAllowed(site) {
			continue
		}
		c.add("site", globalItem{ID: site, Link: "/?" + url.Values{"site": {site}}.Encode()}, site)
	}

	if cats, err := s.Meta.Categories(); err == nil {
		for _, x := range cats {
			c.add("category", globalItem{
				ID:       strconv.FormatInt(x.ID, 10),
				Subtitle: first(x.Description, x.Query),
				Link:     "/logs?" + url.Values{"q": {x.Query}, "preset": {"24h"}}.Encode(),
			}, x.Name, x.Description, x.Query)
		}
	}

	if list, err := s.Meta.SavedSearches(u.ID); err == nil {
		for _, x := range list {
			sub := x.Query
			if x.Shared && x.OwnerID != u.ID {
				sub = strings.Join(nonEmpty(x.Query, x.Owner), " · ")
			}
			c.add("saved_search", globalItem{ID: strconv.FormatInt(x.ID, 10), Subtitle: sub, Link: savedSearchLink(x)},
				x.Name, x.Description, x.Query, x.Owner)
		}
	}

	if u.IsAdmin() {
		s.globalAdmin(c)
	}
	jsonOut(w, map[string]any{"groups": c.result()})
}

// globalAdmin adds what only administrators may see. Secrets are never
// searched.
func (s *Server) globalAdmin(c *globalCollector) {
	disabled := func(enabled bool) string {
		if enabled {
			return ""
		}
		return "disabled"
	}
	if list, err := s.Meta.AlertRules(); err == nil {
		for _, x := range list {
			c.add("alert", globalItem{ID: strconv.FormatInt(x.ID, 10), Subtitle: x.Query, Badge: disabled(x.Enabled), Link: editLink("/alerts", x.ID)},
				x.Name, x.Query, x.Recipients, x.Severity)
		}
	}
	if list, err := s.Meta.NotifyChannels(); err == nil {
		for _, x := range list {
			c.add("channel", globalItem{ID: strconv.FormatInt(x.ID, 10), Subtitle: x.Kind, Badge: disabled(x.Enabled), Link: editLink("/notifications", x.ID)},
				x.Name, x.Kind)
		}
	}
	if list, err := s.Meta.Probes(); err == nil {
		for _, x := range list {
			badge := ""
			switch {
			case !x.Enrolled:
				badge = "not enrolled"
			case s.Probes != nil && !s.Probes.Online(x):
				badge = "offline"
			}
			c.add("probe", globalItem{
				ID:       strconv.FormatInt(x.ID, 10),
				Subtitle: strings.Join(nonEmpty(x.Hostname, x.RemoteIP, siteName(x.Site), x.Version), " · "),
				Badge:    badge,
				Link:     editLink("/probes", x.ID),
			}, x.Name, x.Hostname, x.RemoteIP, x.Site, x.Version)
		}
	}
	if list, err := s.Meta.ForwardDestinations(); err == nil {
		for _, x := range list {
			c.add("forward", globalItem{ID: strconv.FormatInt(x.ID, 10), Subtitle: x.Kind, Badge: disabled(x.Enabled), Link: editLink("/forwarding", x.ID)},
				x.Name, x.Kind)
		}
	}
	if list, err := s.Meta.Controllers(); err == nil {
		for _, x := range list {
			c.add("controller", globalItem{ID: strconv.FormatInt(x.ID, 10), Subtitle: x.URL, Badge: disabled(x.Enabled), Link: editLink("/controllers", x.ID)},
				x.Name, x.URL, x.Site)
		}
	}
	if list, err := s.Meta.Users(); err == nil {
		for _, x := range list {
			badge := ""
			if x.Disabled {
				badge = "disabled"
			}
			c.add("user", globalItem{
				ID:       strconv.FormatInt(x.ID, 10),
				Subtitle: strings.Join(nonEmpty(x.Username, x.Email, x.Role), " · "),
				Badge:    badge,
				Link:     editLink("/users", x.ID),
			}, first(x.Name, x.Username), x.Username, x.Email, x.Role)
		}
	}
}

// globalLogQuery turns search text into a log query: text that is valid
// query language is used as is, anything else as a phrase.
func globalLogQuery(q string) string {
	q = strings.TrimSpace(q)
	if _, err := query.Compile(q); err == nil {
		return q
	}
	return `"` + strings.ReplaceAll(q, `"`, "") + `"`
}

// globalSearchLogs counts the log messages that match and returns the
// newest few.
func (s *Server) globalSearchLogs(w http.ResponseWriter, r *http.Request) {
	req := reqFromQuery(r)
	req.Query = globalLogQuery(r.URL.Query().Get("q"))
	out := map[string]any{"query": req.Query, "count": 0, "rows": []store.Row{}}
	if req.Query == "" || s.Logs == nil {
		jsonOut(w, out)
		return
	}
	s.auditView(r, "logs_viewed", searchDetail(req.Query, req.Sites))
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	req.Limit = 5
	rows, err := s.Logs.Search(ctx, req)
	if err != nil {
		out["error"] = err.Error()
		jsonOut(w, out)
		return
	}
	out["rows"] = rows
	if n, err := s.Logs.Count(ctx, req); err == nil {
		out["count"] = n
	} else {
		out["count"] = len(rows)
		out["error"] = err.Error()
	}
	jsonOut(w, out)
}

func nonEmpty(v ...string) []string {
	out := v[:0:0]
	for _, s := range v {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
