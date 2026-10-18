package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/rhisijmuiden/unify-syslog-server/internal/backup"
	"github.com/rhisijmuiden/unify-syslog-server/internal/i18n"
	"github.com/rhisijmuiden/unify-syslog-server/internal/mail"
	"github.com/rhisijmuiden/unify-syslog-server/internal/query"
	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
	"github.com/rhisijmuiden/unify-syslog-server/internal/unifi"
	"github.com/rhisijmuiden/unify-syslog-server/internal/version"
)

// ---------------------------------------------------------------- search

type searchBody struct {
	store.SearchReq
	GroupBy string `json:"group_by"`
	Field   string `json:"field"`
	N       int    `json:"n"`
}

func (s *Server) parseSearch(w http.ResponseWriter, r *http.Request) (*searchBody, bool) {
	var b searchBody
	if err := decode(r, &b); err != nil {
		jerr(w, 400, "invalid request")
		return nil, false
	}
	normalizeRange(&b.SearchReq)
	if _, err := query.Compile(b.Query); err != nil {
		jerr(w, 400, err.Error())
		return nil, false
	}
	return &b, true
}

func normalizeRange(q *store.SearchReq) {
	if q.To.IsZero() {
		q.To = time.Now()
	}
	if q.From.IsZero() {
		q.From = q.To.Add(-24 * time.Hour)
	}
}

func (s *Server) search(w http.ResponseWriter, r *http.Request) {
	b, ok := s.parseSearch(w, r)
	if !ok {
		return
	}
	start := time.Now()
	rows, err := s.Logs.Search(r.Context(), b.SearchReq)
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	jsonOut(w, map[string]any{"rows": rows, "took_ms": time.Since(start).Milliseconds()})
}

func (s *Server) histogram(w http.ResponseWriter, r *http.Request) {
	b, ok := s.parseSearch(w, r)
	if !ok {
		return
	}
	buckets, step, err := s.Logs.Histogram(r.Context(), b.SearchReq, b.GroupBy)
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	var total uint64
	for _, x := range buckets {
		total += x.Count
	}
	jsonOut(w, map[string]any{"buckets": buckets, "step": step, "total": total})
}

func (s *Server) top(w http.ResponseWriter, r *http.Request) {
	b, ok := s.parseSearch(w, r)
	if !ok {
		return
	}
	items, err := s.Logs.Top(r.Context(), b.SearchReq, b.Field, b.N)
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	jsonOut(w, items)
}

func reqFromQuery(r *http.Request) store.SearchReq {
	q := r.URL.Query()
	req := store.SearchReq{Query: q.Get("query")}
	req.From, _ = time.Parse(time.RFC3339, q.Get("from"))
	req.To, _ = time.Parse(time.RFC3339, q.Get("to"))
	if s := q.Get("sites"); s != "" {
		req.Sites = strings.Split(s, ",")
	}
	normalizeRange(&req)
	return req
}

func (s *Server) export(w http.ResponseWriter, r *http.Request) {
	req := reqFromQuery(r)
	req.Limit = 5000
	format := r.URL.Query().Get("format")
	max := 100000
	name := "unify-syslog-" + time.Now().Format("20060102-150405")
	if format == "json" {
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.ndjson"`)
	} else {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.csv"`)
	}
	cw := csv.NewWriter(w)
	enc := json.NewEncoder(w)
	if format != "json" {
		cw.Write([]string{"time", "site", "host", "source_ip", "model", "severity", "app", "category", "event", "action", "rule", "src", "sport", "dst", "dport", "proto", "client_mac", "client_name", "client_ip", "ssid", "message"})
	}
	n := 0
	for n < max {
		rows, err := s.Logs.Search(r.Context(), req)
		if err != nil || len(rows) == 0 {
			break
		}
		for _, x := range rows {
			if format == "json" {
				enc.Encode(x)
			} else {
				cw.Write([]string{x.TS.Format(time.RFC3339Nano), x.Site, x.Hostname, x.SourceIP, x.DeviceModel, unifi.SeverityNames[x.Severity&7], x.App, x.Category, x.EventType, x.Action, x.Rule,
					x.SrcIP, strconv.Itoa(int(x.SrcPort)), x.DstIP, strconv.Itoa(int(x.DstPort)), x.Proto, x.ClientMAC, x.ClientName, x.ClientIP, x.SSID, x.Message})
			}
		}
		n += len(rows)
		cw.Flush()
		if len(rows) < req.Limit {
			break
		}
		req.Before = rows[len(rows)-1].TS
	}
	cw.Flush()
}

