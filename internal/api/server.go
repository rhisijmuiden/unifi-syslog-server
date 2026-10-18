// Package api is the HTTP server: JSON API plus the embedded admin UI.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/rhisijmuiden/unify-syslog-server/internal/alerts"
	"github.com/rhisijmuiden/unify-syslog-server/internal/auth"
	"github.com/rhisijmuiden/unify-syslog-server/internal/backup"
	"github.com/rhisijmuiden/unify-syslog-server/internal/config"
	"github.com/rhisijmuiden/unify-syslog-server/internal/i18n"
	"github.com/rhisijmuiden/unify-syslog-server/internal/ingest"
	"github.com/rhisijmuiden/unify-syslog-server/internal/mail"
	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
	"github.com/rhisijmuiden/unify-syslog-server/internal/syslogd"
	"github.com/rhisijmuiden/unify-syslog-server/internal/update"
)

type Server struct {
	Cfg      *config.Config
	Meta     *store.Meta
	Logs     *store.Logs
	Mailer   *mail.Mailer
	Backup   *backup.Manager
	Updater  *update.Updater
	Entra    *auth.Entra
	Alerts   *alerts.Engine
	Pipeline *ingest.Pipeline
	SysStats *syslogd.Stats
	IngStats *ingest.Stats
	UI       fs.FS
	Log      *slog.Logger
	Started  time.Time
	Restart  func()
	// OnSettings is called after general settings change (timezone, retention).
	OnSettings func(store.GeneralSettings)

	loginMu   sync.Mutex
	loginFail map[string][]time.Time
}

const cookieName = "uss_session"
const sessionTTL = 12 * time.Hour

type ctxKey int

const userKey ctxKey = 1

func (s *Server) Handler() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RealIP, middleware.Recoverer, securityHeaders)
	r.Use(middleware.Compress(5, "application/json", "text/html", "text/css", "application/javascript", "image/svg+xml"))

	r.Route("/api", func(r chi.Router) {
		r.Use(csrf)
		r.Get("/health", s.health)
		r.Get("/auth/status", s.authStatus)
		r.Post("/auth/login", s.login)
		r.Post("/auth/logout", s.logout)
		r.Get("/auth/entra/login", s.entraLogin)
		r.Get("/auth/entra/callback", s.entraCallback)
		r.Get("/branding/{asset}", s.brandingAsset)

		r.Group(func(r chi.Router) {
			r.Use(s.requireUser)
			r.Get("/me", s.me)
			r.Post("/me/password", s.changePassword)
			r.Put("/me/language", s.setMyLanguage)
			r.Get("/info", s.info)
			r.Get("/stats", s.stats)
			r.Get("/update/check", s.updateCheck)
			r.Get("/update/status", s.updateStatus)

			r.Post("/search", s.search)
			r.Post("/search/histogram", s.histogram)
			r.Post("/search/top", s.top)
			r.Get("/search/export", s.export)
			r.Get("/live", s.live)
			r.Get("/fields", s.fields)
			r.Get("/dashboard", s.dashboard)
			r.Get("/categories", s.listCategories)
			r.Get("/categories/stats", s.categoryStats)
			r.Get("/sources", s.listSources)
			r.Get("/devices", s.listDevices)
			r.Get("/sites", s.listSites)
			r.Get("/sites/overview", s.siteOverview)

			r.Group(func(r chi.Router) {
				r.Use(requireAdmin)
				r.Post("/categories", s.saveCategory)
				r.Put("/categories/{id}", s.saveCategory)
				r.Delete("/categories/{id}", s.deleteCategory)
				r.Put("/sources/{ip}", s.updateSource)
				r.Delete("/sources/{ip}", s.deleteSource)
				r.Put("/devices/{key}", s.updateDevice)
				r.Delete("/devices/{key}", s.deleteDevice)
				r.Get("/settings/inventory", s.getInventory)
				r.Put("/settings/inventory", s.putInventory)
				r.Get("/site-ranges", s.listRanges)
				r.Post("/site-ranges", s.saveRange)
				r.Delete("/site-ranges/{id}", s.deleteRange)

				r.Get("/settings/general", s.getGeneral)
				r.Put("/settings/general", s.putGeneral)
				r.Get("/settings/branding", s.getBranding)
				r.Put("/settings/branding", s.putBranding)
				r.Put("/settings/branding/{asset}", s.putBrandingAsset)
				r.Delete("/settings/branding/{asset}", s.deleteBrandingAsset)
				r.Get("/settings/sso", s.getSSO)
				r.Put("/settings/sso", s.putSSO)
				r.Get("/settings/smtp", s.getSMTP)
				r.Put("/settings/smtp", s.putSMTP)
				r.Post("/settings/smtp/test", s.testSMTP)
				r.Get("/settings/backup", s.getBackup)
				r.Put("/settings/backup", s.putBackup)

				r.Post("/backup/test-target", s.testTarget)
				r.Post("/backup/run", s.runBackup)
				r.Get("/backup/status", s.backupStatus)
				r.Get("/backup/history", s.backupHistory)
				r.Get("/backup/list", s.backupList)
				r.Post("/backup/restore", s.restore)
				r.Get("/backup/download/{name}", s.backupDownload)

				r.Get("/alerts", s.listAlerts)
				r.Post("/alerts", s.saveAlert)
				r.Put("/alerts/{id}", s.saveAlert)
				r.Delete("/alerts/{id}", s.deleteAlert)

				r.Get("/users", s.listUsers)
				r.Post("/users", s.createUser)
				r.Put("/users/{id}", s.updateUser)
				r.Delete("/users/{id}", s.deleteUser)

				r.Post("/update/apply", s.updateApply)
				r.Get("/audit", s.audit)
			})
		})
		r.NotFound(func(w http.ResponseWriter, r *http.Request) { jerr(w, 404, "not found") })
	})
	r.Get("/*", s.spa)
	return r
}

