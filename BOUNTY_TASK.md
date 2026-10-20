# Bounty Objective: TSPerf challenge submission: TypeLoad — real compiler-level type load-time analytics (MIT, installable VSIX)
Target: tsperf/tracer Issue #116
URL: https://github.com/tsperf/tracer/issues/116

## Issue Description
Submission for the TSPerf challenge (https://algora.io/challenges/tsperf).

Note: PRs/issues on algora-io/algora are restricted to prior contributors (tried: PR branch AmirDiaz/algora@tsperf-typeload-submission + issue, both blocked), so submitting here at the challenge-referenced repo.

**Links**
- Source (MIT): https://github.com/AmirDiaz/typeload
- Installable VSIX release: https://github.com/AmirDiaz/typeload/releases/tag/v0.1.0 (asset: typeload-0.1.0.vsix)

**What it does**
A VS Code extension that shows the complexity / time to load of a type in TypeScript, measured inside the compiler:
- **First-touch time (ms)** per declaration — the wall-clock cost of the first `getTypeAtLocation` on the declaration in a fresh program (the cost you pay on file open / build cold-start).
- **Checker instantiations** and **types created** per declaration — read from the TS 5.x checker counters (`getInstantiationCount`, `getTypeCount`), the same instrumentation technique as `@definitelytyped/perf`.
- Surfaces the numbers as **CodeLens** above each declaration (`⚡ 6.8 ms · 161 inst · 130 types`), a **slowest-types leaderboard** webview with per-file aggregates and click-to-jump, and an **isolated cursor re-measurement** command.
- Each run spawns a **fresh worker process** and resolves the **project's own TypeScript** from its node_modules (bundled fallback), so results are version-accurate and comparable across runs.

**Why different from prior entries**: existing entries time language-service responses (editor overhead included) or score complexity from the rendered type string (ignores caching, laziness, aliasing). TypeLoad reads the compiler's real counters around each declaration's first resolution.

**Verification**: `npm run compile` clean; `npm test` 6/6 headless engine + worker CLI tests; packaged with `vsce package` (4.3 MB VSIX attached to the release).

Relates to the tracer README help-wanted items: extended diagnostics from compiler/tsserver APIs, and better data display (CodeLens + leaderboard).

Happy to iterate — including a `tsc --generateTrace` cross-check view — if maintainers want more before considering it a successful solution.

## Instructions for Kuro (Autonomous Solver):
1. Use skills: `systematic-debugging` and `code-review-and-quality`.
2. Inspect the repository structure, locate relevant files, and understand the bug/feature.
3. Apply the minimal, robust fix or implementation.
4. Run any existing test suites or linters in the workspace.
5. Ensure the fix adheres to the project's existing code style.
6. When done, output a summary of files modified and verification results.
