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

// App holds the request-serving dependencies, replacing worker.ts's `env`
// parameter threaded through every handler.
type App struct {
	cfg           Config
	store         *Store
	ingestLimiter *ipRateLimiter
	readLimiter   *ipRateLimiter
	httpClient    *http.Client
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
