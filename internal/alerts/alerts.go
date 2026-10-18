// Package alerts evaluates user-defined alert rules (a search query plus a
// threshold within a time window) and sends e-mail when they fire.
package alerts

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rhisijmuiden/unify-syslog-server/internal/mail"
	"github.com/rhisijmuiden/unify-syslog-server/internal/store"
)

type Engine struct {
	Meta   *store.Meta
	Logs   *store.Logs
	Mailer *mail.Mailer
	Log    *slog.Logger

	// Started is when the server came up; silent-device checks wait one
	// silence window after it.
	Started time.Time
}

func (e *Engine) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			e.evaluate(ctx, now)
			e.checkDevices(ctx, now)
		}
	}
}

func (e *Engine) evaluate(ctx context.Context, now time.Time) {
	rules, err := e.Meta.AlertRules()
	if err != nil {
		return
	}
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		if r.LastFired > 0 && now.Sub(time.Unix(r.LastFired, 0)) < time.Duration(max(r.CooldownMinutes, 1))*time.Minute {
			continue
		}
		req := store.SearchReq{Query: r.Query, From: now.Add(-time.Duration(r.WindowMinutes) * time.Minute), To: now}
		qctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		n, err := e.Logs.Count(qctx, req)
		cancel()
		if err != nil {
			e.Log.Warn("alert rule", "rule", r.Name, "err", err)
			continue
		}
		if n < uint64(r.Threshold) {
			continue
		}
		e.Meta.MarkAlertFired(r.ID, now)
		e.fire(ctx, r, n, req)
	}
}

func (e *Engine) fire(ctx context.Context, r store.AlertRule, n uint64, req store.SearchReq) {
	e.Log.Info("alert fired", "rule", r.Name, "count", n)
	if e.Mailer == nil || !e.Mailer.Configured() {
		return
	}
	req.Limit = 15
	rows, _ := e.Logs.Search(ctx, req)
	var b strings.Builder
	fmt.Fprintf(&b, "Rule: %s\nQuery: %s\nCount: %d in the last %d minutes (threshold %d)\n\nLatest events:\n", r.Name, r.Query, n, r.WindowMinutes, r.Threshold)
	for _, x := range rows {
		fmt.Fprintf(&b, "%s  %-15s %-10s %s\n", x.TS.Local().Format("2006-01-02 15:04:05"), x.Hostname, x.Category, x.Message)
	}
	mctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	if err := e.Mailer.Send(mctx, []string{r.Recipients}, "Alert: "+r.Name, b.String()); err != nil {
		e.Log.Warn("alert mail", "err", err)
	}
}
