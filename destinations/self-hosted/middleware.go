package main

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

// corsHeaders are permissive so a cross-origin prototype can both POST here
// and read the JSON response body, mirroring worker.ts's CORS_HEADERS.
var corsHeaders = map[string]string{
	"Access-Control-Allow-Origin":  "*",
	"Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tyrekick-Review-Key",
	"Access-Control-Max-Age":       "86400",
}

func applyCORS(w http.ResponseWriter) {
	for k, v := range corsHeaders {
		w.Header().Set(k, v)
	}
}

// jsonResponse writes body as JSON with CORS headers applied, mirroring
// worker.ts's json() helper.
func jsonResponse(w http.ResponseWriter, status int, body interface{}) {
	applyCORS(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// nowISO returns the current UTC time formatted like JavaScript's
// Date.prototype.toISOString(), e.g. "2026-08-07T12:34:56.789Z".
func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func clampInt(n, lo, hi int) int {
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// truncateRunes truncates s to at most n runes, unicode-safe (the JS
// original uses .slice(), which is UTF-16-code-unit safe; this is the
// closest Go equivalent for the ASCII/BMP text this service handles).
func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// requireAuth gates the management routes. Returns true if the request may
// proceed; otherwise it has already written a 401 response, mirroring
// worker.ts's requireAuth (Response | null, adapted to Go's "write and
// report handled" style).
func (a *App) requireAuth(w http.ResponseWriter, r *http.Request) bool {
	if a.cfg.Token == "" {
		jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{
			"ok": false, "error": "TYREKICK_TOKEN not configured",
		})
		return false
	}
	header := r.Header.Get("Authorization")
	token := ""
	if strings.HasPrefix(header, "Bearer ") {
		token = strings.TrimPrefix(header, "Bearer ")
	}
	if token != a.cfg.Token {
		jsonResponse(w, http.StatusUnauthorized, map[string]interface{}{
			"ok": false, "error": "unauthorized",
		})
		return false
	}
	return true
}

// clientIP extracts the caller's address for rate-limit keying. Unlike the
// Worker (which trusts Cloudflare's CF-Connecting-IP, unforgeable at the
// edge), a self-hosted deployment has no single canonical source: this
// checks X-Forwarded-For / X-Real-IP (set by a reverse proxy in front of
// this service) and falls back to the raw connection address. If this
// service is exposed directly to the internet without a trusted proxy in
// front of it, these headers are client-supplied and spoofable — the
// deployment's reverse proxy is expected to set (and strip any
// client-supplied copies of) them.
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if ip := strings.TrimSpace(parts[0]); ip != "" {
			return ip
		}
	}
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		return strings.TrimSpace(xrip)
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

// ipRateLimiter is a per-IP token bucket, the in-process equivalent of the
// Workers Rate Limiting bindings (INGEST_LIMITER / READ_LIMITER) in
// worker.ts. A nil *ipRateLimiter (limit <= 0 in config) means "not
// configured" and every check passes, exactly like an unset binding.
type ipRateLimiter struct {
	mu       sync.Mutex
	limiters map[string]*rateEntry
	r        rate.Limit
	burst    int
}

type rateEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// newIPRateLimiter builds a limiter allowing `limit` requests per
// `periodSeconds` per IP, or nil if limit <= 0 (disabled).
func newIPRateLimiter(limit int, periodSeconds int) *ipRateLimiter {
	if limit <= 0 || periodSeconds <= 0 {
		return nil
	}
	l := &ipRateLimiter{
		limiters: make(map[string]*rateEntry),
		r:        rate.Limit(float64(limit) / float64(periodSeconds)),
		burst:    limit,
	}
	go l.sweepLoop()
	return l
}

func (l *ipRateLimiter) allow(ip string) bool {
	if l == nil || ip == "" {
		return true // no-op, mirrors "binding not configured" / "no client IP to key on"
	}
	l.mu.Lock()
	entry, ok := l.limiters[ip]
	if !ok {
		entry = &rateEntry{limiter: rate.NewLimiter(l.r, l.burst)}
		l.limiters[ip] = entry
	}
	entry.lastSeen = time.Now()
	limiter := entry.limiter
	l.mu.Unlock()
	return limiter.Allow()
}

// sweepLoop evicts IPs idle for 10+ minutes so the map doesn't grow
// unbounded under scraping/scanning traffic.
func (l *ipRateLimiter) sweepLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		cutoff := time.Now().Add(-10 * time.Minute)
		l.mu.Lock()
		for ip, entry := range l.limiters {
			if entry.lastSeen.Before(cutoff) {
				delete(l.limiters, ip)
			}
		}
		l.mu.Unlock()
	}
}

// rateLimited checks limiter against the request's client IP. Returns true
// if the request may proceed; otherwise it has already written a 429.
func rateLimited(w http.ResponseWriter, r *http.Request, limiter *ipRateLimiter) bool {
	if limiter == nil {
		return true
	}
	ip := clientIP(r)
	if ip == "" || limiter.allow(ip) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	jsonResponse(w, http.StatusTooManyRequests, map[string]interface{}{
		"ok": false, "error": "rate_limited",
	})
	return false
}
