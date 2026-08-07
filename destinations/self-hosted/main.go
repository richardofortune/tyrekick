// Command tyrekick-server is a self-hosted Go/SQLite port of the Tyrekick
// Cloudflare Worker destination (../cloudflare/worker.ts). Same REST
// contract — POST /feedback ingest, token-gated GET/PATCH /feedback,
// GET /receipts, GET /shared — backed by a SQLite file instead of Workers
// KV, so it can run anywhere as a single container with one mounted volume.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// Config holds everything worker.ts reads from `env` (bindings + secrets),
// sourced from environment variables instead.
type Config struct {
	Port      string
	DBPath    string
	Token     string // TYREKICK_TOKEN — management routes
	ReviewKey string // TYREKICK_REVIEW_KEY — GET /shared

	DiscordWebhook  string // DISCORD_WEBHOOK — optional tee
	AnthropicAPIKey string // ANTHROPIC_API_KEY — optional AI acknowledgement
	AIDailyCap      int

	IngestRateLimit  int // requests per IngestRatePeriod per IP, 0 = disabled
	IngestRatePeriod int // seconds
	ReadRateLimit    int
	ReadRatePeriod   int

	// TrustProxy decides whether X-Forwarded-For / X-Real-IP may be believed
	// when keying the rate limiters. OFF by default: those headers are
	// client-supplied, so trusting them on a directly-exposed service turns
	// the rate limiter into a no-op (any client picks a fresh key per request)
	// AND into a memory-growth vector (one tracked bucket per forged IP).
	// Turn it on only when a reverse proxy you control sets them and strips
	// any client-supplied copies. The Worker never needs this switch:
	// CF-Connecting-IP is unforgeable at the edge.
	TrustProxy bool
}

func loadConfig() Config {
	return Config{
		Port:      envString("PORT", "8080"),
		DBPath:    envString("DB_PATH", "/data/tyrekick.db"),
		Token:     os.Getenv("TYREKICK_TOKEN"),
		ReviewKey: os.Getenv("TYREKICK_REVIEW_KEY"),

		DiscordWebhook:  os.Getenv("DISCORD_WEBHOOK"),
		AnthropicAPIKey: os.Getenv("ANTHROPIC_API_KEY"),
		AIDailyCap:      envInt("AI_DAILY_CAP", 500),

		// Defaults mirror wrangler.toml's INGEST_LIMITER / READ_LIMITER
		// examples: 15 comments/min per IP (generous for a human), 120
		// reads/min per IP (the widget polls ~2/min). Set either *_RATE_LIMIT
		// to 0 to disable, exactly like leaving a Workers binding unconfigured.
		IngestRateLimit:  envInt("INGEST_RATE_LIMIT", 15),
		IngestRatePeriod: envInt("INGEST_RATE_PERIOD_SECONDS", 60),
		ReadRateLimit:    envInt("READ_RATE_LIMIT", 120),
		ReadRatePeriod:   envInt("READ_RATE_PERIOD_SECONDS", 60),

		TrustProxy: envBool("TRUST_PROXY", false),
	}
}

func envString(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// envBool reads a boolean env var. Unparseable values fall back to def rather
// than silently reading as false — a typo in TRUST_PROXY should not quietly
// change the trust model in either direction.
func envBool(key string, def bool) bool {
	if v := os.Getenv(key); v != "" {
		if b, err := strconv.ParseBool(v); err == nil {
			return b
		}
	}
	return def
}

// App holds the request-serving dependencies, replacing worker.ts's `env`
// parameter threaded through every handler.
type App struct {
	cfg           Config
	store         *Store
	ingestLimiter *ipRateLimiter
	readLimiter   *ipRateLimiter
	httpClient    *http.Client

	// bg tracks the fire-and-forget work started by a request but outliving
	// it (the Discord tee, the AI acknowledgement) — Go's stand-in for the
	// Worker's ctx.waitUntil. See waitForBackground.
	bg sync.WaitGroup
}

// goBackground runs fn detached from the request that started it, while still
// keeping it visible to shutdown. Never call it with work the response
// depends on: nothing here can affect what the widget already received.
func (a *App) goBackground(fn func()) {
	a.bg.Add(1)
	go func() {
		defer a.bg.Done()
		fn()
	}()
}

// waitForBackground blocks until every goBackground task has finished, or
// until timeout. Called after srv.Shutdown: that waits for in-flight
// REQUESTS, but these tasks are detached from theirs, so without this the
// deferred store.Close() races them and their writes are lost.
func (a *App) waitForBackground(timeout time.Duration) {
	done := make(chan struct{})
	go func() {
		a.bg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(timeout):
		log.Printf("tyrekick: background tasks still running after %s — exiting anyway", timeout)
	}
}

func main() {
	cfg := loadConfig()

	store, err := OpenStore(cfg.DBPath)
	if err != nil {
		log.Fatalf("tyrekick: failed to open database at %s: %v", cfg.DBPath, err)
	}
	defer store.Close()

	app := &App{
		cfg:           cfg,
		store:         store,
		ingestLimiter: newIPRateLimiter(cfg.IngestRateLimit, cfg.IngestRatePeriod),
		readLimiter:   newIPRateLimiter(cfg.ReadRateLimit, cfg.ReadRatePeriod),
		httpClient:    &http.Client{Timeout: 10 * time.Second},
	}

	logStartup(cfg)

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           app,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serveErr := make(chan error, 1)
	go func() {
		serveErr <- srv.ListenAndServe()
	}()

	select {
	case err := <-serveErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("tyrekick: server error: %v", err)
		}
	case <-ctx.Done():
		log.Println("tyrekick: shutting down…")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("tyrekick: graceful shutdown failed: %v", err)
		}
		app.waitForBackground(15 * time.Second)
	}
}

// logStartup reports which optional features are active without ever
// printing a secret value — mirrors worker.ts's GET / health route, which
// advertises route names but never whether secrets are configured.
func logStartup(cfg Config) {
	log.Printf("tyrekick: listening on :%s (db=%s)", cfg.Port, cfg.DBPath)
	log.Printf("tyrekick: management routes %s", onOff(cfg.Token != ""))
	log.Printf("tyrekick: discord forwarding %s", onOff(cfg.DiscordWebhook != ""))
	log.Printf("tyrekick: ai acknowledgement %s", onOff(cfg.AnthropicAPIKey != ""))
	log.Printf("tyrekick: shared review %s", onOff(cfg.ReviewKey != ""))
	log.Printf("tyrekick: ingest rate limit %s", rateDesc(cfg.IngestRateLimit, cfg.IngestRatePeriod))
	log.Printf("tyrekick: read rate limit %s", rateDesc(cfg.ReadRateLimit, cfg.ReadRatePeriod))
	log.Printf("tyrekick: rate limits keyed on %s", ipSourceDesc(cfg.TrustProxy))
	if cfg.TrustProxy {
		log.Println("tyrekick: TRUST_PROXY=true — only safe if a proxy you control " +
			"sets X-Forwarded-For and strips client-supplied copies of it")
	}
}

func ipSourceDesc(trustProxy bool) string {
	if trustProxy {
		return "X-Forwarded-For / X-Real-IP (TRUST_PROXY=true)"
	}
	return "the connection's peer address (set TRUST_PROXY=true behind a proxy)"
}

func onOff(b bool) string {
	if b {
		return "enabled"
	}
	return "disabled (unset)"
}

func rateDesc(limit, period int) string {
	if limit <= 0 || period <= 0 {
		return "disabled"
	}
	return strconv.Itoa(limit) + " req / " + strconv.Itoa(period) + "s per IP"
}
