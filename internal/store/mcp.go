// SPDX-License-Identifier: AGPL-3.0-or-later

package store

// MCPSettings control the Model Context Protocol endpoint (/mcp) that AI
// assistants such as Claude use to search the logs.
type MCPSettings struct {
	// Enabled serves /mcp. Clients always authenticate with an API token
	// and get the role and sites of the token's user.
	Enabled bool `json:"enabled"`
}

func (m *Meta) MCP() MCPSettings {
	s := MCPSettings{Enabled: true}
	m.GetSetting("mcp", &s)
	return s
}
