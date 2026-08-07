package main

import (
	"path/filepath"
	"testing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := OpenStore(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func rec(id string, fields map[string]interface{}) FeedbackRecord {
	r := FeedbackRecord{
		"id":         id,
		"schema":     float64(2),
		"created_at": "2026-01-01T00:00:00.000Z",
		"status":     "open",
		"body":       "a comment",
	}
	for k, v := range fields {
		r[k] = v
	}
	return r
}

func TestSaveAndLoadRecordRoundTrips(t *testing.T) {
	s := newTestStore(t)
	in := rec("id-1", map[string]interface{}{
		"project_name": "p",
		"anchor":       map[string]interface{}{"x_pct": float64(10)},
		"page_errors":  []interface{}{"boom"}, // v2-only field must survive verbatim
	})
	if err := s.SaveRecord(in); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	out, err := s.LoadRecord("id-1")
	if err != nil {
		t.Fatalf("LoadRecord: %v", err)
	}
	if out == nil {
		t.Fatal("LoadRecord returned nil for a record just saved")
	}
	if got := out.body(); got != "a comment" {
		t.Errorf("body = %q, want %q", got, "a comment")
	}
	errs, ok := out["page_errors"].([]interface{})
	if !ok || len(errs) != 1 || errs[0] != "boom" {
		t.Errorf("page_errors did not survive the round trip: %#v", out["page_errors"])
	}
}

func TestLoadRecordMissingIsNilNotError(t *testing.T) {
	s := newTestStore(t)
	out, err := s.LoadRecord("nope")
	if err != nil {
		t.Fatalf("LoadRecord: unexpected error %v", err)
	}
	if out != nil {
		t.Errorf("LoadRecord = %#v, want nil for an unknown id", out)
	}
}

func TestSaveRecordUpsertsRatherThanDuplicating(t *testing.T) {
	s := newTestStore(t)
	r := rec("id-1", nil)
	if err := s.SaveRecord(r); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	r["status"] = "resolved"
	if err := s.SaveRecord(r); err != nil {
		t.Fatalf("SaveRecord (update): %v", err)
	}
	_, total, err := s.ListFeedback(ListFilter{Limit: 10})
	if err != nil {
		t.Fatalf("ListFeedback: %v", err)
	}
	if total != 1 {
		t.Errorf("total = %d, want 1 (the second save must update, not insert)", total)
	}
	out, _ := s.LoadRecord("id-1")
	if out.status() != "resolved" {
		t.Errorf("status = %q, want %q", out.status(), "resolved")
	}
}

