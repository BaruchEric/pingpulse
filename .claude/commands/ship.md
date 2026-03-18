Run the full ship pipeline: checks, commit, and push.

1. Run all project checks:
   - `bun run typecheck` (TypeScript strict type checking)
   - `bun run eslint` (ESLint strict rules, zero warnings allowed)
   - `bun run format:check` (Prettier format check)
   - `bun run lint` (TypeScript + Convex build + Vite build)
2. If any check fails, fix the issues and re-run until all pass.
3. Stage all changed files relevant to the current work.
4. Create a conventional commit message (feat/fix/refactor/docs/chore) with a concise summary of the changes.
5. Push to the current branch.
6. Report the commit hash, branch name, and any check results.

Do NOT skip checks. Do NOT commit if any check is failing.
