// SPDX-License-Identifier: AGPL-3.0-or-later

package version

import "testing"

func TestSourceURL(t *testing.T) {
	old := Version
	defer func() { Version = old }()
	for v, want := range map[string]string{
		"0.0.0-dev":     "https://github.com/" + Repo,
		"0.13.0":        "https://github.com/" + Repo + "/tree/v0.13.0",
		"0.14.0-beta.1": "https://github.com/" + Repo + "/tree/v0.14.0-beta.1",
	} {
		Version = v
		if got := SourceURL(); got != want {
			t.Errorf("SourceURL() for %q = %q, want %q", v, got, want)
		}
	}
}