// ---------------------------------------------------------------- middleware

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "same-origin")
		h.Set("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

// csrf requires a custom header on state-changing requests; browsers do not
// send it cross-site without a CORS preflight, which we never allow.
func csrf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
		default:
			if r.Header.Get("X-USS") != "1" {
				jerr(w, 403, "CSRF check failed")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil {
			jerr(w, 401, "not signed in")
			return
		}
		u, err := s.Meta.SessionUser(c.Value)
		if err != nil {
			jerr(w, 401, "session expired")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey, u)))
	})
}

func requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if u := user(r); u == nil || u.Role != "admin" {
			jerr(w, 403, "administrators only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func user(r *http.Request) *store.User {
	u, _ := r.Context().Value(userKey).(*store.User)
	return u
}

func (s *Server) audit_(r *http.Request, action, detail string) {
	name := "system"
	if u := user(r); u != nil {
		name = u.Username
	}
	s.Meta.Audit(name, action, detail)
}

// ---------------------------------------------------------------- helpers

func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func jerr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func decode(r *http.Request, v any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 4<<20))
	return dec.Decode(v)
}

func idParam(r *http.Request) int64 {
	n, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	return n
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func (s *Server) baseURL(r *http.Request) string {
	if b := s.Meta.General().BaseURL; b != "" {
		return strings.TrimRight(b, "/")
	}
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	host := r.Host
	if fh := r.Header.Get("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return scheme + "://" + host
}

func (s *Server) setSession(w http.ResponseWriter, r *http.Request, u *store.User) error {
	tok, err := s.Meta.CreateSession(u.ID, sessionTTL)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: tok, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode,
		Secure: strings.HasPrefix(s.baseURL(r), "https"), MaxAge: int(sessionTTL.Seconds())})
	s.Meta.TouchLogin(u.ID)
	return nil
}

func (s *Server) spa(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if p == "" {
		p = "index.html"
	}
	if st, err := fs.Stat(s.UI, p); err != nil || st.IsDir() {
		p = "index.html"
	}
	if strings.HasPrefix(p, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeFileFS(w, r, s.UI, p)
}

// ---------------------------------------------------------------- auth handlers

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	if err := s.Logs.Conn.Ping(ctx); err != nil {
		jerr(w, 503, "clickhouse: "+err.Error())
		return
	}
	jsonOut(w, map[string]string{"status": "ok"})
}

func (s *Server) authStatus(w http.ResponseWriter, r *http.Request) {
	sso := s.Meta.SSO()
	out := map[string]any{
		"sso":      map[string]any{"enabled": sso.Enabled && sso.ClientID != "", "label": sso.ButtonLabel},
		"instance": s.Meta.General().InstanceName,
		"language": s.Meta.General().Language,
		"branding": s.Meta.Branding(),
	}
	if c, err := r.Cookie(cookieName); err == nil {
		if u, err := s.Meta.SessionUser(c.Value); err == nil {
			out["user"] = u
		}
	}
	if e := r.URL.Query().Get("error"); e != "" {
		out["error"] = e
	}
	jsonOut(w, out)
}

// language is the effective language of a user: their own choice, else the
// server default.
func (s *Server) language(u *store.User) string {
	if u != nil && u.Language != "" {
		return u.Language
	}
	return s.Meta.General().Language
}

func (s *Server) setMyLanguage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Language string `json:"language"`
	}
	if err := decode(r, &req); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	lang := i18n.Normalize(req.Language)
	if req.Language != "" && lang == "" {
		jerr(w, 400, "unknown language")
		return
	}
	u := user(r)
	if err := s.Meta.SetUserLanguage(u.ID, lang, lang != ""); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	u.Language, u.LanguageManual = lang, lang != ""
	jsonOut(w, u)
}

