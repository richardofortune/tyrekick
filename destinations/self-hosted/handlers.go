package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Longest comment body kept. Anything over this is truncated with an
// ellipsis, mirroring worker.ts's MAX_BODY.
const maxBody = 2000

// List page size: default when `limit` is absent/garbage, and the hard cap.
const (
	defaultLimit = 50
	maxLimit     = 200
)

// Hard cap on a single request body, defensive against an unbounded JSON
// payload — the Worker relies on the platform's own request-size limits, but
// a self-hosted service has none by default.
const maxRequestBytes = 256 * 1024

const receiptsMaxIDs = 50

var uuidShapeRE = regexp.MustCompile(`^[0-9a-fA-F-]{16,64}$`)

/* -------------------------------------------------------------------- */
/* POST / and POST /feedback — open ingest                              */
/* -------------------------------------------------------------------- */

func (a *App) handleIngest(w http.ResponseWriter, r *http.Request) {
	var payload map[string]interface{}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err := dec.Decode(&payload); err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "invalid_json"})
		return
	}

	// Accept schema v1 (historical) and v2 (current widget) only.
	schema, _ := payload["schema"].(float64)
	if schema != 1 && schema != 2 {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "unsupported_schema"})
		return
	}

	bodyText, _ := payload["body"].(string)
	trimmed := strings.TrimSpace(bodyText)
	if trimmed == "" {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "empty_body"})
		return
	}
	if len([]rune(trimmed)) > maxBody {
		trimmed = truncateRunes(trimmed, maxBody) + "…"
	}
	payload["body"] = trimmed

	receivedAt := nowISO()
	id, _ := payload["id"].(string)
	if id == "" {
		id = newUUIDv4()
	}
	payload["id"] = id
	createdAt, _ := payload["created_at"].(string)
	if createdAt == "" {
		createdAt = receivedAt
	}
	payload["created_at"] = createdAt

	record := FeedbackRecord(payload)
	record["status"] = string(StatusOpen)
	record["received_at"] = receivedAt
	record["resolved_at"] = nil
	record["resolution_note"] = nil
	record["ai_reply"] = nil

	if err := a.store.SaveRecord(record); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}

	// Optional Discord tee + AI acknowledgement: best-effort, run after the
	// response, never block or fail the ingest. goBackground rather than a
	// bare `go` so shutdown waits for them instead of closing the store
	// out from under their writes.
	if a.cfg.DiscordWebhook != "" {
		a.goBackground(func() { a.forwardToDiscord(record) })
	}
	if a.cfg.AnthropicAPIKey != "" {
		a.goBackground(func() { a.maybeReply(record) })
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{"ok": true, "id": id})
}

/* -------------------------------------------------------------------- */
/* GET /feedback — token-gated list                                     */
/* -------------------------------------------------------------------- */

func (a *App) handleList(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	status := q.Get("status")
	if status != "" && !isValidStatus(status) {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "invalid_status"})
		return
	}

	limit := defaultLimit
	if raw := q.Get("limit"); raw != "" {
		if n, err := strconv.ParseFloat(raw, 64); err == nil {
			limit = clampInt(int(n), 1, maxLimit)
		}
	}

	items, total, err := a.store.ListFeedback(ListFilter{
		Status:  status,
		Route:   q.Get("route"),
		Project: q.Get("project"),
		Since:   q.Get("since"),
		Limit:   limit,
	})
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"ok": true, "count": len(items), "total": total, "items": items,
	})
}

/* -------------------------------------------------------------------- */
/* GET /feedback/:id — token-gated single record                        */
/* -------------------------------------------------------------------- */

func (a *App) handleGetOne(w http.ResponseWriter, id string) {
	record, err := a.store.LoadRecord(id)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}
	if record == nil {
		jsonResponse(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not found"})
		return
	}
	jsonResponse(w, http.StatusOK, map[string]interface{}{"ok": true, "item": record})
}

