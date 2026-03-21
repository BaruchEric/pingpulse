.PHONY: lint typecheck test build lint-worker lint-dashboard lint-client typecheck-worker typecheck-dashboard test-worker test-client check

# Run all checks
check: lint typecheck test

# Lint all
lint: lint-worker lint-dashboard lint-client

lint-worker:
	cd worker && bunx eslint src/

lint-dashboard:
	cd worker/dashboard && bunx eslint src/

lint-client:
	cd client && cargo clippy -- -D warnings

# Typecheck all
typecheck: typecheck-worker typecheck-dashboard

typecheck-worker:
	cd worker/dashboard && tsc --noEmit

typecheck-dashboard:
	cd worker/dashboard && tsc --noEmit

# Test all
test: test-worker test-client

test-worker:
	cd worker && bun run test

test-client:
	cd client && cargo test

# Build
build:
	cd worker && bun run build
	cd client && cargo build --release
