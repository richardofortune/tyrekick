# syntax=docker/dockerfile:1

# --- Build stage ------------------------------------------------------------
FROM golang:1.25-alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
# CGO_ENABLED=0: modernc.org/sqlite is a pure-Go SQLite driver, so the binary
# builds fully static with no libsqlite3/gcc dependency in either stage.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/tyrekick-server .

# --- Runtime stage -----------------------------------------------------------
FROM alpine:3.20

# ca-certificates: outbound HTTPS to Discord/Anthropic when those optional
# integrations are enabled. sqlite: the `sqlite3` CLI, for poking the
# database directly (docker exec ... sqlite3 $DB_PATH), the parity feature to
# worker.ts's README "Raw KV access" section. tzdata: correct local-time
# rendering if an operator sets TZ.
RUN apk add --no-cache ca-certificates sqlite tzdata \
    && addgroup -S tyrekick \
    && adduser -S tyrekick -G tyrekick \
    && mkdir -p /data \
    && chown tyrekick:tyrekick /data

COPY --from=builder /out/tyrekick-server /usr/local/bin/tyrekick-server

USER tyrekick
VOLUME /data
ENV DB_PATH=/data/tyrekick.db
ENV PORT=8080
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/tyrekick-server"]
