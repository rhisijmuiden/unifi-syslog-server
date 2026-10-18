package store

import (
	"regexp"
	"strings"
	"testing"
)

// Rolling back to an older version keeps the ClickHouse data as it is, so
// schema changes may only add: no drops, renames or type changes.
func TestLogSchemaIsAdditive(t *testing.T) {
	l := &Logs{db: "unify_syslog"}
	allowed := regexp.MustCompile(`^(CREATE (DATABASE|TABLE|MATERIALIZED VIEW) IF NOT EXISTS|ALTER TABLE \S+ ADD COLUMN IF NOT EXISTS)\b`)
	forbidden := regexp.MustCompile(`(?i)\b(DROP|RENAME|MODIFY COLUMN|CLEAR COLUMN|TRUNCATE)\b`)
	for _, s := range l.schema(90) {
		s = strings.TrimSpace(s)
		if !allowed.MatchString(s) || forbidden.MatchString(s) {
			t.Errorf("schema statement is not additive:\n%s", s)
		}
	}
}
