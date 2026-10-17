package store

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/rhisijmuiden/unify-syslog-server/internal/config"
	"github.com/rhisijmuiden/unify-syslog-server/internal/query"
	"github.com/rhisijmuiden/unify-syslog-server/internal/unifi"
)

type Logs struct {
	Conn driver.Conn
	cfg  config.ClickHouse
	db   string
}

func OpenLogs(ctx context.Context, cfg config.ClickHouse, retentionDays int) (*Logs, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{cfg.Addr},
		Auth: clickhouse.Auth{Database: "default", Username: cfg.Username, Password: cfg.Password},
		Compression: &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
		DialTimeout:     10 * time.Second,
		MaxOpenConns:    16,
		ConnMaxLifetime: time.Hour,
		Settings:        clickhouse.Settings{"max_execution_time": 120},
	})
	if err != nil {
		return nil, err
	}
	if err := conn.Ping(ctx); err != nil {
		return nil, fmt.Errorf("clickhouse ping: %w", err)
	}
	l := &Logs{Conn: conn, cfg: cfg, db: cfg.Database}
	if err := l.migrate(ctx, retentionDays); err != nil {
		return nil, err
	}
	return l, nil
}

func (l *Logs) t(name string) string { return "`" + l.db + "`." + name }

func (l *Logs) migrate(ctx context.Context, retention int) error {
	if retention <= 0 {
		retention = 90
	}
	stmts := []string{
		"CREATE DATABASE IF NOT EXISTS `" + l.db + "`",
		`CREATE TABLE IF NOT EXISTS ` + l.t("logs") + ` (
			ts DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
			received DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
			source_ip LowCardinality(String),
			site LowCardinality(String),
			hostname LowCardinality(String),
			device_model LowCardinality(String),
			device_mac LowCardinality(String),
			device_version LowCardinality(String),
			facility UInt8,
			severity UInt8,
			app LowCardinality(String),
			pid String CODEC(ZSTD(1)),
			category LowCardinality(String),
			event_type LowCardinality(String),
			action LowCardinality(String),
			rule LowCardinality(String),
			src_ip String CODEC(ZSTD(1)),
			dst_ip String CODEC(ZSTD(1)),
			src_port UInt16,
			dst_port UInt16,
			proto LowCardinality(String),
			in_if LowCardinality(String),
			out_if LowCardinality(String),
			client_mac String CODEC(ZSTD(1)),
			client_name String CODEC(ZSTD(1)),
			client_ip String CODEC(ZSTD(1)),
			ssid LowCardinality(String),
			message String CODEC(ZSTD(3)),
			raw String CODEC(ZSTD(3)),
			fields Map(LowCardinality(String), String) CODEC(ZSTD(3)),
			INDEX idx_msg lower(message) TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
			INDEX idx_src src_ip TYPE bloom_filter(0.01) GRANULARITY 4,
			INDEX idx_dst dst_ip TYPE bloom_filter(0.01) GRANULARITY 4,
			INDEX idx_cmac client_mac TYPE bloom_filter(0.01) GRANULARITY 4,
			INDEX idx_cip client_ip TYPE bloom_filter(0.01) GRANULARITY 4,
			INDEX idx_dport dst_port TYPE set(1000) GRANULARITY 4
		) ENGINE = MergeTree
		PARTITION BY toYYYYMMDD(ts)
		ORDER BY (site, category, ts)
		TTL toDateTime(ts) + INTERVAL ` + fmt.Sprint(retention) + ` DAY DELETE
		SETTINGS index_granularity = 8192, ttl_only_drop_parts = 1`,
		`CREATE TABLE IF NOT EXISTS ` + l.t("logs_hourly") + ` (
			hour DateTime('UTC'),
			site LowCardinality(String),
			category LowCardinality(String),
			action LowCardinality(String),
			severity UInt8,
			source_ip LowCardinality(String),
			cnt UInt64
		) ENGINE = SummingMergeTree(cnt)
		PARTITION BY toYYYYMM(hour)
		ORDER BY (hour, site, category, action, severity, source_ip)
		TTL hour + INTERVAL 400 DAY DELETE`,
		`CREATE MATERIALIZED VIEW IF NOT EXISTS ` + l.t("logs_hourly_mv") + ` TO ` + l.t("logs_hourly") + ` AS
			SELECT toStartOfHour(ts) AS hour, site, category, action, severity, source_ip, count() AS cnt
			FROM ` + l.t("logs") + ` GROUP BY hour, site, category, action, severity, source_ip`,
	}
	for _, s := range stmts {
		if err := l.Conn.Exec(ctx, s); err != nil {
			return fmt.Errorf("migrate: %w", err)
		}
	}
	return nil
}

