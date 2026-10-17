// Command unify-syslog is a central syslog server optimised for Ubiquiti UniFi.
//
//	unify-syslog [serve]                          run the server
//	unify-syslog user add <name> [--admin]        create a local user (password from stdin or generated)
//	unify-syslog user passwd <name>               reset a password
//	unify-syslog update [--check]                 update to the latest GitHub release
//	unify-syslog simulate [--target 127.0.0.1:514] [--rate 200] [--duration 60s] [--sites 3]
//	unify-syslog version
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/rhisijmuiden/unify-syslog-server/internal/alerts"
	"github.com/rhisijmuiden/unify-syslog-server/internal/api"
	"github.com/rhisijmuiden/unify-syslog-server/internal/auth"
	"github.com/rhisijmuiden/unify-syslog-server/internal/backup"
	"github.com/rhisijmuiden/unify-syslog-server/internal/config"
	"github.com/rhisijmuiden/unify-syslog-server/internal/ingest"
	"github.com/rhisijmuiden/unify-syslog-server/internal/mail"
	"github.com/rhisijmuiden/unify-syslog-server/internal/simulate"
	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
	"github.com/rhisijmuiden/unify-syslog-server/internal/syslogd"
	"github.com/rhisijmuiden/unify-syslog-server/internal/update"
	"github.com/rhisijmuiden/unify-syslog-server/internal/version"
	"github.com/rhisijmuiden/unify-syslog-server/web"
)

func main() {
	cfgPath := os.Getenv("UNIFY_SYSLOG_CONFIG")
	if cfgPath == "" {
		cfgPath = config.DefaultPath
	}
	args := os.Args[1:]
	for i := 0; i < len(args); i++ {
		if (args[i] == "-c" || args[i] == "--config") && i+1 < len(args) {
			cfgPath = args[i+1]
			args = append(args[:i], args[i+2:]...)
			i--
		}
	}
	cmd := "serve"
	if len(args) > 0 {
		cmd = args[0]
		args = args[1:]
	}
	var err error
	switch cmd {
	case "serve":
		err = serve(cfgPath)
	case "user":
		err = userCmd(cfgPath, args)
	case "update":
		err = updateCmd(args)
	case "simulate":
		err = simulateCmd(args)
	case "version", "--version", "-v":
		fmt.Printf("unify-syslog %s (commit %s, built %s)\n", version.Version, version.Commit, version.BuildDate)
	default:
		err = fmt.Errorf("unknown command %q", cmd)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func serve(cfgPath string) error {
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	log.Info("starting", "version", version.Version, "config", cfgPath)
	meta, err := store.OpenMeta(cfg.MetaDBPath(), cfg.SecretKeyPath())
	if err != nil {
		return fmt.Errorf("metadata db: %w", err)
	}
	gen := meta.General()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	var logs *store.Logs
	for attempt := 1; ; attempt++ {
		logs, err = store.OpenLogs(ctx, cfg.ClickHouse, gen.RetentionDays)
		if err == nil {
			break
		}
		if attempt >= 30 || ctx.Err() != nil {
			return fmt.Errorf("clickhouse: %w", err)
		}
		log.Warn("waiting for clickhouse", "err", err)
		time.Sleep(2 * time.Second)
	}

	var loc atomic.Pointer[time.Location]
	setLoc := func(tz string) {
		l, err := time.LoadLocation(tz)
		if err != nil {
			l = time.Local
		}
		loc.Store(l)
	}
	setLoc(gen.Timezone)
	getLoc := func() *time.Location { return loc.Load() }

	queue := make(chan syslogd.Message, cfg.Ingest.QueueSize)
	sysStats := &syslogd.Stats{}
	ingStats := &ingest.Stats{}
	srv := &syslogd.Server{UDPAddr: cfg.Syslog.UDP, TCPAddr: cfg.Syslog.TCP, ReadBuf: cfg.Syslog.UDPReadBuffer, Out: queue, Stats: sysStats, Log: log}
	pipe := &ingest.Pipeline{In: queue, Meta: meta, Logs: logs, Workers: cfg.Ingest.Workers, BatchSize: cfg.Ingest.BatchSize,
		Flush: time.Duration(cfg.Ingest.FlushInterval) * time.Millisecond, Location: getLoc, Stats: ingStats, Log: log}

	restart := func() {
		log.Info("restart requested")
		stop()
		go func() {
			time.Sleep(10 * time.Second)
			os.Exit(0)
		}()
	}
	mailer := &mail.Mailer{Meta: meta}
	bk := &backup.Manager{Meta: meta, Logs: logs, Mailer: mailer, Dir: cfg.BackupDir(), KeyPath: cfg.SecretKeyPath(), Log: log, Restart: restart}
	al := &alerts.Engine{Meta: meta, Logs: logs, Mailer: mailer, Log: log}
	apiSrv := &api.Server{Cfg: cfg, Meta: meta, Logs: logs, Mailer: mailer, Backup: bk, Updater: update.New(), Entra: &auth.Entra{Meta: meta},
		Alerts: al, Pipeline: pipe, SysStats: sysStats, IngStats: ingStats, UI: web.Dist(), Log: log, Started: time.Now(), Restart: restart,
		OnSettings: func(g store.GeneralSettings) { setLoc(g.Timezone) }}

	httpSrv := &http.Server{Addr: cfg.HTTPListen, Handler: apiSrv.Handler(), ReadHeaderTimeout: 10 * time.Second}

	errc := make(chan error, 2)
	go func() { errc <- srv.Run(ctx) }()
	pipeDone := make(chan struct{})
	go func() { pipe.Run(ctx); close(pipeDone) }()
	go bk.Scheduler(ctx, getLoc)
	go al.Run(ctx)
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				meta.PurgeSessions()
			}
		}
	}()
	go func() {
		log.Info("web interface listening", "addr", cfg.HTTPListen)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err = <-errc:
		if err != nil {
			log.Error("fatal", "err", err)
		}
		stop()
	}
	sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	httpSrv.Shutdown(sctx)
	select {
	case <-pipeDone:
	case <-sctx.Done():
	}
	log.Info("stopped")
	return err
}

