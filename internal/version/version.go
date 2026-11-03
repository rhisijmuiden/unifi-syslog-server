// SPDX-License-Identifier: AGPL-3.0-or-later

// Package version holds build metadata injected via -ldflags.
package version

import "strings"

var (
	Version   = "0.0.0-dev"
	Commit    = "none"
	BuildDate = "unknown"
	Repo      = "rhisijmuiden/unifi-syslog-server"
)

// License is the SPDX identifier of the license this software is released
// under. The AGPL requires that users who interact with the server over a
// network can get its source code, which is why the UI links to it.
const License = "AGPL-3.0-or-later"

// SourceURL returns where the source code of this build can be found: the
// release tag for a released version, the main branch otherwise.
func SourceURL() string {
	base := "https://github.com/" + Repo
	if Version == "" || strings.Contains(Version, "dev") {
		return base
	}
	return base + "/tree/v" + Version
}
