package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testToken = "test-token"

func newTestApp(t *testing.T, mutate func(*Config)) *App {
	t.Helper()
	cfg := Config{
		DBPath:     filepath.Join(t.TempDir(), "test.db"),
		Token:      testToken,
		AIDailyCap: 500,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	store, err := OpenStore(cfg.DBPath)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return &App{
		cfg:           cfg,
		store:         store,
		ingestLimiter: newIPRateLimiter(cfg.IngestRateLimit, cfg.IngestRatePeriod),
		readLimiter:   newIPRateLimiter(cfg.ReadRateLimit, cfg.ReadRatePeriod),
		httpClient:    &http.Client{Timeout: time.Second},
	}
}

// do drives one request through the real router and decodes the JSON envelope.
func do(t *testing.T, app *App, method, target, body string, headers map[string]string) (*httptest.ResponseRecorder, map[string]interface{}) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, target, rdr)
	req.RemoteAddr = "192.0.2.1:1234"
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	app.ServeHTTP(w, req)

	out := map[string]interface{}{}
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatalf("%s %s: response is not JSON: %v (body %q)", method, target, err, w.Body.String())
		}
	}
	return w, out
}

func authHeader() map[string]string {
	return map[string]string{"Authorization": "Bearer " + testToken}
}

// ingest posts one valid payload and returns its id.
func ingest(t *testing.T, app *App, fields map[string]interface{}) string {
	t.Helper()
	payload := map[string]interface{}{
		"schema":       2,
		"body":         "the button is misaligned",
		"project_name": "p1",
		"route":        "/pricing",
		"app_version":  "1.0.0",
		"anchor":       map[string]interface{}{"x_pct": 10, "y_pct": 20},
	}
	for k, v := range fields {
		payload[k] = v
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	w, got := do(t, app, http.MethodPost, "/feedback", string(raw), nil)
	if w.Code != http.StatusOK || got["ok"] != true {
		t.Fatalf("ingest failed: %d %v", w.Code, got)
	}
	id, _ := got["id"].(string)
	if id == "" {
		t.Fatal("ingest returned no id")
	}
	return id
}

/* ---------------------------------------------------------------------- */
/* Ingest                                                                 */
/* ---------------------------------------------------------------------- */

func TestIngestRejectsBadPayloads(t *testing.T) {
	app := newTestApp(t, nil)
	for _, tc := range []struct {
		name, body, wantErr string
	}{
		{"malformed json", "{not json", "invalid_json"},
		{"missing schema", `{"body":"hi"}`, "unsupported_schema"},
		{"unknown schema", `{"schema":3,"body":"hi"}`, "unsupported_schema"},
		{"schema as string", `{"schema":"2","body":"hi"}`, "unsupported_schema"},
		{"empty body", `{"schema":2,"body":""}`, "empty_body"},
		{"whitespace-only body", `{"schema":2,"body":"   \n "}`, "empty_body"},
		{"missing body", `{"schema":2}`, "empty_body"},
		{"body not a string", `{"schema":2,"body":42}`, "empty_body"},
		{"null payload", `null`, "unsupported_schema"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, got := do(t, app, http.MethodPost, "/feedback", tc.body, nil)
			if w.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", w.Code)
			}
			if got["error"] != tc.wantErr {
				t.Errorf("error = %v, want %q", got["error"], tc.wantErr)
			}
		})
	}
}

func TestIngestAcceptsBothSchemaVersions(t *testing.T) {
	app := newTestApp(t, nil)
	for _, schema := range []int{1, 2} {
		id := ingest(t, app, map[string]interface{}{"schema": schema})
		if id == "" {
			t.Errorf("schema v%d was rejected", schema)
		}
	}
}

func TestIngestNormalisesIDAndTimestamps(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, nil)

	stored, err := app.store.LoadRecord(id)
	if err != nil || stored == nil {
		t.Fatalf("LoadRecord(%q): %v", id, err)
	}
	if stored.createdAt() == "" {
		t.Error("created_at was not defaulted from received_at")
	}
	if stored.receivedAt() == "" {
		t.Error("received_at was not set")
	}
	if stored.status() != string(StatusOpen) {
		t.Errorf("status = %q, want %q", stored.status(), StatusOpen)
	}
	for _, key := range []string{"resolved_at", "resolution_note", "ai_reply"} {
		if v, ok := stored[key]; !ok || v != nil {
			t.Errorf("%s = %#v, want an explicit null on a fresh record", key, v)
		}
	}
}