/* -------------------------------------------------------------------- */
/* PATCH /feedback/:id — token-gated triage/resolve/reopen              */
/* -------------------------------------------------------------------- */

func (a *App) handlePatch(w http.ResponseWriter, r *http.Request, id string) {
	var body map[string]interface{}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBytes))
	if err := dec.Decode(&body); err != nil {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "invalid_json"})
		return
	}
	nextStatus, _ := body["status"].(string)
	if !isValidStatus(nextStatus) {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "invalid_status"})
		return
	}
	var note interface{}
	if n, ok := body["note"].(string); ok {
		note = n
	}

	record, err := a.store.LoadRecord(id)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}
	if record == nil {
		jsonResponse(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not found"})
		return
	}

	record["status"] = nextStatus
	switch FeedbackStatus(nextStatus) {
	case StatusResolved, StatusDeclined:
		record["resolved_at"] = nowISO()
		record["resolution_note"] = note
	case StatusApproved:
		record["resolved_at"] = nil
		record["resolution_note"] = note
	default: // open — full reset (reopen/un-triage)
		record["resolved_at"] = nil
		record["resolution_note"] = nil
	}

	if err := a.store.SaveRecord(record); err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}

	if a.cfg.DiscordWebhook != "" && (nextStatus == string(StatusResolved) || nextStatus == string(StatusDeclined)) {
		a.goBackground(func() { a.forwardResolutionToDiscord(record) })
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{"ok": true, "item": record})
}

/* -------------------------------------------------------------------- */
/* GET /receipts?ids=… — unauthenticated capability-id status lookups    */
/* -------------------------------------------------------------------- */

func (a *App) handleReceipts(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("ids")
	var ids []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" || !uuidShapeRE.MatchString(part) {
			continue
		}
		ids = append(ids, part)
		if len(ids) >= receiptsMaxIDs {
			break
		}
	}
	if len(ids) == 0 {
		jsonResponse(w, http.StatusOK, map[string]interface{}{"ok": true, "receipts": []interface{}{}})
		return
	}

	records, err := a.store.LoadRecords(ids)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}

	receipts := make([]map[string]interface{}, 0, len(ids))
	for _, id := range ids {
		record, ok := records[id]
		if !ok {
			continue
		}
		receipts = append(receipts, map[string]interface{}{
			"id":              record.id(),
			"status":          record.status(),
			"resolved_at":     record["resolved_at"],
			"resolution_note": record["resolution_note"],
			"ai_reply":        record["ai_reply"],
		})
	}
	jsonResponse(w, http.StatusOK, map[string]interface{}{"ok": true, "receipts": receipts})
}

/* -------------------------------------------------------------------- */
/* GET /shared?project=&route= — review-key-gated shared view            */
/* -------------------------------------------------------------------- */

const sharedMaxLimit = 100

// pathnameOf strips query string and hash: "/pricing?ref=x#plans" -> "/pricing".
func pathnameOf(route string) string {
	route = strings.SplitN(route, "?", 2)[0]
	route = strings.SplitN(route, "#", 2)[0]
	return route
}

// keyMatches is a length-independent comparison. The review key lives in
// the shared page, so this guards little in practice — but a public read
// endpoint should not also be a timing oracle for a secret an operator may
// have reused elsewhere.
func keyMatches(presented, expected string) bool {
	if len(presented) != len(expected) {
		return false
	}
	diff := 0
	for i := 0; i < len(presented); i++ {
		diff |= int(presented[i]) ^ int(expected[i])
	}
	return diff == 0
}

// copyIfPresent mirrors JSON.stringify's treatment of `undefined`: a field
// the payload never carried is OMITTED from the projection rather than
// materialised as an explicit null. Fields the Worker defaults with `?? null`
// are set unconditionally instead — see sharedView.
func copyIfPresent(dst map[string]interface{}, dstKey string, src map[string]interface{}, srcKey string) {
	if v, ok := src[srcKey]; ok {
		dst[dstKey] = v
	}
}