func (s *Server) tooManyAttempts(ip string) bool {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	if s.loginFail == nil {
		s.loginFail = map[string][]time.Time{}
	}
	var keep []time.Time
	for _, t := range s.loginFail[ip] {
		if time.Since(t) < 15*time.Minute {
			keep = append(keep, t)
		}
	}
	s.loginFail[ip] = keep
	return len(keep) >= 10
}

func (s *Server) recordFail(ip string) {
	s.loginMu.Lock()
	s.loginFail[ip] = append(s.loginFail[ip], time.Now())
	s.loginMu.Unlock()
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.tooManyAttempts(ip) {
		jerr(w, 429, "too many failed attempts, try again in 15 minutes")
		return
	}
	var req struct{ Username, Password string }
	if err := decode(r, &req); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	u, err := s.Meta.CheckPassword(req.Username, req.Password)
	if err != nil {
		s.recordFail(ip)
		s.Meta.Audit(req.Username, "login_failed", ip)
		jerr(w, 401, "incorrect username or password")
		return
	}
	if err := s.setSession(w, r, u); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.Meta.Audit(u.Username, "login", ip)
	jsonOut(w, u)
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		s.Meta.DeleteSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true})
	jsonOut(w, map[string]bool{"ok": true})
}

func (s *Server) entraLogin(w http.ResponseWriter, r *http.Request) {
	url, state, err := s.Entra.Begin(r.Context(), s.baseURL(r))
	if err != nil {
		http.Redirect(w, r, "/login?error="+urlq(err.Error()), http.StatusFound)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "uss_oidc", Value: state, Path: "/api/auth/entra", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 600})
	http.Redirect(w, r, url, http.StatusFound)
}

func (s *Server) entraCallback(w http.ResponseWriter, r *http.Request) {
	fail := func(msg string) { http.Redirect(w, r, "/login?error="+urlq(msg), http.StatusFound) }
	if e := r.URL.Query().Get("error_description"); e != "" {
		fail(e)
		return
	}
	c, err := r.Cookie("uss_oidc")
	state := r.URL.Query().Get("state")
	if err != nil || c.Value != state {
		fail("invalid sign-in state")
		return
	}
	id, err := s.Entra.Finish(r.Context(), s.baseURL(r), state, r.URL.Query().Get("code"))
	if err != nil {
		fail(err.Error())
		return
	}
	role := s.Entra.Role(id)
	u, err := s.Meta.UserByExternal("entra", id.Subject)
	if errors.Is(err, store.ErrNotFound) {
		// Link to an existing local account with the same username, else provision.
		if lu, lerr := s.Meta.UserByName(id.Username); lerr == nil && lu.Provider == "entra" {
			u, err = lu, nil
		} else if !s.Meta.SSO().AutoProvision {
			fail("no account exists for " + id.Username)
			return
		} else {
			u = &store.User{Username: id.Username, Email: id.Email, Name: id.Name, Role: role, Provider: "entra", ExternalID: id.Subject}
			if lerr == nil {
				u.Username = id.Username + " (entra)"
			}
			err = s.Meta.CreateUser(u, "")
		}
	}
	if err != nil {
		fail(err.Error())
		return
	}
	if u.Disabled {
		fail("account is disabled")
		return
	}
	// The Microsoft account language applies until the user picks one here.
	if lang := i18n.Normalize(id.Language); lang != "" && !u.LanguageManual && u.Language != lang {
		u.Language = lang
		s.Meta.SetUserLanguage(u.ID, lang, false)
	}
	// Group membership is authoritative for admin rights on every sign-in.
	if s.Meta.SSO().AdminGroupID != "" && u.Role != role {
		u.Role = role
		s.Meta.UpdateUser(u)
	}
	if err := s.setSession(w, r, u); err != nil {
		fail(err.Error())
		return
	}
	s.Meta.Audit(u.Username, "login_entra", clientIP(r))
	http.Redirect(w, r, "/", http.StatusFound)
}

func urlq(s string) string { return url.QueryEscape(s) }

func (s *Server) me(w http.ResponseWriter, r *http.Request) { jsonOut(w, user(r)) }

func (s *Server) changePassword(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := decode(r, &req); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	u := user(r)
	if u.Provider != "local" {
		jerr(w, 400, "password is managed by Microsoft Entra")
		return
	}
	if _, err := s.Meta.CheckPassword(u.Username, req.Current); err != nil {
		jerr(w, 400, "current password is incorrect")
		return
	}
	if len(req.New) < 10 {
		jerr(w, 400, "new password must be at least 10 characters")
		return
	}
	if err := s.Meta.SetPassword(u.ID, req.New); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "password_changed", "")
	jsonOut(w, map[string]bool{"ok": true})
}
