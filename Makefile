VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null | sed 's/^v//' || echo 0.0.0-dev)
COMMIT  ?= $(shell git rev-parse --short HEAD 2>/dev/null || echo none)
DATE    ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
PKG     := github.com/rhisijmuiden/unify-syslog-server/internal/version
LDFLAGS := -s -w -X $(PKG).Version=$(VERSION) -X $(PKG).Commit=$(COMMIT) -X $(PKG).BuildDate=$(DATE)

.PHONY: all web build test dist clean

all: build

web:
	cd web && npm ci && npm run build && touch dist/.gitkeep

build: web
	CGO_ENABLED=0 go build -trimpath -ldflags "$(LDFLAGS)" -o bin/unify-syslog ./cmd/unify-syslog

test:
	go test ./...

# Release tarballs + checksums, as consumed by the in-app updater and installer.
dist: web
	rm -rf dist && mkdir -p dist
	for arch in amd64 arm64; do \
		CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "$(LDFLAGS)" -o dist/unify-syslog ./cmd/unify-syslog && \
		tar -C dist -czf dist/unify-syslog-server_linux_$$arch.tar.gz unify-syslog && rm dist/unify-syslog; \
	done
	cd dist && sha256sum *.tar.gz > checksums.txt

clean:
	rm -rf bin dist web/dist/assets