// sharedView projects what one reviewer is allowed to learn about another
// reviewer's comment. Withheld deliberately: env (fingerprint), page_errors
// (the prototype's stack traces), url (may carry share-link secrets), and
// session_id (cross-comment correlation). Mirrors worker.ts's sharedView,
// including which absent fields come back null and which are simply absent.
func sharedView(r FeedbackRecord, n int) map[string]interface{} {
	anchor := r.anchor()

	// `?? null` in the Worker — always present, null when the record has none.
	out := map[string]interface{}{
		"id":              r.id(),
		"n":               n,
		"status":          r.status(),
		"reviewer_name":   r["reviewer_name"],
		"resolved_at":     r["resolved_at"],
		"resolution_note": r["resolution_note"],
	}
	// Passed through bare in the Worker — absent stays absent.
	for _, key := range []string{"created_at", "app_version", "route", "body"} {
		copyIfPresent(out, key, r, key)
	}

	anchorOut := map[string]interface{}{
		"selector": anchor["selector"],
		"element":  anchor["element"],
		"context":  anchor["context"],
	}
	for _, key := range []string{"x_pct", "y_pct", "viewport"} {
		copyIfPresent(anchorOut, key, anchor, key)
	}
	out["anchor"] = anchorOut
	return out
}

func (a *App) handleShared(w http.ResponseWriter, r *http.Request) {
	// Absent key = feature off. 404 rather than 401: an operator who never
	// opted in should not advertise that the route exists at all.
	if a.cfg.ReviewKey == "" {
		jsonResponse(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not_found"})
		return
	}
	presented := r.Header.Get("X-Tyrekick-Review-Key")
	if !keyMatches(presented, a.cfg.ReviewKey) {
		jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{"ok": false, "error": "unauthorized"})
		return
	}

	q := r.URL.Query()
	project := q.Get("project")
	if project == "" {
		jsonResponse(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "project_required"})
		return
	}
	hasRouteFilter := q.Has("route")
	routeParam := q.Get("route")

	records, err := a.store.ListByProject(project)
	if err != nil {
		jsonResponse(w, http.StatusInternalServerError, map[string]interface{}{"ok": false, "error": "storage_failed"})
		return
	}

	// Match on the PATHNAME of the stored route: records keep the full route
	// (`/pricing?ref=x#plans`), but reviewers reach one page by links that
	// differ only in query string.
	var inScope []FeedbackRecord
	for _, rec := range records {
		if hasRouteFilter && pathnameOf(rec.route()) != pathnameOf(routeParam) {
			continue
		}
		inScope = append(inScope, rec)
	}

	// Stable numbering: a comment's number is its position in the page's
	// WHOLE history (declined included), ordered by created_at then id.
	// Removing (declining) a comment leaves a gap rather than shifting every
	// later comment's number down — see worker.ts's sharedView for why that
	// gap is the point.
	numbered := append([]FeedbackRecord{}, inScope...)
	sort.SliceStable(numbered, func(i, j int) bool {
		ti, tj := numbered[i].createdAt(), numbered[j].createdAt()
		if ti != tj {
			return ti < tj
		}
		return numbered[i].id() < numbered[j].id()
	})
	numbers := make(map[string]int, len(numbered))
	for i, rec := range numbered {
		numbers[rec.id()] = i + 1
	}

	// "declined" is withheld from the shared view by design — see
	// worker.ts's handleShared. Its own author still sees the outcome via
	// /receipts, keyed by their own capability id.
	var filtered []FeedbackRecord
	for _, rec := range inScope {
		if rec.status() != string(StatusDeclined) {
			filtered = append(filtered, rec)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].createdAt() > filtered[j].createdAt()
	})
	total := len(filtered)
	if len(filtered) > sharedMaxLimit {
		filtered = filtered[:sharedMaxLimit]
	}

	pins := make([]map[string]interface{}, 0, len(filtered))
	for _, rec := range filtered {
		pins = append(pins, sharedView(rec, numbers[rec.id()]))
	}

	jsonResponse(w, http.StatusOK, map[string]interface{}{
		"ok": true, "count": len(pins), "total": total, "pins": pins,
	})
}

