// SPDX-License-Identifier: AGPL-3.0-or-later

package api

import (
	"fmt"
	"net/http"
	"regexp"
	"strings"

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
