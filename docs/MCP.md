# AI assistants (MCP)

UniFi Syslog Server has a built-in [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. With it, Claude and other AI assistants can answer questions about your network from the logs, for example:

- "Which IP addresses were blocked most by the firewall in the last 24 hours, and from which countries?"
- "Did any access point go silent this week?"
- "Show the IPS alerts of the last 7 days and explain the three most serious ones."
- "When did the DHCP errors at site Amsterdam start, and is it getting worse?"
- "Is the syslog server healthy? Are messages being dropped?"

The page **AI assistants (MCP)** in the menu shows the endpoint, creates a token and gives ready-to-paste configuration for each client.

## How it works

- The endpoint is `https://<server>:8080/mcp` (Streamable HTTP, stateless, JSON responses). Plain `http://` works on the same port too.
- Every request needs an **API token** (`Authorization: Bearer uss_…`). The assistant gets the **role and sites of the token's user**: a viewer token only sees the viewer's sites, and administrator-only tools are not even listed for other users.
- All tools **only read**. An assistant cannot change settings, delete data, send alerts or export. A read-only token is enough and recommended.
- Every tool call goes through the same REST API as scripts do, so searches appear in the **audit log** with the token name.
- Administrators can turn the endpoint off on the AI assistants page (on by default). When it is off, `/mcp` answers `404`.

## Tools

| Tool | Does |
|---|---|
| `search_logs` | Search messages with the [query language](../README.md#query-language); newest first, up to 200 rows per call, with paging (`before`) |
| `count_logs` | Count matching messages over time (about 120 buckets), optionally per category, severity, site, action, hostname, app or event type |
| `top_values` | The most frequent values of a field (source IPs, ports, rules, SSIDs, countries …) |
| `search_everything` | Devices, clients, sites, categories and saved searches (administrators: also alert rules, channels, probes, forwarding, controllers and users) plus matching log messages |
| `get_overview` | The overview dashboard for a time range |
| `list_sites` | Sites with devices, senders and 24-hour counts |
| `list_devices` | Device inventory with status (active, silent, inactive), firmware and counts; filter by site, status or text |
| `list_clients` | Known clients with name, MAC, IP and site |
| `get_firmware_status` | Firmware per model and outdated devices |
| `list_categories` | Categories with their query and message count |
| `list_saved_searches` | Your own and shared saved searches |
| `get_probe_status` | Remote probes: online, version, buffer |
| `query_language` | Syntax, examples and every field name, so the assistant writes correct queries |
| `server_info` | Version, uptime, storage, and the role and sites of the token's user |
| `list_alert_rules` | Alert rules (administrators) |
| `get_system_status` | Server health, ingest, disks, ClickHouse, probes, forwarding, notifications and backups (administrators) |

Time ranges are given as `last` (`15m`, `1h`, `24h`, `7d`, `30d` …) or `from`/`to` (RFC 3339); without them the last 24 hours are used.

## Connecting a client

First create a token: on the AI assistants page (**Create a read-only token**), or under **My account → API tokens**.

### Claude Desktop

Claude Desktop starts local MCP servers over stdio, so it uses the small **MCP bridge** `unify-syslog-mcp`. It runs on your own computer and passes the questions to the server with your token.

1. Download the bridge for your computer from the [latest release](https://github.com/rhisijmuiden/unifi-syslog-server/releases/latest): `unify-syslog-mcp_windows_amd64.exe`, `…_darwin_arm64` (Apple silicon), `…_darwin_amd64`, `…_linux_amd64` and so on.
   - macOS and Linux: `chmod +x unify-syslog-mcp`; on macOS also `xattr -d com.apple.quarantine unify-syslog-mcp`.
2. In Claude Desktop open **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "unifi-syslog": {
      "command": "C:\\Tools\\unify-syslog-mcp.exe",
      "args": ["--url", "https://syslog.example.com:8080", "--pin", "<pin from the AI assistants page>"],
      "env": { "USS_MCP_TOKEN": "uss_…" }
    }
  }
}
```

3. Restart Claude Desktop. The tools appear under the tools icon in the chat box.

`--pin` is the public key pin of the server's self-signed certificate (the same one probes use). With it, the bridge verifies the server without a public certificate. Leave it out when the server has a trusted certificate (`tls_cert` in `config.yaml`). The server binary has the same bridge built in: `unify-syslog mcp --url … --pin …`.

### Claude Code

With the bridge (works with the self-signed certificate):

```sh
claude mcp add --env USS_MCP_TOKEN=uss_… unifi-syslog -- unify-syslog-mcp --url https://syslog.example.com:8080 --pin <pin>
```

Or directly over HTTP, when the server has a trusted certificate (or with `http://` on a trusted network):

```sh
claude mcp add --transport http unifi-syslog https://syslog.example.com:8080/mcp --header "Authorization: Bearer uss_…"
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "unifi-syslog": {
      "type": "http",
      "url": "https://syslog.example.com:8080/mcp",
      "headers": { "Authorization": "Bearer uss_…" }
    }
  }
}
```

### Other clients

Any client that supports remote MCP servers with a custom header (Cursor, Windsurf, LibreChat, n8n …) uses the URL `https://<server>:8080/mcp` with the header `Authorization: Bearer uss_…`. Clients that only support stdio use the bridge:

```sh
USS_MCP_TOKEN=uss_… unify-syslog-mcp --url https://syslog.example.com:8080 --pin <pin>
```

Claude.ai in the browser and the Claude mobile apps connect to remote MCP servers from the internet with OAuth. That is not supported yet; the syslog server is usually not reachable from the internet anyway.

## Bridge options

| Option | Environment | Meaning |
|---|---|---|
| `--url` | `USS_MCP_URL` | Server address; `/mcp` is added when there is no path |
| (none) | `USS_MCP_TOKEN` | API token. `--token` exists too, but the environment keeps it out of the process list |
| `--pin` | `USS_MCP_PIN` | Trust the server certificate with this public key pin |
| `--insecure` | | Do not verify the certificate at all (testing only) |

The bridge writes errors to stderr, which Claude Desktop shows in its MCP log (`mcp-server-unifi-syslog.log`).

## Troubleshooting

| Problem | Fix |
|---|---|
| `invalid or expired API token` | The token was revoked or expired; create a new one |
| `the MCP server is turned off` | An administrator turned it off on the AI assistants page |
| `certificate signed by unknown authority` / `does not match the pinned key` | Use `--pin` with the pin from the AI assistants page; after replacing the certificate the pin changes |
| A viewer misses tools or sites | Tools and results follow the role and sites of the token's user |
