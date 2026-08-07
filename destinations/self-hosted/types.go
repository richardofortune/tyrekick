package main

import "encoding/json"

// FeedbackStatus is the triage ladder: "open" (new, untriaged) -> "approved"
// (cleared for an agent to action) or "declined" (won't fix) -> "resolved"
// (actioned). Set via PATCH /feedback/:id.
type FeedbackStatus string

const (
	StatusOpen     FeedbackStatus = "open"
	StatusApproved FeedbackStatus = "approved"
	StatusDeclined FeedbackStatus = "declined"
	StatusResolved FeedbackStatus = "resolved"
)

func isValidStatus(s string) bool {
	switch FeedbackStatus(s) {
	case StatusOpen, StatusApproved, StatusDeclined, StatusResolved:
		return true
	default:
		return false
	}
}

// FeedbackRecord is the full stored record: the widget's FeedbackPayload
// (stored verbatim, schema v1 or v2) plus server-side lifecycle fields. It is
// kept as a raw JSON object rather than a strict struct so v2-only fields
// (anchor.element, anchor.context, page_errors, extra env keys, ...) flow
// through to storage untouched, mirroring the Worker's "store whatever
// payload it receives verbatim" behavior.
type FeedbackRecord map[string]interface{}

func (r FeedbackRecord) getString(key string) string {
	if v, ok := r[key].(string); ok {
		return v
	}
	return ""
}

func (r FeedbackRecord) id() string          { return r.getString("id") }
func (r FeedbackRecord) createdAt() string   { return r.getString("created_at") }
func (r FeedbackRecord) route() string       { return r.getString("route") }
func (r FeedbackRecord) projectName() string { return r.getString("project_name") }
func (r FeedbackRecord) body() string        { return r.getString("body") }
func (r FeedbackRecord) status() string      { return r.getString("status") }
func (r FeedbackRecord) receivedAt() string  { return r.getString("received_at") }

func (r FeedbackRecord) anchor() map[string]interface{} {
	if v, ok := r["anchor"].(map[string]interface{}); ok {
		return v
	}
	return map[string]interface{}{}
}

func (r FeedbackRecord) clone() FeedbackRecord {
	out := make(FeedbackRecord, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}

func marshalRecord(r FeedbackRecord) (string, error) {
	b, err := json.Marshal(map[string]interface{}(r))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func unmarshalRecord(raw string) (FeedbackRecord, error) {
	var r FeedbackRecord
	if err := json.Unmarshal([]byte(raw), &r); err != nil {
		return nil, err
	}
	return r, nil
}
