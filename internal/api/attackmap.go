// SPDX-License-Identifier: AGPL-3.0-or-later

package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

var countryCode = regexp.MustCompile(`^[A-Z]{2}$`)

// attackMap returns where the firewalls are drawn on the live attack map.
// Every signed-in user may read it; firewalls of sites the user may not
// see are left out.
func (s *Server) attackMap(w http.ResponseWriter, r *http.Request) {
	c := s.Meta.AttackMap()
	u := user(r)
	fw := c.Firewalls[:0:0]
	for _, f := range c.Firewalls {
		if f.Site == "" || u.SiteAllowed(f.Site) {
			fw = append(fw, f)
		}
	}
	c.Firewalls = fw
	jsonOut(w, c)
}

func (s *Server) putAttackMap(w http.ResponseWriter, r *http.Request) {
	var c store.AttackMapSettings
	if err := decode(r, &c); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	if err := normalizeAttackMap(&c); err != nil {
		jerr(w, 400, err.Error())
		return
	}
	if err := s.Meta.SetSetting("attack_map", c); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "attack_map_settings", "")
	jsonOut(w, c)
}

func normalizeAttackMap(c *store.AttackMapSettings) error {
	if len(c.Firewalls) > 50 {
		return fmt.Errorf("at most 50 firewalls")
	}
	seen := map[string]bool{}
	for i := range c.Firewalls {
		f := &c.Firewalls[i]
		f.Site = strings.TrimSpace(f.Site)
		f.Label = strings.TrimSpace(f.Label)
		f.Country = strings.ToUpper(strings.TrimSpace(f.Country))
		if !countryCode.MatchString(f.Country) {
			return fmt.Errorf("firewall %d: choose a country", i+1)
		}
		if f.Lat < -90 || f.Lat > 90 || f.Lon < -180 || f.Lon > 180 {
			return fmt.Errorf("firewall %d: invalid coordinates", i+1)
		}
		if len(f.Label) > 60 {
			return fmt.Errorf("firewall %d: the label is too long", i+1)
		}
		if seen[f.Site] {
			if f.Site == "" {
				return fmt.Errorf("only one firewall can be used for all other sites")
			}
			return fmt.Errorf("site %q has more than one firewall", f.Site)
		}
		seen[f.Site] = true
	}
	return nil
}

// ---------------------------------------------------------------- public links

func (s *Server) listAttackMapShares(w http.ResponseWriter, r *http.Request) {
	jsonOut(w, s.Meta.AttackMapShares())
}

func (s *Server) createAttackMapShare(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name  string   `json:"name"`
		Sites []string `json:"sites"`
	}
	if err := decode(r, &b); err != nil {
		jerr(w, 400, "invalid request")
		return
	}
	b.Name = strings.TrimSpace(b.Name)
	if b.Name == "" || len(b.Name) > 80 {
		jerr(w, 400, "enter a name of at most 80 characters")
		return
	}
	sites := []string{}
	for _, x := range b.Sites {
		if x = strings.TrimSpace(x); x != "" && !slices.Contains(sites, x) {
			sites = append(sites, x)
		}
	}
	tok := make([]byte, 24)
	id := make([]byte, 6)
	if _, err := rand.Read(tok); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	rand.Read(id)
	sh := store.AttackMapShare{
		ID: hex.EncodeToString(id), Name: b.Name, Token: base64.RawURLEncoding.EncodeToString(tok),
		Sites: sites, Created: time.Now().Unix(), CreatedBy: user(r).Username,
	}
	s.shareMu.Lock()
	defer s.shareMu.Unlock()
	l := s.Meta.AttackMapShares()
	if len(l) >= 20 {
		jerr(w, 400, "at most 20 public links")
		return
	}
	if err := s.Meta.SetAttackMapShares(append(l, sh)); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "attack_map_share_create", sh.Name)
	jsonOut(w, sh)
}