// live returns rows received after the given unix-ms cursor, used by the
// UI's live tail (polling keeps it proxy-friendly).
func (s *Server) live(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	after, _ := strconv.ParseInt(q.Get("after"), 10, 64)
	now := time.Now()
	req := store.SearchReq{Query: q.Get("query"), From: now.Add(-10 * time.Minute), To: now.Add(time.Hour), Limit: 300}
	if s := q.Get("sites"); s != "" {
		req.Sites = strings.Split(s, ",")
	}
	if after > 0 {
		req.AfterReceived = time.UnixMilli(after)
	}
	rows, err := s.Logs.Search(r.Context(), req)
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	out := rows[:0]
	cursor := after
	for _, x := range rows {
		ms := x.Received.UnixMilli()
		if ms > after {
			out = append(out, x)
		}
		if ms > cursor {
			cursor = ms
		}
	}
	if cursor == 0 {
		cursor = now.UnixMilli()
	}
	jsonOut(w, map[string]any{"rows": out, "cursor": cursor})
}

func (s *Server) fields(w http.ResponseWriter, r *http.Request) {
	f := query.Fields()
	sort.Strings(f)
	jsonOut(w, map[string]any{"fields": f, "categories": unifi.AllCategories})
}

// ---------------------------------------------------------------- dashboard

func (s *Server) dashboard(w http.ResponseWriter, r *http.Request) {
	req := reqFromQuery(r)
	ctx := r.Context()
	ov, err := s.Logs.Overview(ctx, req.From, req.To, req.Sites)
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	tops := map[string][]store.TopItem{}
	type spec struct{ key, query, field string }
	specs := []spec{
		{"blocked_src", "category:firewall action:block", "src_ip"},
		{"blocked_dport", "category:firewall action:block", "dst_port"},
		{"fw_rules", "category:firewall", "rule"},
		{"ips_rules", "category:ips", "rule"},
		{"wifi_clients", "category:wifi", "client_mac"},
		{"ssids", "category:wifi OR category:client", "ssid"},
		{"sources", "", "hostname"},
		{"dhcp_clients", "category:dhcp", "client_name"},
	}
	type res struct {
		key   string
		items []store.TopItem
	}
	ch := make(chan res, len(specs))
	for _, sp := range specs {
		go func(sp spec) {
			q := req
			q.Query = sp.query
			items, _ := s.Logs.Top(ctx, q, sp.field, 8)
			ch <- res{sp.key, items}
		}(sp)
	}
	for range specs {
		x := <-ch
		if x.items == nil {
			x.items = []store.TopItem{}
		}
		tops[x.key] = x.items
	}
	jsonOut(w, map[string]any{"overview": ov, "top": tops, "ingest": s.ingestStats()})
}

func (s *Server) categoryStats(w http.ResponseWriter, r *http.Request) {
	req := reqFromQuery(r)
	cats, err := s.Meta.Categories()
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	type res struct {
		ID    int64  `json:"id"`
		Count uint64 `json:"count"`
		Error string `json:"error,omitempty"`
	}
	out := make([]res, len(cats))
	done := make(chan struct{}, len(cats))
	for i, c := range cats {
		go func(i int, c store.Category) {
			q := req
			q.Query = c.Query
			n, err := s.Logs.Count(r.Context(), q)
			out[i] = res{ID: c.ID, Count: n}
			if err != nil {
				out[i].Error = err.Error()
			}
			done <- struct{}{}
		}(i, c)
	}
	for range cats {
		<-done
	}
	jsonOut(w, out)
}

