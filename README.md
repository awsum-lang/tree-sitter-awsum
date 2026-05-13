# tree-sitter-awsum

Tree-sitter grammar for the [Awsum](https://awsum-lang.org) programming language (`.aww` files).

The grammar drives **syntax highlighting** and the **outline view** in tree-sitter-aware editors — Zed (via the [`awsum-zed`](https://github.com/awsum-lang/awsum-zed) extension), Helix, Neovim, Emacs ts-mode. Precise diagnostics never come from this grammar; they come from the official Awsum compiler's Language Server (`awsum lsp`), which runs the real Megaparsec parser + typechecker and pushes results through LSP.

The grammar is tested against every `.aww` program in the compiler's test corpus (`awsum/test/sources/successful/` and `awsum/test/sources/property/`) — see [How the grammar is verified against the compiler](#how-the-grammar-is-verified-against-the-compiler) below. Anything those programs use, this grammar parses without error.

## How layout works

An external scanner (`src/scanner.c`) maintains an indent stack with one entry per active block. Six external tokens drive it:

- `_layout_open` / `_let_open` — pushed when the parser sees `do` / `of` / `let`. Captures the column of the first token inside the block plus the current paren-depth.
- `_layout_end` — sibling separator inside a block (column == top of stack); also serves as the top-level boundary on a column-0 newline / EOF.
- `_layout_close` — block exit: column < top of stack, EOF inside a block, or an enclosing `)` that's about to close.
- `_paren_open` / `_paren_close` — every `(` / `)` is routed through the scanner so paren-depth stays accurate. Layout tokens are suppressed while the current paren-depth exceeds the depth captured at block-open, which is what lets a multi-line `(…)` span layout boundaries cleanly.

The literal `'in'` keyword stays in the grammar as a regular tree-sitter token, matched by keyword-extraction in FOLLOW(`_layout_close`).

## Build

```bash
npm install                # install the tree-sitter CLI
npx tree-sitter generate   # produce src/parser.c from grammar.js
npx tree-sitter test       # run the corpus tests under test/corpus/
```

## How the grammar is verified against the compiler

Three test layers — all live in the compiler repo (`awsum/`), under a standalone `tree-sitter-tests` test-suite gated by a cabal flag so it doesn't run on CI:

- **Corpus.** Every `.aww` under `awsum/test/sources/successful/` and `awsum/test/sources/property/` is parsed by this grammar and asserted to produce no `(ERROR …)` / `(MISSING …)` nodes. These are the canonical surface-syntax fixtures the compiler itself accepts; if tree-sitter can't parse them, the grammar drifted from the language.

- **Queries.** Every `.scm` under `tree-sitter-awsum/queries/` is run against every `.aww` in the corpus via `tree-sitter query` and asserted to produce no `Query error` / `Invalid node type` / `Query compilation failed`. Catches grammar/queries drift — when a grammar change renames or hides a node type, the queries that reference it now have nowhere to bind, but the tree-sitter CLI prints those errors to stdout while exiting 0, so neither `tree-sitter generate` nor parse-only checks would notice.

- **Property.** For each QuickCheck-generated `Program`, render it via the compiler's `Awsum.Render.renderProgram` (the same pipeline `awsum format` uses), feed the output to `tree-sitter parse`, and assert the same no-error invariant. Drives the grammar past the corpus into rare combinations that arbitrary generation hits.

Run from inside `awsum/`:

```bash
just test-tree-sitter            # corpus only — fast, deterministic
just test-tree-sitter-property   # property only — slow, ~100 generated programs
```

Both recipes regenerate `src/parser.c` from `grammar.js` first and require:

- This repo (`tree-sitter-awsum/`) checked out next to `awsum/`, or `TREE_SITTER_AWSUM_DIR` set to its path.
- `node_modules/` populated inside it (`npm ci`). The compiler-side recipes invoke `npx tree-sitter` and the Haskell spec calls `node_modules/.bin/tree-sitter` directly — both deliberately ignore any global `tree-sitter` binary so the version pinned in this repo's `package-lock.json` is the only one that runs.

If either is missing, the test-suite falls back to a single `pendingWith` and the rest of the (compiler-side) test suite is unaffected.

## Versioning

`tree-sitter-awsum` releases follow the `awsum` compiler version one-to-one: `tree-sitter-awsum A.B.C` is built and tested against `awsum A.B.C`. Same lockstep convention as `awsum-vscode` and `awsum-zed`.

## License

MIT — see [LICENSE](LICENSE).
