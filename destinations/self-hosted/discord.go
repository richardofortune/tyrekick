package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
)

// forwardToDiscord posts a stored record to Discord as a readable message,
// mirroring the widget's own "discord" transport format. Best-effort by
// design: called from a goroutine with all failures swallowed — a Discord
// outage, rate limit, or bad webhook URL must never affect the ingest
// response the widget already received.
func (a *App) forwardToDiscord(record FeedbackRecord) {
	anchor := record.anchor()
	anchorLabel := anchorLabelFor(anchor)
	who := record.getString("reviewer_name")
	if who == "" {
		who = "Anonymous"
	}
	content := fmt.Sprintf(
		"**%s %s** — %s\n%s\n%s · <%s>",
		record.projectName(), record.getString("app_version"), who,
		record.body(), anchorLabel, record.getString("url"),
	)
	if len([]rune(content)) > 1900 { // Discord caps at 2000
		content = truncateRunes(content, 1900) + "…"
	}
	postDiscord(a.httpClient, a.cfg.DiscordWebhook, content)
}

// forwardResolutionToDiscord mirrors a resolve/decline to Discord so humans
// watching the channel see the loop CLOSE, not just open. Same best-effort
// posture as ingest forwarding.
func (a *App) forwardResolutionToDiscord(record FeedbackRecord) {
	mark := "⛔ declined"
	if record.status() == "resolved" {
		mark = "✅ resolved"
	}
	note := ""
	if n, ok := record["resolution_note"].(string); ok && n != "" {
		note = " — " + n
	}
	bodyPreview := truncateRunes(record.body(), 120)
	content := fmt.Sprintf("%s: **%s** %q%s", mark, record.projectName(), bodyPreview, note)
	if len([]rune(content)) > 1900 {
		content = truncateRunes(content, 1900) + "…"
	}
	postDiscord(a.httpClient, a.cfg.DiscordWebhook, content)
}

func anchorLabelFor(anchor map[string]interface{}) string {
	if el, ok := anchor["element"].(map[string]interface{}); ok {
		text, _ := el["text"].(string)
		if text != "" {
			tag, _ := el["tag"].(string)
			if tag == "" {
				tag = "?"
			}
			return fmt.Sprintf("<%s> %q", tag, text)
		}
	}
	if sel, ok := anchor["selector"].(string); ok && sel != "" {
		return sel
	}
	xPct := "?"
	if v, ok := anchor["x_pct"]; ok {
		xPct = fmt.Sprintf("%v", v)
	}
	yPct := "?"
	if v, ok := anchor["y_pct"]; ok {
		yPct = fmt.Sprintf("%v", v)
	}
	return fmt.Sprintf("%s%%, %s%%", xPct, yPct)
}

func postDiscord(client *http.Client, webhook, content string) {
	body, err := json.Marshal(map[string]string{"content": content})
	if err != nil {
		return
	}
	req, err := http.NewRequest(http.MethodPost, webhook, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}