func TestIngestKeepsAClientSuppliedIDAndCreatedAt(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, map[string]interface{}{
		"id":         "11111111-2222-3333-4444-555555555555",
		"created_at": "2020-01-01T00:00:00.000Z",
	})
	if id != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("id = %q, want the client's own id preserved", id)
	}
	stored, _ := app.store.LoadRecord(id)
	if stored.createdAt() != "2020-01-01T00:00:00.000Z" {
		t.Errorf("created_at = %q, want the client's value preserved", stored.createdAt())
	}
}

func TestIngestTruncatesAnOverlongBody(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, map[string]interface{}{"body": strings.Repeat("é", maxBody+500)})
	stored, _ := app.store.LoadRecord(id)
	got := []rune(stored.body())
	if len(got) != maxBody+1 {
		t.Fatalf("body length = %d runes, want %d (%d + ellipsis)", len(got), maxBody+1, maxBody)
	}
	if got[len(got)-1] != '…' {
		t.Errorf("truncated body does not end in an ellipsis: %q", string(got[len(got)-3:]))
	}
}

func TestIngestStoresUnknownFieldsVerbatim(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, map[string]interface{}{
		"page_errors": []string{"TypeError: x is not a function"},
		"env":         map[string]interface{}{"user_agent": "test", "dpr": 2},
	})
	stored, _ := app.store.LoadRecord(id)
	if _, ok := stored["page_errors"]; !ok {
		t.Error("page_errors was dropped — v2 fields must flow through untouched")
	}
	env, ok := stored["env"].(map[string]interface{})
	if !ok || env["dpr"] != float64(2) {
		t.Errorf("env did not survive verbatim: %#v", stored["env"])
	}
}

func TestIngestRejectsAnOversizedRequestBody(t *testing.T) {
	app := newTestApp(t, nil)
	huge := `{"schema":2,"body":"` + strings.Repeat("x", maxRequestBytes+1024) + `"}`
	w, got := do(t, app, http.MethodPost, "/feedback", huge, nil)
	if w.Code != http.StatusBadRequest || got["error"] != "invalid_json" {
		t.Errorf("status/error = %d/%v, want 400/invalid_json", w.Code, got["error"])
	}
}

/* ---------------------------------------------------------------------- */
/* Router                                                                 */
/* ---------------------------------------------------------------------- */

func TestRouterMethodsAndPaths(t *testing.T) {
	app := newTestApp(t, nil)
	for _, tc := range []struct {
		name, method, path string
		want               int
	}{
		{"health", http.MethodGet, "/", http.StatusOK},
		{"root delete", http.MethodDelete, "/", http.StatusMethodNotAllowed},
		{"collection delete", http.MethodDelete, "/feedback", http.StatusMethodNotAllowed},
		{"receipts post", http.MethodPost, "/receipts", http.StatusMethodNotAllowed},
		{"shared post", http.MethodPost, "/shared", http.StatusMethodNotAllowed},
		{"item delete", http.MethodDelete, "/feedback/abc", http.StatusMethodNotAllowed},
		{"unknown path", http.MethodGet, "/nope", http.StatusNotFound},
		// "/feedback//" normalises to the collection, not to an empty item id.
		{"item route with no id is the collection", http.MethodGet, "/feedback//", http.StatusOK},
		{"nested item id", http.MethodGet, "/feedback/a/b", http.StatusNotFound},
		// The "/feedback" needle carries its leading slash, so a path merely
		// ending in those letters must not match the collection route.
		{"xfeedback is not feedback", http.MethodGet, "/xfeedback", http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, _ := do(t, app, tc.method, tc.path, "", authHeader())
			if w.Code != tc.want {
				t.Errorf("%s %s = %d, want %d", tc.method, tc.path, w.Code, tc.want)
			}
		})
	}
}

func TestRouterIgnoresTrailingSlashes(t *testing.T) {
	app := newTestApp(t, nil)
	w, got := do(t, app, http.MethodGet, "/feedback///", "", authHeader())
	if w.Code != http.StatusOK || got["ok"] != true {
		t.Errorf("status = %d (%v), want 200 — trailing slashes must normalise away", w.Code, got["error"])
	}
}

