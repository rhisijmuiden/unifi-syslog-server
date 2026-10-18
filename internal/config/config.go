// Package config loads the static bootstrap configuration from YAML.
// Everything that can be changed from the web UI lives in the settings
// table of the metadata database instead.
package config

import (
	"fmt"
	"os"
	"path/filepath"

	"gopkg.in/yaml.v3"
)

const DefaultPath = "/etc/unify-syslog/config.yaml"

type Config struct {
	HTTPListen string `yaml:"http_listen"`
	// TLSCert and TLSKey replace the self-signed certificate the web port
	// also serves HTTPS with (used by remote probes).
	TLSCert    string     `yaml:"tls_cert"`
	TLSKey     string     `yaml:"tls_key"`
	DataDir    string     `yaml:"data_dir"`
	Syslog     Syslog     `yaml:"syslog"`
	ClickHouse ClickHouse `yaml:"clickhouse"`
	Ingest     Ingest     `yaml:"ingest"`
}

type Syslog struct {
	UDP string `yaml:"udp"`
	TCP string `yaml:"tcp"`
	// Size of the kernel receive buffer requested for the UDP socket.
	UDPReadBuffer int `yaml:"udp_read_buffer"`
}

type ClickHouse struct {
	Addr     string `yaml:"addr"`     // native protocol, host:9000
	HTTPURL  string `yaml:"http_url"` // http interface, used for backup export/import
	Database string `yaml:"database"`
	Username string `yaml:"username"`
	Password string `yaml:"password"`
}

type Ingest struct {
	QueueSize     int `yaml:"queue_size"`
	Workers       int `yaml:"workers"`
	BatchSize     int `yaml:"batch_size"`
	FlushInterval int `yaml:"flush_interval_ms"`
}

func Default() *Config {
	return &Config{
		HTTPListen: ":8080",
		DataDir:    "/var/lib/unify-syslog",
		Syslog:     Syslog{UDP: ":514", TCP: ":514", UDPReadBuffer: 8 << 20},
		ClickHouse: ClickHouse{
			Addr:     "127.0.0.1:9000",
			HTTPURL:  "http://127.0.0.1:8123",
			Database: "unify_syslog",
			Username: "default",
		},
		Ingest: Ingest{QueueSize: 200000, Workers: 4, BatchSize: 20000, FlushInterval: 1000},
	}
}

func Load(path string) (*Config, error) {
	cfg := Default()
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return nil, err
	}
	if err := yaml.Unmarshal(b, cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if v := os.Getenv("UNIFY_SYSLOG_HTTP"); v != "" {
		cfg.HTTPListen = v
	}
	return cfg, nil
}

func (c *Config) MetaDBPath() string    { return filepath.Join(c.DataDir, "meta.db") }
func (c *Config) BackupDir() string     { return filepath.Join(c.DataDir, "backups") }
func (c *Config) SecretKeyPath() string { return filepath.Join(c.DataDir, "secret.key") }
