package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClientIPIgnoresForwardingHeadersUnlessTrusted(t *testing.T) {
	for _, tc := range []struct {
		name       string
		headers    map[string]string
		remoteAddr string
		trust      bool
		want       string
	}{
		{
			name:       "untrusted: forged XFF is ignored",
			headers:    map[string]string{"X-Forwarded-For": "6.6.6.6"},
			remoteAddr: "192.0.2.1:1234",
			trust:      false,
			want:       "192.0.2.1",
		},
		{
			name:       "untrusted: forged X-Real-IP is ignored",
			headers:    map[string]string{"X-Real-IP": "6.6.6.6"},
			remoteAddr: "192.0.2.1:1234",
			trust:      false,
			want:       "192.0.2.1",
		},
		{
			name:       "trusted: XFF wins",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.9"},
			remoteAddr: "192.0.2.1:1234",
			trust:      true,
			want:       "203.0.113.9",
		},
		{
			name:       "trusted: first XFF entry is the original client",
			headers:    map[string]string{"X-Forwarded-For": "203.0.113.9, 10.0.0.1, 10.0.0.2"},
			remoteAddr: "192.0.2.1:1234",
			trust:      true,
			want:       "203.0.113.9",
		},
		{
			name:       "trusted: X-Real-IP is the fallback",
			headers:    map[string]string{"X-Real-IP": "203.0.113.9"},
			remoteAddr: "192.0.2.1:1234",
			trust:      true,
			want:       "203.0.113.9",
		},
		{
			name:       "trusted: empty headers fall back to the peer",
			headers:    map[string]string{"X-Forwarded-For": "  ", "X-Real-IP": ""},
			remoteAddr: "192.0.2.1:1234",
			trust:      true,
			want:       "192.0.2.1",
		},
		{
			name:       "peer address without a port",
			remoteAddr: "192.0.2.1",
			trust:      false,
			want:       "192.0.2.1",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.RemoteAddr = tc.remoteAddr
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			if got := clientIP(req, tc.trust); got != tc.want {
				t.Errorf("clientIP = %q, want %q", got, tc.want)
			}
		})
	}
}

// Regression: trusting X-Forwarded-For unconditionally let any client mint a
// fresh rate-limit key per request, so the limiter never fired AND its bucket
// map grew once per forged address.
func TestRateLimitSurvivesForgedForwardingHeaders(t *testing.T) {
	app := newTestApp(t, func(c *Config) {
		c.IngestRateLimit = 3
		c.IngestRatePeriod = 60
		c.TrustProxy = false
	})

	post := func(xff string) int {
		req := httptest.NewRequest(http.MethodPost, "/feedback", nil)
		req.RemoteAddr = "192.0.2.50:9999"
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		return w.Code
	}

	// Burn the budget for this peer (400s: no body, but they still count).
	for i := 0; i < 3; i++ {
		if code := post(""); code == http.StatusTooManyRequests {
			t.Fatalf("request %d was limited while still inside the allowance", i+1)
		}
	}
	if code := post(""); code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 once the allowance is spent", code)
	}
	// A fresh forged IP on every request must NOT buy a fresh allowance.
	for i := 0; i < 5; i++ {
		if code := post(fmt.Sprintf("9.9.9.%d", i)); code != http.StatusTooManyRequests {
			t.Fatalf("forged X-Forwarded-For bypassed the rate limit (status %d)", code)
		}
	}
	if n := len(app.ingestLimiter.limiters); n != 1 {
		t.Errorf("limiter is tracking %d IPs, want 1 — forged headers must not grow the map", n)
	}
}

func TestRateLimitKeysSeparatelyPerRealIP(t *testing.T) {
	app := newTestApp(t, func(c *Config) {
		c.IngestRateLimit = 2
		c.IngestRatePeriod = 60
	})
	post := func(peer string) int {
		req := httptest.NewRequest(http.MethodPost, "/feedback", nil)
		req.RemoteAddr = peer + ":1000"
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		return w.Code
	}
	for i := 0; i < 2; i++ {
		post("192.0.2.1")
	}
	if code := post("192.0.2.1"); code != http.StatusTooManyRequests {
		t.Fatalf("first peer status = %d, want 429", code)
	}
	if code := post("192.0.2.2"); code == http.StatusTooManyRequests {
		t.Error("a second peer was limited by the first peer's traffic")
	}
}

func TestRateLimitDisabledWhenLimitIsZero(t *testing.T) {
	app := newTestApp(t, func(c *Config) { c.IngestRateLimit = 0 })
	if app.ingestLimiter != nil {
		t.Fatal("a limit of 0 must build no limiter at all")
	}
	for i := 0; i < 50; i++ {
		req := httptest.NewRequest(http.MethodPost, "/feedback", nil)
		req.RemoteAddr = "192.0.2.1:1000"
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("request %d was limited though limiting is disabled", i+1)
		}
	}
}

func TestRateLimitSendsRetryAfter(t *testing.T) {
	app := newTestApp(t, func(c *Config) {
		c.IngestRateLimit = 1
		c.IngestRatePeriod = 60
	})
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodPost, "/feedback", nil)
		req.RemoteAddr = "192.0.2.1:1000"
		w := httptest.NewRecorder()
		app.ServeHTTP(w, req)
		if w.Code == http.StatusTooManyRequests {
			if got := w.Header().Get("Retry-After"); got == "" {
				t.Error("a 429 must carry Retry-After")
			}
			if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Error("a 429 must carry CORS headers, or the widget cannot read it")
			}
			return
		}
	}
	t.Fatal("never hit the limit")
}