func (l *Logs) SetRetention(ctx context.Context, days int) error {
	if days < 1 {
		return fmt.Errorf("retentie moet minimaal 1 dag zijn")
	}
	return l.Conn.Exec(ctx, fmt.Sprintf("ALTER TABLE %s MODIFY TTL toDateTime(ts) + INTERVAL %d DAY DELETE", l.t("logs"), days))
}

func (l *Logs) Insert(ctx context.Context, evs []*unifi.Event) error {
	b, err := l.Conn.PrepareBatch(ctx, "INSERT INTO "+l.t("logs"))
	if err != nil {
		return err
	}
	for _, e := range evs {
		f := e.Fields
		if f == nil {
			f = map[string]string{}
		}
		if err := b.Append(e.TS, e.Received, e.SourceIP, e.Site, e.Hostname, e.DeviceModel, e.DeviceMAC, e.DeviceVersion,
			e.Facility, e.Severity, e.App, e.PID, e.Category, e.EventType, e.Action, e.Rule,
			e.SrcIP, e.DstIP, e.SrcPort, e.DstPort, e.Proto, e.InIf, e.OutIf,
			e.ClientMAC, e.ClientName, e.ClientIP, e.SSID, e.Message, e.Raw, f); err != nil {
			b.Abort()
			return err
		}
	}
	return b.Send()
}

// ---------------------------------------------------------------- search

type SearchReq struct {
	Query  string    `json:"query"`
	From   time.Time `json:"from"`
	To     time.Time `json:"to"`
	Sites  []string  `json:"sites"`
	Limit  int       `json:"limit"`
	Before time.Time `json:"before"` // keyset pagination: rows strictly older
	// AfterReceived limits to rows received after this instant (live tail).
	AfterReceived time.Time `json:"-"`
	Asc    bool      `json:"asc"`
}

type Row struct {
	TS            time.Time         `json:"ts"`
	Received      time.Time         `json:"received"`
	SourceIP      string            `json:"source_ip"`
	Site          string            `json:"site"`
	Hostname      string            `json:"hostname"`
	DeviceModel   string            `json:"device_model"`
	DeviceMAC     string            `json:"device_mac"`
	DeviceVersion string            `json:"device_version"`
	Facility      uint8             `json:"facility"`
	Severity      uint8             `json:"severity"`
	App           string            `json:"app"`
	Category      string            `json:"category"`
	EventType     string            `json:"event_type"`
	Action        string            `json:"action"`
	Rule          string            `json:"rule"`
	SrcIP         string            `json:"src_ip"`
	DstIP         string            `json:"dst_ip"`
	SrcPort       uint16            `json:"src_port"`
	DstPort       uint16            `json:"dst_port"`
	Proto         string            `json:"proto"`
	InIf          string            `json:"in_if"`
	OutIf         string            `json:"out_if"`
	ClientMAC     string            `json:"client_mac"`
	ClientName    string            `json:"client_name"`
	ClientIP      string            `json:"client_ip"`
	SSID          string            `json:"ssid"`
	Message       string            `json:"message"`
	Raw           string            `json:"raw"`
	Fields        map[string]string `json:"fields"`
}

func RowFromEvent(e *unifi.Event) Row {
	return Row{TS: e.TS, Received: e.Received, SourceIP: e.SourceIP, Site: e.Site, Hostname: e.Hostname, DeviceModel: e.DeviceModel,
		DeviceMAC: e.DeviceMAC, DeviceVersion: e.DeviceVersion, Facility: e.Facility, Severity: e.Severity, App: e.App,
		Category: e.Category, EventType: e.EventType, Action: e.Action, Rule: e.Rule, SrcIP: e.SrcIP, DstIP: e.DstIP,
		SrcPort: e.SrcPort, DstPort: e.DstPort, Proto: e.Proto, InIf: e.InIf, OutIf: e.OutIf, ClientMAC: e.ClientMAC,
		ClientName: e.ClientName, ClientIP: e.ClientIP, SSID: e.SSID, Message: e.Message, Raw: e.Raw, Fields: e.Fields}
}

const rowCols = `ts, received, source_ip, site, hostname, device_model, device_mac, device_version, facility, severity, app,
	category, event_type, action, rule, src_ip, dst_ip, src_port, dst_port, proto, in_if, out_if,
	client_mac, client_name, client_ip, ssid, message, raw, fields`