func TestRouterWorksUnderAMountPrefix(t *testing.T) {
	app := newTestApp(t, nil)
	// Reverse-proxied under /api, matching the Worker's trailing-segment match.
	id := ingest(t, app, nil)
	for _, path := range []string{"/api/feedback", "/api/feedback/" + id, "/api/receipts", "/deep/nest/feedback"} {
		w, _ := do(t, app, http.MethodGet, path, "", authHeader())
		if w.Code != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", path, w.Code)
		}
	}
}

func TestCORSPreflight(t *testing.T) {
	app := newTestApp(t, nil)
	w, _ := do(t, app, http.MethodOptions, "/feedback", "", nil)
	if w.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Allow-Origin = %q, want *", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "X-Tyrekick-Review-Key") {
		t.Errorf("Allow-Headers = %q, must permit the review key", got)
	}
}

func TestCORSHeadersOnEveryJSONResponse(t *testing.T) {
	app := newTestApp(t, nil)
	w, _ := do(t, app, http.MethodGet, "/nope", "", nil)
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Allow-Origin = %q on a 404, want * — the widget must be able to read errors", got)
	}
}

// Regression: r.URL.Path arrives already percent-decoded, so unescaping it a
// second time made any id containing a literal "%" unreachable at every
// encoding — the record could be created but never read back or triaged.
func TestItemRouteHandlesAPercentEncodedID(t *testing.T) {
	app := newTestApp(t, nil)
	const id = "a%41b"
	if got := ingest(t, app, map[string]interface{}{"id": id}); got != id {
		t.Fatalf("ingest stored id %q, want %q", got, id)
	}
	w, got := do(t, app, http.MethodGet, "/feedback/a%2541b", "", authHeader())
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d, want 200 — a %% in the id must survive routing", w.Code)
	}
	item, _ := got["item"].(map[string]interface{})
	if item["id"] != id {
		t.Errorf("item.id = %v, want %q", item["id"], id)
	}
}

/* ---------------------------------------------------------------------- */
/* Auth                                                                   */
/* ---------------------------------------------------------------------- */

func TestManagementRoutesRequireTheToken(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, nil)
	for _, tc := range []struct {
		name, method, path string
	}{
		{"list", http.MethodGet, "/feedback"},
		{"get one", http.MethodGet, "/feedback/" + id},
		{"patch", http.MethodPatch, "/feedback/" + id},
	} {
		for _, hdr := range []struct {
			name  string
			value map[string]string
		}{
			{"no header", nil},
			{"wrong token", map[string]string{"Authorization": "Bearer wrong"}},
			{"missing bearer prefix", map[string]string{"Authorization": testToken}},
			{"empty bearer", map[string]string{"Authorization": "Bearer "}},
		} {
			t.Run(tc.name+"/"+hdr.name, func(t *testing.T) {
				w, got := do(t, app, tc.method, tc.path, `{"status":"open"}`, hdr.value)
				if w.Code != http.StatusUnauthorized {
					t.Errorf("status = %d, want 401", w.Code)
				}
				if got["error"] != "unauthorized" {
					t.Errorf("error = %v, want unauthorized", got["error"])
				}
			})
		}
	}
}

func TestManagementRoutesStayClosedWhenNoTokenIsConfigured(t *testing.T) {
	app := newTestApp(t, func(c *Config) { c.Token = "" })
	w, got := do(t, app, http.MethodGet, "/feedback", "", map[string]string{"Authorization": "Bearer anything"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 — an unset token must never fall open", w.Code)
	}
	if got["error"] != "TYREKICK_TOKEN not configured" {
		t.Errorf("error = %v, want the not-configured hint", got["error"])
	}
}

func TestIngestNeverRequiresTheToken(t *testing.T) {
	app := newTestApp(t, func(c *Config) { c.Token = "" })
	w, _ := do(t, app, http.MethodPost, "/feedback", `{"schema":2,"body":"hi"}`, nil)
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 — ingest stays open so reviewers stay frictionless", w.Code)
	}
}

/* ---------------------------------------------------------------------- */
/* List / get / patch                                                     */
/* ---------------------------------------------------------------------- */

func TestListRejectsAnUnknownStatus(t *testing.T) {
	app := newTestApp(t, nil)
	w, got := do(t, app, http.MethodGet, "/feedback?status=bogus", "", authHeader())
	if w.Code != http.StatusBadRequest || got["error"] != "invalid_status" {
		t.Errorf("status/error = %d/%v, want 400/invalid_status", w.Code, got["error"])
	}
}