func TestTokenGatedRoutesAreNotRateLimited(t *testing.T) {
	app := newTestApp(t, func(c *Config) {
		c.ReadRateLimit = 1
		c.ReadRatePeriod = 60
	})
	// The token is the gate on these; they are server-to-server.
	for i := 0; i < 10; i++ {
		w, _ := do(t, app, http.MethodGet, "/feedback", "", authHeader())
		if w.Code != http.StatusOK {
			t.Fatalf("request %d = %d, want 200", i+1, w.Code)
		}
	}
}

func TestLimiterMapIsBounded(t *testing.T) {
	l := newIPRateLimiter(5, 60)
	for i := 0; i < maxTrackedIPs+500; i++ {
		l.allow(fmt.Sprintf("10.%d.%d.%d", i>>16&0xff, i>>8&0xff, i&0xff))
	}
	if n := len(l.limiters); n > maxTrackedIPs {
		t.Errorf("limiter is tracking %d IPs, want at most %d", n, maxTrackedIPs)
	}
}

func TestLimiterEvictsIdleEntries(t *testing.T) {
	l := newIPRateLimiter(5, 60)
	l.allow("192.0.2.1")
	l.allow("192.0.2.2")
	if len(l.limiters) != 2 {
		t.Fatalf("tracking %d IPs, want 2", len(l.limiters))
	}
	// Age one entry past the cutoff.
	l.mu.Lock()
	l.limiters["192.0.2.1"].lastSeen = time.Now().Add(-time.Hour)
	l.evictIdleLocked(time.Now().Add(-idleEviction))
	l.mu.Unlock()

	if _, ok := l.limiters["192.0.2.1"]; ok {
		t.Error("idle entry was not evicted")
	}
	if _, ok := l.limiters["192.0.2.2"]; !ok {
		t.Error("active entry was evicted")
	}
}

func TestNilLimiterAllowsEverything(t *testing.T) {
	var l *ipRateLimiter
	if !l.allow("192.0.2.1") {
		t.Error("a nil limiter must behave like an unconfigured binding")
	}
}

func TestEnvBool(t *testing.T) {
	for _, tc := range []struct {
		value string
		def   bool
		want  bool
	}{
		{"true", false, true},
		{"1", false, true},
		{"false", true, false},
		{"0", true, false},
		{"", true, true},          // unset keeps the default
		{"", false, false},        //
		{"yes-ish", false, false}, // unparseable keeps the default
		{"yes-ish", true, true},
	} {
		t.Setenv("TYREKICK_TEST_BOOL", tc.value)
		if got := envBool("TYREKICK_TEST_BOOL", tc.def); got != tc.want {
			t.Errorf("envBool(%q, def=%v) = %v, want %v", tc.value, tc.def, got, tc.want)
		}
	}
}

func TestNowISOMatchesJavaScriptToISOString(t *testing.T) {
	got := nowISO()
	if _, err := time.Parse("2006-01-02T15:04:05.000Z", got); err != nil {
		t.Errorf("nowISO() = %q, which is not a JS toISOString-shaped stamp: %v", got, err)
	}
	if got[len(got)-1] != 'Z' {
		t.Errorf("nowISO() = %q, want a UTC Z suffix", got)
	}
}

func TestTruncateRunesIsUnicodeSafe(t *testing.T) {
	for _, tc := range []struct {
		in   string
		n    int
		want string
	}{
		{"hello", 10, "hello"},
		{"hello", 5, "hello"},
		{"hello", 2, "he"},
		{"héllo", 2, "hé"},
		{"日本語テスト", 3, "日本語"},
		{"", 3, ""},
	} {
		if got := truncateRunes(tc.in, tc.n); got != tc.want {
			t.Errorf("truncateRunes(%q, %d) = %q, want %q", tc.in, tc.n, got, tc.want)
		}
	}
}

func TestNewUUIDv4Shape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := newUUIDv4()
		if len(id) != 36 {
			t.Fatalf("newUUIDv4() = %q, want 36 characters", id)
		}
		if id[14] != '4' {
			t.Errorf("newUUIDv4() = %q, want version nibble 4", id)
		}
		if c := id[19]; c != '8' && c != '9' && c != 'a' && c != 'b' {
			t.Errorf("newUUIDv4() = %q, want RFC 4122 variant", id)
		}
		if !uuidShapeRE.MatchString(id) {
			t.Errorf("newUUIDv4() = %q, which /receipts would reject", id)
		}
		if seen[id] {
			t.Fatalf("newUUIDv4() repeated %q", id)
		}
		seen[id] = true
	}
}

func TestIsValidStatus(t *testing.T) {
	for _, s := range []string{"open", "approved", "declined", "resolved"} {
		if !isValidStatus(s) {
			t.Errorf("isValidStatus(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"", "OPEN", "closed", "pending", "resolved "} {
		if isValidStatus(s) {
			t.Errorf("isValidStatus(%q) = true, want false", s)
		}
	}
}

func TestClampInt(t *testing.T) {
	for _, tc := range []struct{ n, lo, hi, want int }{
		{5, 1, 10, 5},
		{0, 1, 10, 1},
		{-5, 1, 10, 1},
		{99, 1, 10, 10},
	} {
		if got := clampInt(tc.n, tc.lo, tc.hi); got != tc.want {
			t.Errorf("clampInt(%d, %d, %d) = %d, want %d", tc.n, tc.lo, tc.hi, got, tc.want)
		}
	}
}
