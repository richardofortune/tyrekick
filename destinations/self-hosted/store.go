package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// Store wraps the SQLite database that replaces Workers KV. Records are kept
// as a JSON blob (the full FeedbackRecord, verbatim) alongside a handful of
// indexed columns used for filtering — mirroring the KV value/metadata split
// in worker.ts, but backed by real SQL instead of a two-phase list+fetch.
type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS feedback (
	id           TEXT PRIMARY KEY,
	created_at   TEXT NOT NULL,
	received_at  TEXT NOT NULL,
	project_name TEXT NOT NULL DEFAULT '',
	route        TEXT NOT NULL DEFAULT '',
	status       TEXT NOT NULL DEFAULT 'open',
	record       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_status     ON feedback(status);
CREATE INDEX IF NOT EXISTS idx_feedback_route      ON feedback(route);
CREATE INDEX IF NOT EXISTS idx_feedback_project    ON feedback(project_name);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

CREATE TABLE IF NOT EXISTS ai_counters (
	day   TEXT PRIMARY KEY,
	count INTEGER NOT NULL DEFAULT 0
);
`

// OpenStore opens (creating if needed) the SQLite database at path and
// applies the schema. The parent directory is created so a fresh volume
// mount (an empty /data) works without a manual `mkdir` step.
func OpenStore(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create db dir %q: %w", dir, err)
		}
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", path, err)
	}
	// A single connection sidesteps SQLITE_BUSY entirely (the pure-Go modernc
	// driver has no built-in busy retry loop). Traffic at this service's scale
	// never needs real concurrency inside the process.
	db.SetMaxOpenConns(1)

	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA busy_timeout=5000;",
		"PRAGMA foreign_keys=ON;",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("apply pragma %q: %w", pragma, err)
		}
	}

	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}

	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// SaveRecord inserts or updates a record, keeping the indexed columns in
// sync with the record's own fields (equivalent to worker.ts's saveRecord,
// which refreshes the KV metadata on every write).
func (s *Store) SaveRecord(r FeedbackRecord) error {
	raw, err := marshalRecord(r)
	if err != nil {
		return fmt.Errorf("marshal record: %w", err)
	}
	createdAt := r.createdAt()
	if createdAt == "" {
		createdAt = r.receivedAt()
	}
	_, err = s.db.Exec(
		`INSERT INTO feedback (id, created_at, received_at, project_name, route, status, record)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   created_at=excluded.created_at,
		   received_at=excluded.received_at,
		   project_name=excluded.project_name,
		   route=excluded.route,
		   status=excluded.status,
		   record=excluded.record`,
		r.id(), createdAt, r.receivedAt(), r.projectName(), r.route(), r.status(), raw,
	)
	if err != nil {
		return fmt.Errorf("save record: %w", err)
	}
	return nil
}

// LoadRecord returns the record for id, or (nil, nil) if it does not exist.
func (s *Store) LoadRecord(id string) (FeedbackRecord, error) {
	var raw string
	err := s.db.QueryRow(`SELECT record FROM feedback WHERE id = ?`, id).Scan(&raw)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load record: %w", err)
	}
	rec, err := unmarshalRecord(raw)
	if err != nil {
		return nil, nil // a corrupt value is treated the same as missing, per worker.ts
	}
	return rec, nil
}

// LoadRecords batch-loads records by id, silently omitting unknown ids —
// the /receipts capability-lookup contract.
func (s *Store) LoadRecords(ids []string) (map[string]FeedbackRecord, error) {
	out := make(map[string]FeedbackRecord, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	rows, err := s.db.Query(
		`SELECT id, record FROM feedback WHERE id IN (`+strings.Join(placeholders, ",")+`)`,
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("load records: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			return nil, fmt.Errorf("scan record: %w", err)
		}
		rec, err := unmarshalRecord(raw)
		if err != nil {
			continue // corrupt value: skip, same posture as LoadRecord
		}
		out[id] = rec
	}
	return out, rows.Err()
}

// ListFilter mirrors the query params accepted by GET /feedback.
type ListFilter struct {
	Status  string // "" = any
	Route   string // "" = any, exact match
	Project string // "" = any, exact match
	Since   string // "" = no lower bound, ISO-8601 (lexicographic compare)
	Limit   int
}

// ListFeedback returns one page of records (newest first) plus the total
// count matching the filter, ignoring Limit.
func (s *Store) ListFeedback(f ListFilter) (items []FeedbackRecord, total int, err error) {
	where, args := f.whereClause()

	countQuery := "SELECT COUNT(*) FROM feedback" + where
	if err := s.db.QueryRow(countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count feedback: %w", err)
	}

	listQuery := "SELECT record FROM feedback" + where + " ORDER BY created_at DESC LIMIT ?"
	rows, err := s.db.Query(listQuery, append(append([]interface{}{}, args...), f.Limit)...)
	if err != nil {
		return nil, 0, fmt.Errorf("list feedback: %w", err)
	}
	defer rows.Close()

	items = make([]FeedbackRecord, 0, f.Limit)
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, 0, fmt.Errorf("scan feedback: %w", err)
		}
		rec, err := unmarshalRecord(raw)
		if err != nil {
			continue
		}
		items = append(items, rec)
	}
	return items, total, rows.Err()
}

func (f ListFilter) whereClause() (string, []interface{}) {
	var clauses []string
	var args []interface{}
	if f.Status != "" {
		clauses = append(clauses, "status = ?")
		args = append(args, f.Status)
	}
	if f.Route != "" {
		clauses = append(clauses, "route = ?")
		args = append(args, f.Route)
	}
	if f.Project != "" {
		clauses = append(clauses, "project_name = ?")
		args = append(args, f.Project)
	}
	if f.Since != "" {
		clauses = append(clauses, "created_at >= ?")
		args = append(args, f.Since)
	}
	if len(clauses) == 0 {
		return "", args
	}
	return " WHERE " + strings.Join(clauses, " AND "), args
}

// ListByProject returns every record for one project_name, unordered. Used
// by GET /shared, which then does its own pathname-scoped filtering,
// numbering, and sorting in Go (see handleShared) — a local SQLite table is
// small enough per-project that this is simpler than pushing every nuance
// (route pathname matching, declined-but-numbered) into SQL.
func (s *Store) ListByProject(project string) ([]FeedbackRecord, error) {
	rows, err := s.db.Query(`SELECT record FROM feedback WHERE project_name = ?`, project)
	if err != nil {
		return nil, fmt.Errorf("list by project: %w", err)
	}
	defer rows.Close()

	var items []FeedbackRecord
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, fmt.Errorf("scan feedback: %w", err)
		}
		rec, err := unmarshalRecord(raw)
		if err != nil {
			continue
		}
		items = append(items, rec)
	}
	return items, rows.Err()
}

// UnderDailyCap reports whether today's AI-reply generation count is below
// cap. Mirrors worker.ts's underDailyCap: fails CLOSED (false) on any error,
// since "can't confirm we're under budget" must mean "don't spend".
func (s *Store) UnderDailyCap(day string, cap int) bool {
	var used int
	err := s.db.QueryRow(`SELECT count FROM ai_counters WHERE day = ?`, day).Scan(&used)
	if err == sql.ErrNoRows {
		return cap > 0
	}
	if err != nil {
		return false
	}
	return used < cap
}

// BumpDailyCounter increments today's AI-reply generation count by one.
// Best-effort: errors are the caller's problem to swallow, matching
// worker.ts's bumpDailyCounter (a miscount only ever lets a few extra
// replies through, never fewer).
func (s *Store) BumpDailyCounter(day string) error {
	_, err := s.db.Exec(
		`INSERT INTO ai_counters (day, count) VALUES (?, 1)
		 ON CONFLICT(day) DO UPDATE SET count = count + 1`,
		day,
	)
	return err
}
