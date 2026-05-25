.PHONY: lint typecheck test build lint-convex lint-dashboard lint-client typecheck-convex typecheck-dashboard test-client check

# Run all checks
check: lint typecheck test

# Lint all
lint: lint-convex lint-dashboard lint-client

lint-convex:
	bunx eslint convex/

lint-dashboard:
	cd dashboard && bunx eslint src/

lint-client:
	cd client && cargo clippy -- -D warnings

# Typecheck all
typecheck: typecheck-convex typecheck-dashboard

typecheck-convex:
	bunx tsc --noEmit -p convex/tsconfig.json

typecheck-dashboard:
	cd dashboard && tsc --noEmit

# Test all
test: test-client

test-client:
	cd client && cargo test

# Build
build:
	cd dashboard && bun run build
	cd client && cargo build --release
