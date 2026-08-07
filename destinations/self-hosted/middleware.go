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
// edge), a self-hosted deployment has no canonical source, so the answer
// depends on whether a proxy is in front of this service — hence trustProxy.
//
// trustProxy=false (the default) uses ONLY the connection's peer address.
// X-Forwarded-For and X-Real-IP are ordinary request headers: on a directly
// exposed service any client can set them, and believing them would let one
// caller mint a fresh rate-limit key per request — defeating the limiter and
// growing its bucket map without bound. Both failures are silent, which is
// why this is opt-in rather than best-effort.
//
// trustProxy=true takes the FIRST entry of X-Forwarded-For (the original
// client, per the header's append-on-forward convention), then X-Real-IP,
// then the peer address. That is only sound when the proxy overwrites the
// header rather than appending to a client-supplied one.
func clientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
		if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
			if ip := strings.TrimSpace(xrip); ip != "" {
				return ip
			}
		}
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
	overflow *rate.Limiter // shared bucket once maxTrackedIPs is reached
	r        rate.Limit
	burst    int
}

type rateEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

// maxTrackedIPs caps how many per-IP buckets are held at once. The idle
// sweep alone is not a bound: it runs on a timer, so traffic arriving faster
// than it reclaims still grows the map. Past this many distinct IPs inside
// one window, callers share a single overflow bucket — degraded (one noisy
// source can rate-limit another) but bounded, which is the right trade when
// the alternative is the limiter exhausting the memory it exists to protect.
const maxTrackedIPs = 20000

// newIPRateLimiter builds a limiter allowing `limit` requests per
// `periodSeconds` per IP, or nil if limit <= 0 (disabled).
func newIPRateLimiter(limit int, periodSeconds int) *ipRateLimiter {
	if limit <= 0 || periodSeconds <= 0 {
		return nil
	}
	r := rate.Limit(float64(limit) / float64(periodSeconds))
	l := &ipRateLimiter{
		limiters: make(map[string]*rateEntry),
		overflow: rate.NewLimiter(r, limit),
		r:        r,
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
		// At the cap, try reclaiming idle buckets before falling back — a
		// steady stream of one-shot IPs should not pin every legitimate
		// caller onto the shared bucket forever.
		if len(l.limiters) >= maxTrackedIPs {
			l.evictIdleLocked(time.Now().Add(-idleEviction))
		}
		if len(l.limiters) >= maxTrackedIPs {
			l.mu.Unlock()
			return l.overflow.Allow()
		}
		entry = &rateEntry{limiter: rate.NewLimiter(l.r, l.burst)}
		l.limiters[ip] = entry
	}
	entry.lastSeen = time.Now()
	limiter := entry.limiter
	l.mu.Unlock()
	return limiter.Allow()
}

const (
	sweepInterval = 5 * time.Minute
	idleEviction  = 10 * time.Minute
)

// sweepLoop evicts IPs idle for 10+ minutes so the map sheds buckets it no
// longer needs. maxTrackedIPs, not this, is what actually bounds the map.
func (l *ipRateLimiter) sweepLoop() {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for range ticker.C {
		l.mu.Lock()
		l.evictIdleLocked(time.Now().Add(-idleEviction))
		l.mu.Unlock()
	}
}

// evictIdleLocked drops every bucket not touched since cutoff. Caller holds mu.
func (l *ipRateLimiter) evictIdleLocked(cutoff time.Time) {
	for ip, entry := range l.limiters {
		if entry.lastSeen.Before(cutoff) {
			delete(l.limiters, ip)
		}
	}
}

// allowRequest checks limiter against the request's client IP. Returns true
// if the request may PROCEED; otherwise it has already written a 429. Named
// for the allowed case because that is the branch every caller guards on.
func (a *App) allowRequest(w http.ResponseWriter, r *http.Request, limiter *ipRateLimiter) bool {
	if limiter == nil {
		return true
	}
	ip := clientIP(r, a.cfg.TrustProxy)
	if ip == "" || limiter.allow(ip) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	jsonResponse(w, http.StatusTooManyRequests, map[string]interface{}{
		"ok": false, "error": "rate_limited",
	})
	return false
}