func TestListClampsTheLimit(t *testing.T) {
	app := newTestApp(t, nil)
	for i := 0; i < 3; i++ {
		ingest(t, app, nil)
	}
	for _, tc := range []struct{ query string }{
		{"?limit=0"}, {"?limit=-5"}, {"?limit=99999"}, {"?limit=abc"}, {"?limit="},
	} {
		t.Run(tc.query, func(t *testing.T) {
			w, got := do(t, app, http.MethodGet, "/feedback"+tc.query, "", authHeader())
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 — a garbage limit falls back, never errors", w.Code)
			}
			if got["total"] != float64(3) {
				t.Errorf("total = %v, want 3", got["total"])
			}
		})
	}
}

func TestListReturnsAnEmptyArrayNotNull(t *testing.T) {
	app := newTestApp(t, nil)
	w, _ := do(t, app, http.MethodGet, "/feedback", "", authHeader())
	if !strings.Contains(w.Body.String(), `"items":[]`) {
		t.Errorf("body = %s, want items:[] so the widget can iterate it", w.Body.String())
	}
}

func TestGetOneUnknownIDIs404(t *testing.T) {
	app := newTestApp(t, nil)
	w, _ := do(t, app, http.MethodGet, "/feedback/does-not-exist", "", authHeader())
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestPatchTransitions(t *testing.T) {
	for _, tc := range []struct {
		status         string
		wantResolvedAt bool
		wantNote       interface{}
	}{
		{"resolved", true, "a note"},
		{"declined", true, "a note"},
		{"approved", false, "a note"},
		{"open", false, nil}, // full reset: reopen/un-triage drops the note too
	} {
		t.Run(tc.status, func(t *testing.T) {
			app := newTestApp(t, nil)
			id := ingest(t, app, nil)
			body := `{"status":"` + tc.status + `","note":"a note"}`
			w, got := do(t, app, http.MethodPatch, "/feedback/"+id, body, authHeader())
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", w.Code)
			}
			item, _ := got["item"].(map[string]interface{})
			if item["status"] != tc.status {
				t.Errorf("status = %v, want %q", item["status"], tc.status)
			}
			if gotResolved := item["resolved_at"] != nil; gotResolved != tc.wantResolvedAt {
				t.Errorf("resolved_at set = %v, want %v", gotResolved, tc.wantResolvedAt)
			}
			if item["resolution_note"] != tc.wantNote {
				t.Errorf("resolution_note = %#v, want %#v", item["resolution_note"], tc.wantNote)
			}
		})
	}
}

func TestPatchRejectsBadInput(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, nil)
	for _, tc := range []struct {
		name, body, wantErr string
		wantCode            int
	}{
		{"malformed json", "{oops", "invalid_json", http.StatusBadRequest},
		{"missing status", `{}`, "invalid_status", http.StatusBadRequest},
		{"unknown status", `{"status":"banana"}`, "invalid_status", http.StatusBadRequest},
		{"status not a string", `{"status":3}`, "invalid_status", http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, got := do(t, app, http.MethodPatch, "/feedback/"+id, tc.body, authHeader())
			if w.Code != tc.wantCode || got["error"] != tc.wantErr {
				t.Errorf("status/error = %d/%v, want %d/%q", w.Code, got["error"], tc.wantCode, tc.wantErr)
			}
		})
	}
}

func TestPatchUnknownIDIs404(t *testing.T) {
	app := newTestApp(t, nil)
	w, _ := do(t, app, http.MethodPatch, "/feedback/nope", `{"status":"resolved"}`, authHeader())
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestPatchNoteIsNulledWhenNotAString(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, nil)
	_, got := do(t, app, http.MethodPatch, "/feedback/"+id, `{"status":"resolved","note":42}`, authHeader())
	item, _ := got["item"].(map[string]interface{})
	if v, ok := item["resolution_note"]; !ok || v != nil {
		t.Errorf("resolution_note = %#v, want null for a non-string note", v)
	}
}

/* ---------------------------------------------------------------------- */
/* Receipts                                                               */
/* ---------------------------------------------------------------------- */