// ---------------------------------------------------------------- categories / sources / sites

func (s *Server) listCategories(w http.ResponseWriter, r *http.Request) {
	c, err := s.Meta.Categories()
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, c)
}

func (s *Server) saveCategory(w http.ResponseWriter, r *http.Request) {
	var c store.Category
	if err := decode(r, &c); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if id := idParam(r); id > 0 {
		c.ID = id
	}
	if strings.TrimSpace(c.Name) == "" {
		jerr(w, 400, "name is required")
		return
	}
	if _, err := query.Compile(c.Query); err != nil {
		jerr(w, 400, "filter: "+err.Error())
		return
	}
	if err := s.Meta.SaveCategory(&c); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "category_saved", c.Name)
	jsonOut(w, c)
}

func (s *Server) deleteCategory(w http.ResponseWriter, r *http.Request) {
	if err := s.Meta.DeleteCategory(idParam(r)); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, map[string]bool{"ok": true})
}

func (s *Server) listSources(w http.ResponseWriter, r *http.Request) {
	src := s.Meta.Sources()
	sort.Slice(src, func(i, j int) bool { return src[i].LastSeen > src[j].LastSeen })
	jsonOut(w, src)
}

func (s *Server) updateSource(w http.ResponseWriter, r *http.Request) {
	var b struct{ Name, Site string }
	if err := decode(r, &b); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	ip, _ := url.PathUnescape(chi.URLParam(r, "ip"))
	if err := s.Meta.UpdateSource(ip, strings.TrimSpace(b.Name), strings.TrimSpace(b.Site)); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "source_updated", ip)
	jsonOut(w, map[string]bool{"ok": true})
}

func (s *Server) deleteSource(w http.ResponseWriter, r *http.Request) {
	ip, _ := url.PathUnescape(chi.URLParam(r, "ip"))
	if err := s.Meta.DeleteSource(ip); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, map[string]bool{"ok": true})
}

func (s *Server) listSites(w http.ResponseWriter, r *http.Request) { jsonOut(w, s.Meta.Sites()) }

func (s *Server) listRanges(w http.ResponseWriter, r *http.Request) {
	rs, err := s.Meta.SiteRanges()
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, rs)
}

func (s *Server) saveRange(w http.ResponseWriter, r *http.Request) {
	var sr store.SiteRange
	if err := decode(r, &sr); err != nil || sr.Site == "" {
		jerr(w, 400, "site and network are required")
		return
	}
	if err := s.Meta.SaveSiteRange(&sr); err != nil {
		jerr(w, 400, "invalid network (use CIDR, e.g. 10.1.0.0/16)")
		return
	}
	s.Pipeline.ReloadRanges()
	jsonOut(w, sr)
}

func (s *Server) deleteRange(w http.ResponseWriter, r *http.Request) {
	s.Meta.DeleteSiteRange(idParam(r))
	s.Pipeline.ReloadRanges()
	jsonOut(w, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- settings

func (s *Server) getGeneral(w http.ResponseWriter, r *http.Request) { jsonOut(w, s.Meta.General()) }

func (s *Server) putGeneral(w http.ResponseWriter, r *http.Request) {
	var g store.GeneralSettings
	if err := decode(r, &g); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if _, err := time.LoadLocation(g.Timezone); err != nil {
		jerr(w, 400, "unknown time zone")
		return
	}
	if g.RetentionDays < 1 || g.RetentionDays > 3650 {
		jerr(w, 400, "retention must be between 1 and 3650 days")
		return
	}
	if g.Language = i18n.Normalize(g.Language); g.Language == "" {
		g.Language = "en"
	}
	old := s.Meta.General()
	if old.RetentionDays != g.RetentionDays {
		if err := s.Logs.SetRetention(r.Context(), g.RetentionDays); err != nil {
			jerr(w, 500, err.Error())
			return
		}
	}
	if err := s.Meta.SetSetting("general", g); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	if s.OnSettings != nil {
		s.OnSettings(g)
	}
	s.audit_(r, "settings_general", "")
	jsonOut(w, g)
}

func (s *Server) getSSO(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, map[string]any{"settings": store.MaskSSO(s.Meta.SSO()), "redirect_uri": s.Entra.RedirectURL(s.baseURL(r))})
}

func (s *Server) putSSO(w http.ResponseWriter, r *http.Request) {
	var v store.SSOSettings
	if err := decode(r, &v); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if v.Enabled && (v.TenantID == "" || v.ClientID == "") {
		jerr(w, 400, "tenant ID and client ID are required")
		return
	}
	if err := s.Meta.SaveSSO(v); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "settings_sso", "")
	jsonOut(w, store.MaskSSO(s.Meta.SSO()))
}