func TestSaveRecordFallsBackToReceivedAtForOrdering(t *testing.T) {
	s := newTestStore(t)
	r := FeedbackRecord{"id": "id-1", "body": "x", "status": "open", "received_at": "2026-05-05T00:00:00.000Z"}
	if err := s.SaveRecord(r); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	// A record with no created_at must still be reachable by a `since` filter
	// keyed on its received_at, not silently sort as the epoch.
	items, _, err := s.ListFeedback(ListFilter{Since: "2026-05-01T00:00:00.000Z", Limit: 10})
	if err != nil {
		t.Fatalf("ListFeedback: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("got %d items, want 1 — created_at should fall back to received_at", len(items))
	}
}

func TestListFeedbackFilters(t *testing.T) {
	s := newTestStore(t)
	seed := []FeedbackRecord{
		rec("a", map[string]interface{}{"status": "open", "route": "/x", "project_name": "p1", "created_at": "2026-01-01T00:00:00.000Z"}),
		rec("b", map[string]interface{}{"status": "resolved", "route": "/x", "project_name": "p1", "created_at": "2026-02-01T00:00:00.000Z"}),
		rec("c", map[string]interface{}{"status": "open", "route": "/y", "project_name": "p2", "created_at": "2026-03-01T00:00:00.000Z"}),
	}
	for _, r := range seed {
		if err := s.SaveRecord(r); err != nil {
			t.Fatalf("SaveRecord: %v", err)
		}
	}

	for _, tc := range []struct {
		name   string
		filter ListFilter
		want   []string
	}{
		{"no filter, newest first", ListFilter{Limit: 10}, []string{"c", "b", "a"}},
		{"status", ListFilter{Status: "open", Limit: 10}, []string{"c", "a"}},
		{"route", ListFilter{Route: "/x", Limit: 10}, []string{"b", "a"}},
		{"project", ListFilter{Project: "p1", Limit: 10}, []string{"b", "a"}},
		{"since", ListFilter{Since: "2026-02-01T00:00:00.000Z", Limit: 10}, []string{"c", "b"}},
		{"combined", ListFilter{Status: "open", Project: "p1", Limit: 10}, []string{"a"}},
		{"limit truncates the page", ListFilter{Limit: 1}, []string{"c"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items, _, err := s.ListFeedback(tc.filter)
			if err != nil {
				t.Fatalf("ListFeedback: %v", err)
			}
			var got []string
			for _, it := range items {
				got = append(got, it.id())
			}
			if len(got) != len(tc.want) {
				t.Fatalf("ids = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("ids = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestListFeedbackTotalIgnoresLimit(t *testing.T) {
	s := newTestStore(t)
	for _, id := range []string{"a", "b", "c"} {
		if err := s.SaveRecord(rec(id, nil)); err != nil {
			t.Fatalf("SaveRecord: %v", err)
		}
	}
	items, total, err := s.ListFeedback(ListFilter{Limit: 1})
	if err != nil {
		t.Fatalf("ListFeedback: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("count = %d, want 1", len(items))
	}
	if total != 3 {
		t.Errorf("total = %d, want 3 — total must count matches, not the page", total)
	}
}

func TestLoadRecordsOmitsUnknownIDs(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveRecord(rec("known", nil)); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}
	out, err := s.LoadRecords([]string{"known", "missing"})
	if err != nil {
		t.Fatalf("LoadRecords: %v", err)
	}
	if len(out) != 1 {
		t.Fatalf("got %d records, want 1", len(out))
	}
	if _, ok := out["known"]; !ok {
		t.Error("known id missing from the result")
	}
}

/* ---------------------------------------------------------------------- */
/* AI budget + in-place reply                                             */
/* ---------------------------------------------------------------------- */

func TestReserveAIReplyEnforcesCapExactly(t *testing.T) {
	s := newTestStore(t)
	const day = "2026-01-01"
	for i := 0; i < 3; i++ {
		if !s.ReserveAIReply(day, 3) {
			t.Fatalf("reservation %d refused while under cap", i+1)
		}
	}
	if s.ReserveAIReply(day, 3) {
		t.Error("reservation granted past the cap — the ceiling must hold")
	}
}

func TestReserveAIReplyRefusesZeroCap(t *testing.T) {
	s := newTestStore(t)
	if s.ReserveAIReply("2026-01-01", 0) {
		t.Error("a cap of 0 must refuse every reservation")
	}
}

func TestReleaseAIReplyReturnsUnspentBudget(t *testing.T) {
	s := newTestStore(t)
	const day = "2026-01-01"
	if !s.ReserveAIReply(day, 1) {
		t.Fatal("first reservation refused")
	}
	if s.ReserveAIReply(day, 1) {
		t.Fatal("second reservation should be over cap")
	}
	if err := s.ReleaseAIReply(day); err != nil {
		t.Fatalf("ReleaseAIReply: %v", err)
	}
	if !s.ReserveAIReply(day, 1) {
		t.Error("released budget was not reusable")
	}
}

func TestReleaseAIReplyClampsAtZero(t *testing.T) {
	s := newTestStore(t)
	const day = "2026-01-01"
	for i := 0; i < 3; i++ {
		if err := s.ReleaseAIReply(day); err != nil {
			t.Fatalf("ReleaseAIReply: %v", err)
		}
	}
	// A stray release must not mint budget beyond the cap.
	if !s.ReserveAIReply(day, 1) {
		t.Fatal("first reservation refused")
	}
	if s.ReserveAIReply(day, 1) {
		t.Error("over-release created budget that was never reserved")
	}
}

func TestReserveAIReplyIsAtomicUnderConcurrency(t *testing.T) {
	s := newTestStore(t)
	const (
		day      = "2026-01-01"
		dailyCap = 10
		callers  = 100
	)
	granted := make(chan bool, callers)
	start := make(chan struct{})
	for i := 0; i < callers; i++ {
		go func() {
			<-start
			granted <- s.ReserveAIReply(day, dailyCap)
		}()
	}
	close(start)
	count := 0
	for i := 0; i < callers; i++ {
		if <-granted {
			count++
		}
	}
	if count != dailyCap {
		t.Errorf("granted %d reservations, want exactly %d — check-then-act would overshoot", count, dailyCap)
	}
}

func TestSetAIReplyPreservesAConcurrentPatch(t *testing.T) {
	s := newTestStore(t)
	if err := s.SaveRecord(rec("id-1", nil)); err != nil {
		t.Fatalf("SaveRecord: %v", err)
	}

	// Snapshot the record the way maybeReply does, before the model is asked.
	stale, err := s.LoadRecord("id-1")
	if err != nil {
		t.Fatalf("LoadRecord: %v", err)
	}

	// A triage PATCH lands while the model is thinking.
	patched := stale
	patched["status"] = "resolved"
	patched["resolution_note"] = "fixed it"
	if err := s.SaveRecord(patched); err != nil {
		t.Fatalf("SaveRecord (patch): %v", err)
	}

	written, err := s.SetAIReply("id-1", "thanks for flagging that")
	if err != nil {
		t.Fatalf("SetAIReply: %v", err)
	}
	if !written {
		t.Fatal("SetAIReply reported no rows for an existing record")
	}

	out, err := s.LoadRecord("id-1")
	if err != nil {
		t.Fatalf("LoadRecord: %v", err)
	}
	if out.status() != "resolved" {
		t.Errorf("status = %q, want %q — the AI write clobbered the PATCH", out.status(), "resolved")
	}
	if out["resolution_note"] != "fixed it" {
		t.Errorf("resolution_note = %#v, want %q", out["resolution_note"], "fixed it")
	}
	if out["ai_reply"] != "thanks for flagging that" {
		t.Errorf("ai_reply = %#v, want it written", out["ai_reply"])
	}
}

func TestSetAIReplyReportsAMissingRecord(t *testing.T) {
	s := newTestStore(t)
	written, err := s.SetAIReply("gone", "hi")
	if err != nil {
		t.Fatalf("SetAIReply: %v", err)
	}
	if written {
		t.Error("SetAIReply claimed to write a record that does not exist")
	}
}
