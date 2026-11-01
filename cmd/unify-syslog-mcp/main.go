// Command unify-syslog-mcp connects MCP clients that use stdio, such as
// Claude Desktop, to the MCP endpoint of UniFi Syslog Server. It runs on
// the computer of the person using the AI assistant (Windows, macOS or
// Linux), not on the server.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/rhisijmuiden/unify-syslog-server/internal/mcpbridge"
	"github.com/rhisijmuiden/unify-syslog-server/internal/version"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Printf("unify-syslog-mcp %s (commit %s)\n", version.Version, version.Commit)
		return
	}
	if err := mcpbridge.Main("unify-syslog-mcp", os.Args[1:]); err != nil && err != flag.ErrHelp {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