func (s *Server) getSMTP(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, store.MaskSMTP(s.Meta.SMTP()))
}

func (s *Server) putSMTP(w http.ResponseWriter, r *http.Request) {
	var v store.SMTPSettings
	if err := decode(r, &v); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if err := s.Meta.SaveSMTP(v); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "settings_smtp", "")
	jsonOut(w, store.MaskSMTP(s.Meta.SMTP()))
}

func (s *Server) testSMTP(w http.ResponseWriter, r *http.Request) {
	var v struct {
		To       string             `json:"to"`
		Settings store.SMTPSettings `json:"settings"`
	}
	if err := decode(r, &v); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	cur := s.Meta.SMTP()
	if v.Settings.Password == store.Secret {
		v.Settings.Password = cur.Password
	}
	if v.Settings.OAuthSecret == store.Secret {
		v.Settings.OAuthSecret = cur.OAuthSecret
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	rcpt := mail.Recipients([]string{v.To}, v.Settings.DefaultTo)
	lang := ""
	if len(rcpt) > 0 {
		lang = s.Meta.LanguageForEmail(rcpt[0])
	}
	if lang == "" {
		lang = s.language(user(r))
	}
	brand := s.Mailer.Brand()
	t := i18n.For(lang)
	err := mail.SendWith(ctx, v.Settings, brand, lang, rcpt, t("Test message"),
		t("This is a test message from %s.\nIf you are reading this, the mail configuration works.\n\nSent: %s", brand.Instance, time.Now().Format(time.RFC1123)))
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	jsonOut(w, map[string]string{"message": "Test message sent to " + strings.Join(rcpt, ", ")})
}

func (s *Server) getBackup(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, store.MaskBackup(s.Meta.Backup()))
}

func (s *Server) putBackup(w http.ResponseWriter, r *http.Request) {
	var v store.BackupSettings
	if err := decode(r, &v); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if _, err := time.Parse("15:04", v.Time); err != nil {
		jerr(w, 400, "time must be HH:MM")
		return
	}
	for _, t := range v.Targets {
		switch t.Type {
		case "ftp", "ftps", "ftps-implicit", "scp", "local":
		default:
			jerr(w, 400, "unknown type "+t.Type)
			return
		}
	}
	if err := s.Meta.SaveBackup(v); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "settings_backup", "")
	jsonOut(w, store.MaskBackup(s.Meta.Backup()))
}