func TestReceiptsProjectOnlyTheClosureFields(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, map[string]interface{}{
		"id":            "11111111-2222-3333-4444-555555555555",
		"reviewer_name": "Ada",
		"url":           "https://example.com/pricing?secret=shh",
	})
	_, got := do(t, app, http.MethodGet, "/receipts?ids="+id, "", nil)
	receipts, _ := got["receipts"].([]interface{})
	if len(receipts) != 1 {
		t.Fatalf("got %d receipts, want 1", len(receipts))
	}
	r, _ := receipts[0].(map[string]interface{})
	want := map[string]bool{"id": true, "status": true, "resolved_at": true, "resolution_note": true, "ai_reply": true}
	for k := range r {
		if !want[k] {
			t.Errorf("receipt leaks %q — this route is unauthenticated", k)
		}
	}
	for k := range want {
		if _, ok := r[k]; !ok {
			t.Errorf("receipt is missing %q", k)
		}
	}
}

func TestReceiptsIgnoreMalformedAndUnknownIDs(t *testing.T) {
	app := newTestApp(t, nil)
	id := ingest(t, app, map[string]interface{}{"id": "11111111-2222-3333-4444-555555555555"})
	for _, tc := range []struct {
		name, query string
		want        int
	}{
		{"no ids param", "", 0},
		{"empty ids", "?ids=", 0},
		{"too short to be a uuid", "?ids=abc", 0},
		{"non-hex characters", "?ids=zzzzzzzzzzzzzzzzzz", 0},
		{"unknown but well-formed", "?ids=99999999-9999-9999-9999-999999999999", 0},
		{"known", "?ids=" + id, 1},
		{"known among junk", "?ids=abc," + id + ",zzz", 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, got := do(t, app, http.MethodGet, "/receipts"+tc.query, "", nil)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 — receipts never error on junk input", w.Code)
			}
			receipts, _ := got["receipts"].([]interface{})
			if len(receipts) != tc.want {
				t.Errorf("got %d receipts, want %d", len(receipts), tc.want)
			}
		})
	}
}

func TestReceiptsCapTheBatch(t *testing.T) {
	app := newTestApp(t, nil)
	var ids []string
	for i := 0; i < receiptsMaxIDs+10; i++ {
		ids = append(ids, "99999999-9999-9999-9999-99999999"+string(rune('a'+i%26))+"abc")
	}
	w, _ := do(t, app, http.MethodGet, "/receipts?ids="+strings.Join(ids, ","), "", nil)
	if w.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", w.Code)
	}
}

func TestReceiptsReturnAnEmptyArrayNotNull(t *testing.T) {
	app := newTestApp(t, nil)
	w, _ := do(t, app, http.MethodGet, "/receipts", "", nil)
	if !strings.Contains(w.Body.String(), `"receipts":[]`) {
		t.Errorf("body = %s, want receipts:[]", w.Body.String())
	}
}

/* ---------------------------------------------------------------------- */
/* Shared review                                                          */
/* ---------------------------------------------------------------------- */

const reviewKey = "review-key-123"

func sharedApp(t *testing.T) *App {
	return newTestApp(t, func(c *Config) { c.ReviewKey = reviewKey })
}

func reviewHeader() map[string]string {
	return map[string]string{"X-Tyrekick-Review-Key": reviewKey}
}

func TestSharedIs404WhenTheFeatureIsOff(t *testing.T) {
	app := newTestApp(t, nil) // no ReviewKey
	w, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())
	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 — an unset key must not advertise the route", w.Code)
	}
	if got["error"] != "not_found" {
		t.Errorf("error = %v, want not_found", got["error"])
	}
}

func TestSharedRequiresTheReviewKey(t *testing.T) {
	app := sharedApp(t)
	for _, tc := range []struct {
		name  string
		value map[string]string
	}{
		{"no key", nil},
		{"wrong key", map[string]string{"X-Tyrekick-Review-Key": "nope"}},
		{"prefix of the key", map[string]string{"X-Tyrekick-Review-Key": reviewKey[:5]}},
		{"the management token", map[string]string{"X-Tyrekick-Review-Key": testToken}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w, _ := do(t, app, http.MethodGet, "/shared?project=p1", "", tc.value)
			if w.Code != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", w.Code)
			}
		})
	}
}