func userCmd(cfgPath string, args []string) error {
	if len(args) < 2 {
		return errors.New("usage: user add <name> [--admin] [--password X] | user passwd <name> [--password X]")
	}
	fs := flag.NewFlagSet("user", flag.ContinueOnError)
	admin := fs.Bool("admin", false, "grant admin role")
	pw := fs.String("password", "", "password (default: read from stdin, or generate when stdin is empty)")
	sub, name := args[0], args[1]
	if err := fs.Parse(args[2:]); err != nil {
		return err
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	meta, err := store.OpenMeta(cfg.MetaDBPath(), cfg.SecretKeyPath())
	if err != nil {
		return err
	}
	password := *pw
	generated := false
	if password == "" {
		if st, _ := os.Stdin.Stat(); st.Mode()&os.ModeCharDevice == 0 {
			line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
			password = strings.TrimSpace(line)
		}
		if password == "" {
			password = store.RandomToken(8)
			generated = true
		}
	}
	switch sub {
	case "add":
		role := "viewer"
		if *admin {
			role = "admin"
		}
		u := &store.User{Username: name, Role: role, Provider: "local"}
		if err := meta.CreateUser(u, password); err != nil {
			return err
		}
	case "passwd":
		u, err := meta.UserByName(name)
		if err != nil {
			return fmt.Errorf("user %s not found", name)
		}
		if err := meta.SetPassword(u.ID, password); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown user command %q", sub)
	}
	if generated {
		fmt.Println(password)
	}
	return nil
}

func updateCmd(args []string) error {
	u := update.New()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	res, err := u.Check(ctx, false)
	if err != nil {
		return err
	}
	fmt.Printf("current %s, latest %s\n", res.Current, res.Latest)
	if len(args) > 0 && args[0] == "--check" {
		return nil
	}
	if !res.Available {
		fmt.Println("already up to date")
		return nil
	}
	if err := u.Apply(ctx, false, nil); err != nil {
		return err
	}
	fmt.Println("installed; restart the service: systemctl restart unify-syslog")
	return nil
}

func simulateCmd(args []string) error {
	fs := flag.NewFlagSet("simulate", flag.ContinueOnError)
	target := fs.String("target", "127.0.0.1:514", "syslog server address (UDP)")
	rate := fs.Int("rate", 200, "messages per second")
	dur := fs.Duration("duration", time.Minute, "how long to send")
	sites := fs.Int("sites", 3, "number of simulated locations")
	if err := fs.Parse(args); err != nil {
		return err
	}
	return simulate.Run(*target, *rate, *dur, *sites, func(s string) { fmt.Println(s) })
}