/* -------------------------------------------------------------------- */
/* Router                                                                */
/* -------------------------------------------------------------------- */

// ServeHTTP mirrors worker.ts's default export: path matching on the
// TRAILING segment (HasSuffix / lastIndex of "/feedback/") so the same
// binary works whether it owns the whole path space or is reverse-proxied
// under a mount point like "/api".
func (a *App) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		applyCORS(w)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// Route on the ESCAPED path, the direct equivalent of worker.ts's
	// url.pathname. r.URL.Path is already percent-decoded, so routing on it
	// would decode a second time below and make any id containing a literal
	// "%" unreachable at every encoding.
	path := strings.TrimRight(r.URL.EscapedPath(), "/")
	if path == "" {
		path = "/"
	}
	itemMarker := strings.LastIndex(path, "/feedback/")

	if path == "/" {
		switch r.Method {
		case http.MethodPost:
			if a.allowRequest(w, r, a.ingestLimiter) {
				a.handleIngest(w, r)
			}
		case http.MethodGet:
			jsonResponse(w, http.StatusOK, map[string]interface{}{
				"ok":      true,
				"service": "tyrekick",
				"routes": []string{
					"POST /feedback",
					"GET /feedback (token)",
					"GET /feedback/:id (token)",
					"PATCH /feedback/:id (token)",
					"GET /receipts?ids=",
					"GET /shared?project= (review key)",
				},
			})
		default:
			jsonResponse(w, http.StatusMethodNotAllowed, map[string]interface{}{"ok": false, "error": "method_not_allowed"})
		}
		return
	}

	if strings.HasSuffix(path, "/feedback") {
		switch r.Method {
		case http.MethodPost:
			if a.allowRequest(w, r, a.ingestLimiter) {
				a.handleIngest(w, r)
			}
		case http.MethodGet:
			if a.requireAuth(w, r) {
				a.handleList(w, r)
			}
		default:
			jsonResponse(w, http.StatusMethodNotAllowed, map[string]interface{}{"ok": false, "error": "method_not_allowed"})
		}
		return
	}

	if strings.HasSuffix(path, "/receipts") {
		if r.Method != http.MethodGet {
			jsonResponse(w, http.StatusMethodNotAllowed, map[string]interface{}{"ok": false, "error": "method_not_allowed"})
			return
		}
		if a.allowRequest(w, r, a.readLimiter) {
			a.handleReceipts(w, r)
		}
		return
	}

	if strings.HasSuffix(path, "/shared") {
		if r.Method != http.MethodGet {
			jsonResponse(w, http.StatusMethodNotAllowed, map[string]interface{}{"ok": false, "error": "method_not_allowed"})
			return
		}
		if a.allowRequest(w, r, a.readLimiter) {
			a.handleShared(w, r)
		}
		return
	}

	if itemMarker != -1 {
		rawID := path[itemMarker+len("/feedback/"):]
		if rawID == "" || strings.Contains(rawID, "/") {
			jsonResponse(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not found"})
			return
		}
		id, err := url.PathUnescape(rawID)
		if err != nil {
			jsonResponse(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not found"})
			return
		}
		switch r.Method {
		case http.MethodGet:
			if a.requireAuth(w, r) {
				a.handleGetOne(w, id)
			}
		case http.MethodPatch:
			if a.requireAuth(w, r) {
				a.handlePatch(w, r, id)
			}
		default:
			jsonResponse(w, http.StatusMethodNotAllowed, map[string]interface{}{"ok": false, "error": "method_not_allowed"})
		}
		return
	}

	jsonResponse(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not_found"})
}
