.PHONY: run run-web dev dev-backend dev-web dev-collector build-web build-backend build-collector collector-binary collector-downloads collector-downloads-all release-linux-amd64 release-linux-arm64 build db-migrate-up test deps-up deps-down test-deps-up test-deps-down test-office-postgres

COMPOSE_FILE := deploy/docker-compose.yaml
TEST_COMPOSE_FILE := deploy/docker-compose.test.yaml
TEST_DATABASE_URL := postgres://claw_mcp@localhost:5933/claw_mcp_test?sslmode=disable

run: db-migrate-up
	go run ./cmd/claw-mcp serve

run-web:
	cd web && pnpm dev --host 0.0.0.0

dev:
	./scripts/dev.sh

dev-backend:
	./scripts/dev-backend.sh

dev-web:
	./scripts/dev-web.sh

dev-collector:
	./scripts/dev-collector.sh

build-web:
	./scripts/build-web.sh

build-backend: build-web
	./scripts/build-backend.sh

build-collector: collector-downloads

collector-binary:
	./scripts/build-collector.sh

collector-downloads:
	COLLECTOR_OUTPUT="./public/collectors/$$(go env GOOS)/$$(go env GOARCH)/$$(if [ "$$(go env GOOS)" = "windows" ]; then printf clawee-collector.exe; else printf clawee-collector; fi)" ./scripts/build-collector.sh

collector-downloads-all:
	GOOS=darwin GOARCH=amd64 COLLECTOR_OUTPUT="./public/collectors/darwin/amd64/clawee-collector" ./scripts/build-collector.sh
	GOOS=darwin GOARCH=arm64 COLLECTOR_OUTPUT="./public/collectors/darwin/arm64/clawee-collector" ./scripts/build-collector.sh
	GOOS=linux GOARCH=amd64 COLLECTOR_OUTPUT="./public/collectors/linux/amd64/clawee-collector" ./scripts/build-collector.sh
	GOOS=linux GOARCH=arm64 COLLECTOR_OUTPUT="./public/collectors/linux/arm64/clawee-collector" ./scripts/build-collector.sh
	GOOS=windows GOARCH=amd64 COLLECTOR_OUTPUT="./public/collectors/windows/amd64/clawee-collector.exe" ./scripts/build-collector.sh
	GOOS=windows GOARCH=arm64 COLLECTOR_OUTPUT="./public/collectors/windows/arm64/clawee-collector.exe" ./scripts/build-collector.sh

release-linux-amd64:
	./scripts/package-release.sh

release-linux-arm64:
	TARGET_GOOS=linux TARGET_GOARCH=arm64 ./scripts/package-release.sh

build:
	$(MAKE) build-backend

db-migrate-up:
	./scripts/migrate-up.sh

test:
	./scripts/test.sh

deps-up:
	docker compose -f $(COMPOSE_FILE) up -d
	until docker compose -f $(COMPOSE_FILE) exec -T postgres pg_isready -U claw_mcp -d claw_mcp; do sleep 1; done

deps-down:
	docker compose -f $(COMPOSE_FILE) down

test-deps-up:
	docker compose -f $(TEST_COMPOSE_FILE) up -d

test-deps-down:
	docker compose -f $(TEST_COMPOSE_FILE) down

test-office-postgres:
	CLAW_MCP_TEST_DATABASE_URL='$(TEST_DATABASE_URL)' go test ./internal/office/store -count=1
	CLAW_MCP_TEST_DATABASE_URL='$(TEST_DATABASE_URL)' go test ./internal/office/httpapi -count=1
