# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

`tree-sitter-awsum` is versioned 1:1 with the `awsum` compiler — the grammar's `A.B.C` is exactly the `awsum` `A.B.C` it tracks. Same lockstep convention as `awsum-vscode` and `awsum-zed`: every `awsum` release ships a matching grammar release, the grammar is never released ahead of the compiler, and only the latest `awsum` release is supported.

Until `awsum 1.0.0`, the project does not follow SemVer — every release increments only the patch (`0.0.1 → 0.0.2 …`), and any release may break. The 1:1 lockstep above is the contract that does hold: within a single `0.0.x`, the grammar and the `awsum` it ships against are mutually compatible.

The version lives in two places — `package.json#version` and `tree-sitter.json#metadata.version`. Both must match (the value is embedded in the generated `src/parser.c` from `tree-sitter.json`, and read by npm from `package.json`). CI and `just lint` enforce that they agree, the same way `awsum-zed/build.rs` keeps `Cargo.toml` ↔ `extension.toml` in sync. If Rust / Python bindings are added later under `bindings/`, their per-binding version files (`Cargo.toml`, `pyproject.toml`) must match too, and the guard extends to them.

## [Unreleased]

## [0.0.5] - 2026-05-31

### Added

- **Expression-level type ascription `(e : T)`** — parsed as a dedicated `expr_ascribe` node that shares the `(` prefix with the parens-wrapped expression atom, mirroring the pattern-side `(p : T)`. Tracks the compiler's new expression-position ascription form.
- `SECURITY.md`, `CODE_OF_CONDUCT.md`, and `NOTICE`; DCO sign-off on contributions via the `prepare-commit-msg` hook (`just setup-dev`).

### Changed

- **License switched from MIT to Apache-2.0** (with an accompanying `NOTICE`).
- **Type references in signatures highlight via field-anchored rules.** Bare type leaves in `signature` / `arrow_type` / `union_type` type fields now paint as `@type`, replacing the previous over-broad "every `upper_id` outside a constructor slot" heuristic.

## [0.0.4] - 2026-05-13

### Added

- Initial release. Tree-sitter grammar for `.aww`, covering every surface form the Awsum compiler accepts: top-level type signatures and function definitions, `type` declarations with type parameters and constructors, lambda expressions (`\x -> e`), `do` blocks (with `let` and `<-`), `case` / `of` exhaustive matching, structural sums (`(A | B)`) and type-ascription patterns (`(x : T)`), the pipe operator (`|>`), qualified module names, line (`--`) and nested block (`{- -}`) comments, integer + string literals.
- **External scanner** (`src/scanner.c`) — indent-stack-based layout resolution with six external tokens (`_layout_open` / `_let_open` / `_layout_end` / `_layout_close` / `_paren_open` / `_paren_close`). Drives `do` / `of` / `let` blocks and lets multi-line `(…)` expressions span layout boundaries cleanly. The `'in'` keyword stays in the grammar as a regular tree-sitter token, matched in `FOLLOW(_layout_close)`.
- **Highlight query** (`queries/highlights.scm`) — token classes for comments, strings, integers, keywords, type names, constructors, function definitions, module-qualified names, the underscore-prefix convention for intentionally-unused bindings.
- **Outline query** (`queries/outline.scm`) — top-level functions, constants, and types; powers the breadcrumb / outline view in tree-sitter-aware editors.
- **Corpus tests** under `test/corpus/basic.txt`, run via `tree-sitter test`. The deeper verification (every `.aww` in the compiler's test suite parses without `(ERROR …)` / `(MISSING …)`, plus QuickCheck-generated programs through the same path) lives in the compiler repo's `tree-sitter-tests` suite — see `README.md`.
- `tree-sitter.json` — modern grammar manifest the tree-sitter CLI expects since 0.25. Holds grammar name, scope, file extensions, query paths, plus author / license / repository metadata. Carries `metadata.version`, which the CLI embeds in `src/parser.c` as `language.metadata.{major,minor,patch}_version`. Supersedes the deprecated `tree-sitter` field in `package.json`.
- Generation runs at **ABI 15** — enabled by the presence of `tree-sitter.json`. Bundles the language-name field (`language.name = "awsum"`) and supertype-count field in the generated C struct.
- Release workflow: pushing a `v*` tag builds the grammar, packages it via `npm pack`, and publishes a GitHub Release with the `.tgz` attached. Tag and `package.json` version must match, or the run fails before the build.
- Build provenance via `actions/attest-build-provenance@v4` on the published `.tgz` — each release asset gets a Sigstore-signed attestation tying it to the release workflow run and the tagged commit. Users verify with `gh attestation verify tree-sitter-awsum-X.Y.Z.tgz --repo awsum-lang/tree-sitter-awsum`.
- CI guards (all also runnable locally via `just lint`):
  - `tree-sitter generate` must emit no warnings — catches grammar drift (unnecessary conflicts, missing `tree-sitter.json`, unused rules) before it ships.
  - `package.json#version` and `tree-sitter.json#metadata.version` must match. Mirrors the `Cargo.toml` ↔ `extension.toml` build-time check in `awsum-zed`.
  - Committed `src/parser.c` / `src/grammar.json` / `src/node-types.json` must equal what `grammar.js` regenerates. Catches stale generated artefacts.
- `CONTRIBUTING.md` — dev-loop commands, signed-commits requirement on `main`, PR / CHANGELOG conventions, regenerate-after-grammar-changes reminder.
- `justfile` with `just generate` (regen + corpus test), `just lint` (the full CI guard set), and `just release` (read version from `package.json`, manual confirmation, tag and push). Mirrors `awsum-vscode/justfile` and `awsum-zed/justfile`.
- `tree-sitter-cli` pinned to `^0.25.0` in `package.json` and reproducibly resolved via the committed `package-lock.json` — CI installs via `npm ci`, so parser.c regeneration is bit-for-bit stable across runs.
- `src/scanner.c` and `tree-sitter.json` added to the `files` glob in `package.json` so they ship in the npm tarball (`scanner.c` was previously missing — npm consumers would have failed to compile the node binding).
