FROM node:24-alpine AS web-builder
WORKDIR /src/web
RUN corepack enable
COPY server/web/package.json server/web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/web ./
COPY server/internal/server/webdist/embed.go /src/internal/server/webdist/embed.go
RUN pnpm build

FROM golang:1.25 AS backend-builder
ARG GOPROXY=https://proxy.golang.org,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/cmd ./cmd
COPY server/db ./db
COPY server/internal ./internal
COPY server/scripts ./scripts
COPY --from=web-builder /src/internal/server/webdist/dist ./internal/server/webdist/dist
ARG CLAW_MCP_VERSION=0.1.1
ARG CLAW_MCP_COMMIT=unknown
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "$(./scripts/buildinfo-ldflags.sh)" -o /out/claw-mcp ./cmd/claw-mcp \
    && mkdir -p /out/data/shared-files /out/data/skillhub/packages /out/data/skillhub/repositories \
    && for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do \
      export GOOS=${target%/*} GOARCH=${target#*/}; \
      suffix=""; if [ "$GOOS" = windows ]; then suffix=.exe; fi; \
      COLLECTOR_OUTPUT=/out/collectors/$target/clawee-collector$suffix ./scripts/build-collector.sh; \
    done

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend-builder /out/claw-mcp /app/claw-mcp
COPY --from=web-builder /src/internal/server/webdist/dist /app/static
COPY --from=backend-builder --chown=nonroot:nonroot /out/data /app/data
COPY --from=backend-builder /out/collectors /app/public/collectors
COPY LICENSE NOTICE /app/licenses/clawee/
COPY third_party /app/licenses/third_party
ENV CLAW_MCP_SHARED_FILES_STORAGE_ROOT=/app/data/shared-files
ENV CLAWEE_OPS_DIR=/run/clawee-ops
VOLUME ["/app/data"]
EXPOSE 1904
USER nonroot:nonroot
ENTRYPOINT ["/app/claw-mcp"]
CMD ["serve"]