func (s *Server) deleteAttackMapShare(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	s.shareMu.Lock()
	defer s.shareMu.Unlock()
	l := s.Meta.AttackMapShares()
	i := slices.IndexFunc(l, func(x store.AttackMapShare) bool { return x.ID == id })
	if i < 0 {
		jerr(w, 404, "not found")
		return
	}
	name := l[i].Name
	if err := s.Meta.SetAttackMapShares(slices.Delete(l, i, i+1)); err != nil {
		jerr(w, 500, err.Error())
		return
	}
	s.audit_(r, "attack_map_share_delete", name)
	w.WriteHeader(204)
}

// share finds the public link of the request's token.
func (s *Server) share(r *http.Request) (store.AttackMapShare, bool) {
	tok := chi.URLParam(r, "token")
	for _, x := range s.Meta.AttackMapShares() {
		if len(tok) == len(x.Token) && subtle.ConstantTimeCompare([]byte(tok), []byte(x.Token)) == 1 {
			return x, true
		}
	}
	return store.AttackMapShare{}, false
}

// publicSites hides site names from the public map: firewalls and rows
// refer to sites by an opaque key instead.
func publicSites(fw []store.AttackMapFirewall) map[string]string {
	m := map[string]string{}
	for i, f := range fw {
		if f.Site != "" {
			m[f.Site] = "s" + strconv.Itoa(i)
		}
	}
	return m
}

func shareAllows(sh store.AttackMapShare, site string) bool {
	return len(sh.Sites) == 0 || slices.Contains(sh.Sites, site)
}

func (s *Server) publicAttackMap(w http.ResponseWriter, r *http.Request) {
	sh, ok := s.share(r)
	if !ok {
		jerr(w, 404, "this link does not exist or was revoked")
		return
	}
	all := s.Meta.AttackMap().Firewalls
	keys := publicSites(all)
	fw := []store.AttackMapFirewall{}
	for _, f := range all {
		if f.Site == "" || shareAllows(sh, f.Site) {
			f.Site = keys[f.Site]
			fw = append(fw, f)
		}
	}
	jsonOut(w, map[string]any{"name": sh.Name, "firewalls": fw})
}

// publicRow is what the public map gets of a log line: no internal
// addresses, hostnames, site names or firewall rule names.
type publicRow struct {
	TS      time.Time `json:"ts"`
	Country string    `json:"cc"`
	IP      string    `json:"ip"`
	Port    uint16    `json:"port"`
	Proto   string    `json:"proto"`
	Kind    string    `json:"kind"`
	Rule    string    `json:"rule,omitempty"`
	Site    string    `json:"site"`
}

func (s *Server) publicAttackMapLive(w http.ResponseWriter, r *http.Request) {
	sh, ok := s.share(r)
	if !ok {
		jerr(w, 404, "this link does not exist or was revoked")
		return
	}
	if s.Logs == nil {
		jerr(w, 503, "the log store is not available")
		return
	}
	after, _ := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	now := time.Now()
	req := store.SearchReq{Query: "category:firewall action:block OR category:ips", From: now.Add(-10 * time.Minute), To: now.Add(time.Hour), Limit: 300, Sites: sh.Sites}
	if after > 0 {
		req.AfterReceived = time.UnixMilli(after)
	}
	rows, err := s.Logs.Search(r.Context(), req)
	if err != nil {
		jerr(w, 500, "search failed")
		return
	}
	keys := publicSites(s.Meta.AttackMap().Firewalls)
	out := []publicRow{}
	cursor := after
	for _, x := range rows {
		ms := x.Received.UnixMilli()
		if ms > cursor {
			cursor = ms
		}
		cc := x.Fields["src_country"]
		if ms <= after || cc == "" || !shareAllows(sh, x.Site) {
			continue
		}
		p := publicRow{TS: x.TS, Country: cc, IP: x.SrcIP, Port: x.DstPort, Proto: x.Proto, Kind: "firewall", Site: keys[x.Site]}
		if x.Category == "ips" {
			p.Kind, p.Rule = "ips", x.Rule
		}
		out = append(out, p)
	}
	if cursor == 0 {
		cursor = now.UnixMilli()
	}
	jsonOut(w, map[string]any{"rows": out, "cursor": cursor})
}