func (l *Logs) where(r SearchReq) (string, []any, error) {
	f, err := query.Compile(r.Query)
	if err != nil {
		return "", nil, err
	}
	w := []string{"ts >= ?", "ts <= ?", f.Where}
	args := []any{r.From, r.To}
	args = append(args, f.Args...)
	if len(r.Sites) > 0 {
		w = append(w, "site IN ?")
		args = append(args, r.Sites)
	}
	if !r.AfterReceived.IsZero() {
		w = append(w, "received > ?")
		args = append(args, r.AfterReceived)
	}
	return strings.Join(w, " AND "), args, nil
}

func (l *Logs) Search(ctx context.Context, r SearchReq) ([]Row, error) {
	if r.Limit <= 0 || r.Limit > 5000 {
		r.Limit = 200
	}
	w, args, err := l.where(r)
	if err != nil {
		return nil, err
	}
	if !r.Before.IsZero() {
		w += " AND ts < ?"
		args = append(args, r.Before)
	}
	order := "DESC"
	if r.Asc {
		order = "ASC"
	}
	rows, err := l.Conn.Query(ctx, fmt.Sprintf("SELECT %s FROM %s WHERE %s ORDER BY ts %s LIMIT %d", rowCols, l.t("logs"), w, order, r.Limit), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var x Row
		if err := rows.Scan(&x.TS, &x.Received, &x.SourceIP, &x.Site, &x.Hostname, &x.DeviceModel, &x.DeviceMAC, &x.DeviceVersion,
			&x.Facility, &x.Severity, &x.App, &x.Category, &x.EventType, &x.Action, &x.Rule, &x.SrcIP, &x.DstIP,
			&x.SrcPort, &x.DstPort, &x.Proto, &x.InIf, &x.OutIf, &x.ClientMAC, &x.ClientName, &x.ClientIP, &x.SSID,
			&x.Message, &x.Raw, &x.Fields); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

type Bucket struct {
	T     time.Time `json:"t"`
	Key   string    `json:"key"`
	Count uint64    `json:"count"`
}

// BucketSeconds picks a histogram resolution giving ~120 buckets.
func BucketSeconds(from, to time.Time) int {
	span := to.Sub(from).Seconds()
	for _, s := range []int{10, 30, 60, 300, 600, 1800, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 86400} {
		if span/float64(s) <= 150 {
			return s
		}
	}
	return 86400
}

// Histogram returns counts per time bucket, split by groupBy (a column name
// from a fixed allow-list) when given.
func (l *Logs) Histogram(ctx context.Context, r SearchReq, groupBy string) ([]Bucket, int, error) {
	w, args, err := l.where(r)
	if err != nil {
		return nil, 0, err
	}
	g := "''"
	switch groupBy {
	case "category", "severity", "site", "action", "hostname", "app":
		g = "toString(" + groupBy + ")"
	}
	step := BucketSeconds(r.From, r.To)
	q := fmt.Sprintf("SELECT toStartOfInterval(ts, INTERVAL %d SECOND) AS b, %s AS k, count() FROM %s WHERE %s GROUP BY b, k ORDER BY b", step, g, l.t("logs"), w)
	rows, err := l.Conn.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []Bucket{}
	for rows.Next() {
		var b Bucket
		var t time.Time
		if err := rows.Scan(&t, &b.Key, &b.Count); err != nil {
			return nil, 0, err
		}
		b.T = t
		out = append(out, b)
	}
	return out, step, rows.Err()
}

func (l *Logs) Count(ctx context.Context, r SearchReq) (uint64, error) {
	w, args, err := l.where(r)
	if err != nil {
		return 0, err
	}
	var n uint64
	err = l.Conn.QueryRow(ctx, fmt.Sprintf("SELECT count() FROM %s WHERE %s", l.t("logs"), w), args...).Scan(&n)
	return n, err
}

type TopItem struct {
	Key   string `json:"key"`
	Label string `json:"label,omitempty"`
	Count uint64 `json:"count"`
}

var topCols = map[string]string{
	"src_ip": "src_ip", "dst_ip": "dst_ip", "dst_port": "toString(dst_port)", "rule": "rule", "client_mac": "client_mac",
	"client_name": "client_name", "ssid": "ssid", "hostname": "hostname", "source_ip": "source_ip", "app": "app",
	"event_type": "event_type", "category": "category", "site": "site", "proto": "proto", "action": "action",
	"severity": "toString(severity)", "device_model": "device_model",
}

func (l *Logs) Top(ctx context.Context, r SearchReq, field string, n int) ([]TopItem, error) {
	c, ok := topCols[field]
	if !ok {
		return nil, fmt.Errorf("unknown field %q", field)
	}
	w, args, err := l.where(r)
	if err != nil {
		return nil, err
	}
	if n <= 0 || n > 100 {
		n = 10
	}
	q := fmt.Sprintf("SELECT %s AS k, count() AS c FROM %s WHERE %s AND k != '' AND k != '0' GROUP BY k ORDER BY c DESC LIMIT %d", c, l.t("logs"), w, n)
	rows, err := l.Conn.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TopItem{}
	for rows.Next() {
		var t TopItem
		if err := rows.Scan(&t.Key, &t.Count); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ---------------------------------------------------------------- dashboard (pre-aggregated)

type Overview struct {
	Total      uint64            `json:"total"`
	Blocked    uint64            `json:"blocked"`
	Threats    uint64            `json:"threats"`
	Errors     uint64            `json:"errors"`
	ByCategory []TopItem         `json:"by_category"`
	BySite     []TopItem         `json:"by_site"`
	BySeverity []TopItem         `json:"by_severity"`
	Timeline   []Bucket          `json:"timeline"`
	StepSec    int               `json:"step_sec"`
	Extra      map[string]uint64 `json:"extra,omitempty"`
}

func (l *Logs) Overview(ctx context.Context, from, to time.Time, sites []string) (*Overview, error) {
	w := "hour >= toStartOfHour(?) AND hour <= ?"
	args := []any{from, to}
	if len(sites) > 0 {
		w += " AND site IN ?"
		args = append(args, sites)
	}
	o := &Overview{}
	if err := l.Conn.QueryRow(ctx, fmt.Sprintf(`SELECT sum(cnt), sumIf(cnt, action IN ('block','reject')), sumIf(cnt, category='ips'), sumIf(cnt, severity<=3) FROM %s WHERE %s`, l.t("logs_hourly"), w), args...).
		Scan(&o.Total, &o.Blocked, &o.Threats, &o.Errors); err != nil {
		return nil, err
	}
	agg := func(col string) ([]TopItem, error) {
		rows, err := l.Conn.Query(ctx, fmt.Sprintf("SELECT toString(%s) AS k, sum(cnt) AS c FROM %s WHERE %s GROUP BY k ORDER BY c DESC", col, l.t("logs_hourly"), w), args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := []TopItem{}
		for rows.Next() {
			var t TopItem
			if err := rows.Scan(&t.Key, &t.Count); err != nil {
				return nil, err
			}
			out = append(out, t)
		}
		return out, rows.Err()
	}
	var err error
	if o.ByCategory, err = agg("category"); err != nil {
		return nil, err
	}
	if o.BySite, err = agg("site"); err != nil {
		return nil, err
	}
	if o.BySeverity, err = agg("severity"); err != nil {
		return nil, err
	}
	step := 3600
	span := to.Sub(from)
	if span > 8*24*time.Hour {
		step = 6 * 3600
	}
	if span > 40*24*time.Hour {
		step = 86400
	}
	o.StepSec = step
	rows, err := l.Conn.Query(ctx, fmt.Sprintf("SELECT toStartOfInterval(hour, INTERVAL %d SECOND) AS b, toString(category) AS k, sum(cnt) FROM %s WHERE %s GROUP BY b, k ORDER BY b", step, l.t("logs_hourly"), w), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var b Bucket
		if err := rows.Scan(&b.T, &b.Key, &b.Count); err != nil {
			return nil, err
		}
		o.Timeline = append(o.Timeline, b)
	}
	return o, rows.Err()
}

// ---------------------------------------------------------------- storage info

type StorageInfo struct {
	Rows           uint64    `json:"rows"`
	BytesOnDisk    uint64    `json:"bytes_on_disk"`
	BytesRaw       uint64    `json:"bytes_uncompressed"`
	Oldest         time.Time `json:"oldest"`
	Newest         time.Time `json:"newest"`
	Partitions     uint64    `json:"partitions"`
	ClickHouseVers string    `json:"clickhouse_version"`
}

func (l *Logs) Storage(ctx context.Context) (*StorageInfo, error) {
	s := &StorageInfo{}
	err := l.Conn.QueryRow(ctx, `SELECT sum(rows), sum(bytes_on_disk), sum(data_uncompressed_bytes), uniqExact(partition)
		FROM system.parts WHERE active AND database = ? AND table = 'logs'`, l.db).Scan(&s.Rows, &s.BytesOnDisk, &s.BytesRaw, &s.Partitions)
	if err != nil {
		return nil, err
	}
	if s.Rows > 0 {
		l.Conn.QueryRow(ctx, "SELECT min(ts), max(ts) FROM "+l.t("logs")).Scan(&s.Oldest, &s.Newest)
	}
	l.Conn.QueryRow(ctx, "SELECT version()").Scan(&s.ClickHouseVers)
	return s, nil
}

func (l *Logs) MaxReceived(ctx context.Context) (time.Time, error) {
	var t time.Time
	err := l.Conn.QueryRow(ctx, "SELECT max(received) FROM "+l.t("logs")).Scan(&t)
	return t, err
}

// ---------------------------------------------------------------- backup helpers (HTTP interface)

func (l *Logs) httpReq(ctx context.Context, q string, body io.Reader) (*http.Response, error) {
	u, err := url.Parse(l.cfg.HTTPURL)
	if err != nil {
		return nil, err
	}
	v := url.Values{}
	v.Set("query", q)
	v.Set("database", l.db)
	v.Set("enable_http_compression", "1")
	u.RawQuery = v.Encode()
	method := http.MethodGet
	if body != nil {
		method = http.MethodPost
	}
	req, err := http.NewRequestWithContext(ctx, method, u.String(), body)
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(l.cfg.Username, l.cfg.Password)
	if body != nil {
		req.Header.Set("Content-Encoding", "gzip")
	} else {
		// Set explicitly so Go hands us the gzip stream untouched.
		req.Header.Set("Accept-Encoding", "gzip")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
		return nil, fmt.Errorf("clickhouse http %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return resp, nil
}

// Export streams rows with received in (after, until] as gzip-compressed
// ClickHouse Native format to w.
func (l *Logs) Export(ctx context.Context, w io.Writer, after, until time.Time) (int64, error) {
	q := fmt.Sprintf("SELECT * FROM logs WHERE received > toDateTime64('%s', 3, 'UTC') AND received <= toDateTime64('%s', 3, 'UTC') FORMAT Native",
		after.UTC().Format("2006-01-02 15:04:05.000"), until.UTC().Format("2006-01-02 15:04:05.000"))
	resp, err := l.httpReq(ctx, q, nil)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	return io.Copy(w, resp.Body)
}

// Import loads a gzip-compressed Native stream produced by Export.
func (l *Logs) Import(ctx context.Context, r io.Reader) error {
	resp, err := l.httpReq(ctx, "INSERT INTO logs FORMAT Native", r)
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

func (l *Logs) Truncate(ctx context.Context) error {
	if err := l.Conn.Exec(ctx, "TRUNCATE TABLE "+l.t("logs")); err != nil {
		return err
	}
	return l.Conn.Exec(ctx, "TRUNCATE TABLE "+l.t("logs_hourly"))
}

func (l *Logs) CountReceivedBetween(ctx context.Context, after, until time.Time) (uint64, error) {
	var n uint64
	err := l.Conn.QueryRow(ctx, "SELECT count() FROM "+l.t("logs")+" WHERE received > ? AND received <= ?", after, until).Scan(&n)
	return n, err
}

type Device struct {
	Hostname string    `json:"hostname"`
	Model    string    `json:"model"`
	MAC      string    `json:"mac"`
	Version  string    `json:"version"`
	SourceIP string    `json:"source_ip"`
	Site     string    `json:"site"`
	LastSeen time.Time `json:"last_seen"`
	Count    uint64    `json:"count"`
	Errors   uint64    `json:"errors"`
}

// Devices lists UniFi devices (gateways, APs, switches) seen in the window.
func (l *Logs) Devices(ctx context.Context, from time.Time) ([]Device, error) {
	rows, err := l.Conn.Query(ctx, `SELECT hostname, anyLast(device_model), device_mac, anyLast(device_version), anyLast(source_ip), anyLast(site), max(ts), count(), countIf(severity <= 3)
		FROM `+l.t("logs")+` WHERE ts >= ? GROUP BY hostname, device_mac ORDER BY hostname LIMIT 2000`, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Device{}
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.Hostname, &d.Model, &d.MAC, &d.Version, &d.SourceIP, &d.Site, &d.LastSeen, &d.Count, &d.Errors); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}