func TestSharedRequiresAProject(t *testing.T) {
	app := sharedApp(t)
	w, got := do(t, app, http.MethodGet, "/shared", "", reviewHeader())
	if w.Code != http.StatusBadRequest || got["error"] != "project_required" {
		t.Errorf("status/error = %d/%v, want 400/project_required", w.Code, got["error"])
	}
}

func TestSharedIsScopedToOneProject(t *testing.T) {
	app := sharedApp(t)
	ingest(t, app, map[string]interface{}{"project_name": "p1"})
	ingest(t, app, map[string]interface{}{"project_name": "p2"})

	_, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())
	pins, _ := got["pins"].([]interface{})
	if len(pins) != 1 {
		t.Errorf("got %d pins, want 1 — a review key for one project must not read another", len(pins))
	}
}

func TestSharedMatchesOnRoutePathnameOnly(t *testing.T) {
	app := sharedApp(t)
	ingest(t, app, map[string]interface{}{"route": "/pricing?ref=twitter#plans"})
	ingest(t, app, map[string]interface{}{"route": "/pricing"})
	ingest(t, app, map[string]interface{}{"route": "/about"})

	for _, tc := range []struct {
		query string
		want  int
	}{
		{"?project=p1", 3},                // no route filter: everything
		{"?project=p1&route=/pricing", 2}, // query string and hash ignored
		{"?project=p1&route=/pricing?a=b", 2},
		{"?project=p1&route=/about", 1},
		{"?project=p1&route=/nothing", 0},
	} {
		t.Run(tc.query, func(t *testing.T) {
			_, got := do(t, app, http.MethodGet, "/shared"+tc.query, "", reviewHeader())
			pins, _ := got["pins"].([]interface{})
			if len(pins) != tc.want {
				t.Errorf("got %d pins, want %d", len(pins), tc.want)
			}
		})
	}
}

func TestSharedWithholdsDeclinedButKeepsItsNumber(t *testing.T) {
	app := sharedApp(t)
	first := ingest(t, app, map[string]interface{}{"created_at": "2026-01-01T00:00:00.000Z", "body": "one"})
	second := ingest(t, app, map[string]interface{}{"created_at": "2026-01-02T00:00:00.000Z", "body": "two"})
	third := ingest(t, app, map[string]interface{}{"created_at": "2026-01-03T00:00:00.000Z", "body": "three"})

	// Decline the middle one — it must vanish from the view while its number
	// stays spent, so #3 does not silently become #2.
	do(t, app, http.MethodPatch, "/feedback/"+second, `{"status":"declined"}`, authHeader())

	_, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())
	pins, _ := got["pins"].([]interface{})
	if len(pins) != 2 {
		t.Fatalf("got %d pins, want 2 (declined is withheld)", len(pins))
	}
	if got["total"] != float64(2) {
		t.Errorf("total = %v, want 2", got["total"])
	}

	byID := map[string]float64{}
	for _, p := range pins {
		pin, _ := p.(map[string]interface{})
		id, _ := pin["id"].(string)
		n, _ := pin["n"].(float64)
		byID[id] = n
	}
	if byID[first] != 1 {
		t.Errorf("first comment n = %v, want 1", byID[first])
	}
	if byID[third] != 3 {
		t.Errorf("third comment n = %v, want 3 — declining #2 must leave a gap, not renumber", byID[third])
	}
}

func TestSharedIsNewestFirst(t *testing.T) {
	app := sharedApp(t)
	ingest(t, app, map[string]interface{}{"created_at": "2026-01-01T00:00:00.000Z", "body": "oldest"})
	ingest(t, app, map[string]interface{}{"created_at": "2026-01-03T00:00:00.000Z", "body": "newest"})
	ingest(t, app, map[string]interface{}{"created_at": "2026-01-02T00:00:00.000Z", "body": "middle"})

	_, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())
	pins, _ := got["pins"].([]interface{})
	want := []string{"newest", "middle", "oldest"}
	for i, w := range want {
		pin, _ := pins[i].(map[string]interface{})
		if pin["body"] != w {
			t.Errorf("pin %d body = %v, want %q", i, pin["body"], w)
		}
	}
}