func (s *Server) testTarget(w http.ResponseWriter, r *http.Request) {
	var t store.BackupTarget
	if err := decode(r, &t); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	for _, old := range s.Meta.Backup().Targets {
		if old.ID == t.ID {
			if t.Password == store.Secret {
				t.Password = old.Password
			}
			if t.PrivateKey == store.Secret {
				t.PrivateKey = old.PrivateKey
			}
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	msg, err := backup.Test(ctx, t)
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	jsonOut(w, map[string]string{"message": msg})
}

func (s *Server) runBackup(w http.ResponseWriter, r *http.Request) {
	var v struct{ Kind string }
	decode(r, &v)
	if v.Kind != "full" {
		v.Kind = "incremental"
	}
	if err := s.Backup.Start(v.Kind); err != nil {
		jerr(w, 409, err.Error())
		return
	}
	s.audit_(r, "backup_started", v.Kind)
	jsonOut(w, s.Backup.Status())
}

func (s *Server) backupStatus(w http.ResponseWriter, r *http.Request) { jsonOut(w, s.Backup.Status()) }

func (s *Server) backupHistory(w http.ResponseWriter, r *http.Request) {
	recs, err := s.Meta.BackupRecords(100)
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, recs)
}

func (s *Server) backupList(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	l, err := s.Backup.List(ctx, r.URL.Query().Get("target"))
	if err != nil {
		jerr(w, 400, err.Error())
		return
	}
	jsonOut(w, l)
}

func (s *Server) restore(w http.ResponseWriter, r *http.Request) {
	var o backup.RestoreOptions
	if err := decode(r, &o); err != nil || o.Name == "" {
		jerr(w, 400, "invalid request")
		return
	}
	if !o.Config && !o.Logs {
		jerr(w, 400, "choose configuration and/or log data")
		return
	}
	if err := s.Backup.StartRestore(o); err != nil {
		jerr(w, 409, err.Error())
		return
	}
	s.audit_(r, "restore_started", o.Name)
	jsonOut(w, s.Backup.Status())
}

func (s *Server) backupDownload(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(chi.URLParam(r, "name"))
	if !strings.HasPrefix(name, "unify-syslog-") || !strings.HasSuffix(name, ".tar") {
		jerr(w, 400, "invalid name")
		return
	}
	p := filepath.Join(s.Cfg.BackupDir(), name)
	if _, err := os.Stat(p); err != nil {
		jerr(w, 404, "not found")
		return
	}
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, p)
}

// ---------------------------------------------------------------- alerts

func (s *Server) listAlerts(w http.ResponseWriter, r *http.Request) {
	a, err := s.Meta.AlertRules()
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, a)
}

func (s *Server) saveAlert(w http.ResponseWriter, r *http.Request) {
	var a store.AlertRule
	if err := decode(r, &a); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if id := idParam(r); id > 0 {
		a.ID = id
	}
	if _, err := query.Compile(a.Query); err != nil {
		jerr(w, 400, "filter: "+err.Error())
		return
	}
	if err := s.Meta.SaveAlertRule(&a); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "alert_saved", a.Name)
	jsonOut(w, a)
}

func (s *Server) deleteAlert(w http.ResponseWriter, r *http.Request) {
	s.Meta.DeleteAlertRule(idParam(r))
	jsonOut(w, map[string]bool{"ok": true})
}

// ---------------------------------------------------------------- users

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	u, err := s.Meta.Users()
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	jsonOut(w, u)
}

type userBody struct {
	store.User
	Password string `json:"password"`
}

func validRole(r string) bool { return r == "admin" || r == "viewer" }

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	var b userBody
	if err := decode(r, &b); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	b.Username = strings.TrimSpace(b.Username)
	if b.Username == "" || !validRole(b.Role) {
		jerr(w, 400, "username and role are required")
		return
	}
	if len(b.Password) < 10 {
		jerr(w, 400, "password must be at least 10 characters")
		return
	}
	u := b.User
	u.Provider = "local"
	u.Language = i18n.Normalize(u.Language)
	u.LanguageManual = u.Language != ""
	if err := s.Meta.CreateUser(&u, b.Password); err != nil {
		jerr(w, 400, "user already exists")
		return
	}
	s.audit_(r, "user_created", u.Username)
	jsonOut(w, u)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	var b userBody
	if err := decode(r, &b); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	u, err := s.Meta.UserByID(idParam(r))
	if err != nil {
		jerr(w, 404, "not found")
		return
	}
	if !validRole(b.Role) {
		jerr(w, 400, "invalid role")
		return
	}
	me := user(r)
	if u.ID == me.ID && (b.Role != "admin" || b.Disabled) {
		jerr(w, 400, "you cannot remove your own admin rights")
		return
	}
	u.Email, u.Name, u.Role, u.Disabled = b.Email, b.Name, b.Role, b.Disabled
	if lang := i18n.Normalize(b.Language); lang != u.Language {
		u.Language, u.LanguageManual = lang, lang != ""
	}
	if err := s.Meta.UpdateUser(u); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	if b.Password != "" {
		if u.Provider != "local" {
			jerr(w, 400, "cannot set a password for SSO users")
			return
		}
		if len(b.Password) < 10 {
			jerr(w, 400, "password must be at least 10 characters")
			return
		}
		s.Meta.SetPassword(u.ID, b.Password)
	}
	s.audit_(r, "user_updated", u.Username)
	jsonOut(w, u)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	id := idParam(r)
	if id == user(r).ID {
		jerr(w, 400, "you cannot delete yourself")
		return
	}
	s.Meta.DeleteUser(id)
	s.audit_(r, "user_deleted", strconv.FormatInt(id, 10))
	jsonOut(w, map[string]bool{"ok": true})
}

