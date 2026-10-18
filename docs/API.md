# REST API

Everything the web interface does goes through a JSON API under `/api`. Scripts and integrations use the same API with a personal **API token**.

## Tokens

Create a token under **My account → API tokens**. The token (`uss_…`) is shown once; only a hash is stored.

- A token has the **role and sites of its user**. A viewer's token sees only the viewer's sites and cannot export.
- **Read-only** tokens (recommended) can call every `GET` endpoint and the search endpoints (`POST /api/search…`), but nothing that changes data.
- Tokens can expire after 30, 90 or 365 days, or never. Revoke a token by deleting it; admins can see and revoke every user's tokens.
- Tokens cannot manage tokens, passwords or two-factor authentication.
- Every change and export made with a token is in the audit log, marked with the token name.

Send the token in the `Authorization` header:

```sh
TOKEN=uss_0123456789abcdef...
curl -H "Authorization: Bearer $TOKEN" http://syslog.example.com:8080/api/sites
```

Requests with a token do not need the `X-USS` header that the web interface sends.

## Searching

The query language is the same as in the interface (see the README). Times are RFC 3339; without `from`/`to` the last 24 hours are used. `sites` is optional and is always limited to the sites the token may see.

```sh
# Latest 100 blocked packets from one site
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"category:firewall action:block","sites":["amsterdam"],"limit":100}' \
  http://syslog.example.com:8080/api/search
```

Response: `{"rows":[{"ts":"…","site":"…","hostname":"…","category":"firewall","action":"block","src_ip":"…",…}],"took_ms":12}`. For the next page, send the `ts` of the last row as `before`.

| Method and path | Body or parameters | Returns |
|---|---|---|
| `POST /api/search` | `query`, `from`, `to`, `sites`, `limit` (max 5000), `before`, `asc` | Log rows |
| `POST /api/search/histogram` | as search, plus `group_by` (a field) | Counts over time |
| `POST /api/search/top` | as search, plus `field` and `n` | Most frequent values of a field |
| `POST /api/search/panels` | `from`, `to`, `sites`, `panels: [{key, query, field, n}]` | Many counts or top lists in one call |
| `GET /api/search/export` | `query`, `from`, `to`, `sites` (comma-separated), `format=csv\|json` | Up to 100,000 rows as CSV or NDJSON (analyst or admin) |
| `GET /api/live` | `query`, `sites`, `after` (unix ms cursor) | Rows received after the cursor, plus a new cursor |

Export example:

```sh
curl -s -H "Authorization: Bearer $TOKEN" -o blocked.csv \
  "http://syslog.example.com:8080/api/search/export?format=csv&query=action:block&from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z"
```

## Inventory and status

| Method and path | Returns |
|---|---|
| `GET /api/me` | The user the token belongs to, with role and sites |
| `GET /api/sites` | Site names |
| `GET /api/sites/overview` | Per site: devices, senders and 24-hour counts |
| `GET /api/devices?days=7` | Device inventory with status (active, silent, inactive) and message counts |
| `GET /api/sources` | Syslog senders (IP address, site, hostname) |
| `GET /api/clients` | Known client names |
| `GET /api/firmware` | Firmware per model and outdated devices |
| `GET /api/categories` | Categories (saved searches) |
| `GET /api/categories/stats` | Message count per category for `from`/`to`/`sites` |
| `GET /api/dashboard` | The overview dashboard data |
| `GET /api/fields` | Field names of the query language |
| `GET /api/stats` | Receiver and ingest counters |
| `GET /api/info` | Version, uptime and storage |
| `GET /api/health` | `{"status":"ok"}` when ClickHouse is reachable (no token needed) |

Admins can also use the configuration endpoints the interface uses (users, settings, backups and so on) with a read-and-write token. These are not a stable interface and may change between versions.

## Errors

Errors are JSON: `{"error":"…"}` with HTTP status `400` (invalid request), `401` (missing, invalid or expired token), `403` (not allowed for this role or a read-only token) or `404`.