func TestSharedWithholdsSensitiveFields(t *testing.T) {
	app := sharedApp(t)
	ingest(t, app, map[string]interface{}{
		"url":         "https://example.com/p?share_secret=abc",
		"session_id":  "session-123",
		"env":         map[string]interface{}{"user_agent": "Mozilla/5.0", "dpr": 2},
		"page_errors": []string{"TypeError at line 3"},
	})
	w, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())

	for _, forbidden := range []string{"url", "session_id", "env", "page_errors"} {
		pins, _ := got["pins"].([]interface{})
		pin, _ := pins[0].(map[string]interface{})
		if _, present := pin[forbidden]; present {
			t.Errorf("shared view exposes %q to other reviewers", forbidden)
		}
	}
	// Belt and braces: the values themselves must not appear anywhere.
	for _, secret := range []string{"share_secret", "session-123", "Mozilla/5.0", "TypeError"} {
		if strings.Contains(w.Body.String(), secret) {
			t.Errorf("shared response leaks %q", secret)
		}
	}
}

func TestSharedIncludesTheReviewerFacingFields(t *testing.T) {
	app := sharedApp(t)
	ingest(t, app, map[string]interface{}{
		"reviewer_name": "Ada",
		"anchor": map[string]interface{}{
			"x_pct": 12.5, "y_pct": 30, "selector": "#buy",
			"viewport": map[string]interface{}{"w": 1024, "h": 768},
			"element":  map[string]interface{}{"tag": "button", "text": "Buy now"},
		},
	})
	_, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())
	pins, _ := got["pins"].([]interface{})
	pin, _ := pins[0].(map[string]interface{})

	if pin["reviewer_name"] != "Ada" {
		t.Errorf("reviewer_name = %v, want Ada", pin["reviewer_name"])
	}
	anchor, _ := pin["anchor"].(map[string]interface{})
	if anchor["x_pct"] != 12.5 || anchor["selector"] != "#buy" {
		t.Errorf("anchor = %#v, want the pin's position and selector", anchor)
	}
	if _, ok := anchor["viewport"].(map[string]interface{}); !ok {
		t.Errorf("viewport = %#v, want the object passed through", anchor["viewport"])
	}
}

// The Worker builds this projection with JSON.stringify, which DROPS keys
// whose value is undefined. Emitting explicit nulls instead would be a silent
// wire-format divergence between the two destinations.
func TestSharedOmitsAbsentAnchorFieldsRatherThanNullingThem(t *testing.T) {
	app := sharedApp(t)
	ingest(t, app, map[string]interface{}{"anchor": map[string]interface{}{}})
	_, got := do(t, app, http.MethodGet, "/shared?project=p1", "", reviewHeader())
	pins, _ := got["pins"].([]interface{})
	pin, _ := pins[0].(map[string]interface{})
	anchor, _ := pin["anchor"].(map[string]interface{})

	for _, key := range []string{"x_pct", "y_pct", "viewport"} {
		if _, present := anchor[key]; present {
			t.Errorf("anchor.%s is present as null; the Worker omits it entirely", key)
		}
	}
	// These carry `?? null` in the Worker, so they stay present-and-null.
	for _, key := range []string{"selector", "element", "context"} {
		v, present := anchor[key]
		if !present || v != nil {
			t.Errorf("anchor.%s = %#v (present=%v), want an explicit null", key, v, present)
		}
	}
}

func TestSharedReturnsAnEmptyArrayNotNull(t *testing.T) {
	app := sharedApp(t)
	w, _ := do(t, app, http.MethodGet, "/shared?project=empty", "", reviewHeader())
	if !strings.Contains(w.Body.String(), `"pins":[]`) {
		t.Errorf("body = %s, want pins:[]", w.Body.String())
	}
}

func TestKeyMatches(t *testing.T) {
	for _, tc := range []struct {
		presented, expected string
		want                bool
	}{
		{"abc", "abc", true},
		{"abc", "abd", false},
		{"ab", "abc", false},
		{"abcd", "abc", false},
		{"", "", true},
		{"", "abc", false},
	} {
		if got := keyMatches(tc.presented, tc.expected); got != tc.want {
			t.Errorf("keyMatches(%q, %q) = %v, want %v", tc.presented, tc.expected, got, tc.want)
		}
	}
}

func TestPathnameOf(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"/pricing", "/pricing"},
		{"/pricing?ref=x", "/pricing"},
		{"/pricing#plans", "/pricing"},
		{"/pricing?ref=x#plans", "/pricing"},
		{"/pricing#plans?ref=x", "/pricing"},
		{"", ""},
	} {
		if got := pathnameOf(tc.in); got != tc.want {
			t.Errorf("pathnameOf(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