func (s *Server) audit(w http.ResponseWriter, r *http.Request) {
	rows, err := s.Meta.DB.Query(`SELECT ts,username,action,detail FROM audit ORDER BY id DESC LIMIT 300`)
	if err != nil {
		jerr(w, 500, err.Error())
		return
	}
	defer rows.Close()
	type a struct {
		TS     int64  `json:"ts"`
		User   string `json:"user"`
		Action string `json:"action"`
		Detail string `json:"detail"`
	}
	out := []a{}
	for rows.Next() {
		var x a
		rows.Scan(&x.TS, &x.User, &x.Action, &x.Detail)
		out = append(out, x)
	}
	jsonOut(w, out)
}

// ---------------------------------------------------------------- info / update

func (s *Server) ingestStats() map[string]any {
	le, _ := s.IngStats.LastError.Load().(string)
	return map[string]any{
		"udp_packets":   s.SysStats.UDPPackets.Load(),
		"tcp_messages":  s.SysStats.TCPMsgs.Load(),
		"tcp_conns":     s.SysStats.TCPConns.Load(),
		"dropped":       s.SysStats.Dropped.Load(),
		"parsed":        s.IngStats.Parsed.Load(),
		"inserted":      s.IngStats.Inserted.Load(),
		"insert_errors": s.IngStats.InsertErrs.Load(),
		"discarded":     s.IngStats.Discarded.Load(),
		"last_insert":   s.IngStats.LastInsert.Load(),
		"last_error":    le,
	}
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request) { jsonOut(w, s.ingestStats()) }

func (s *Server) info(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	st, err := s.Logs.Storage(ctx)
	if err != nil {
		st = &store.StorageInfo{}
	}
	host, _ := os.Hostname()
	jsonOut(w, map[string]any{
		"version":    version.Version,
		"commit":     version.Commit,
		"build_date": version.BuildDate,
		"repo":       version.Repo,
		"go":         runtime.Version(),
		"os":         runtime.GOOS + "/" + runtime.GOARCH,
		"hostname":   host,
		"started":    s.Started,
		"uptime_sec": int64(time.Since(s.Started).Seconds()),
		"storage":    st,
		"ingest":     s.ingestStats(),
		"syslog":     map[string]string{"udp": s.Cfg.Syslog.UDP, "tcp": s.Cfg.Syslog.TCP},
		"update":     s.Meta.Update(),
	})
}

func (s *Server) updateCheck(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	us := s.Meta.Update()
	res, err := s.Updater.Check(ctx, us.Prerelease)
	if err != nil {
		jerr(w, 502, err.Error())
		return
	}
	us.LastCheck, us.LastVersion = res.CheckedAt, res.Latest
	s.Meta.SetSetting("update", us)
	jsonOut(w, res)
}

func (s *Server) updateStatus(w http.ResponseWriter, r *http.Request) {
	running, state := s.Updater.State()
	jsonOut(w, map[string]any{"running": running, "state": state, "version": version.Version})
}

func (s *Server) updateApply(w http.ResponseWriter, r *http.Request) {
	s.audit_(r, "update_started", "")
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
		defer cancel()
		if err := s.Updater.Apply(ctx, s.Meta.Update().Prerelease, s.Restart); err != nil {
			s.Log.Error("update failed", "err", err)
		}
	}()
	jsonOut(w, map[string]string{"message": fmt.Sprintf("Update started from version %s", version.Version)})
}
