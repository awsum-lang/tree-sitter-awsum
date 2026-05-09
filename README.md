# tree-sitter-awsum

Tree-sitter grammar for the [Awsum](https://awsum-lang.org) programming language (`.aww` files).

The grammar drives **syntax highlighting** and the **outline view** in tree-sitter-aware editors — Zed (via the [`awsum-zed`](https://github.com/awsum-lang/awsum-zed) extension), Helix, Neovim, Emacs ts-mode. Precise diagnostics never come from this grammar; they come from the official Awsum compiler's Language Server (`awsum lsp`), which runs the real Megaparsec parser + typechecker and pushes results through LSP.

## What's covered

- Top-level declarations: `import`, `type`, `empty type`, signature (`name : Type`), function definition (`name args = body`).
- Identifiers (lowercase / uppercase, with optional `_` prefix), strings with escape sequences, integer literals (with `_` separators), comments (line + non-nested block).
- Operators: `|>`, `++`, function application, `->`, `|`, `:`, `<-`, `=`, `\\`.
- Patterns: bare names, constructor patterns, type-ascription patterns `(x : T)`.
- Expressions: `let … in`, `do { … }`, `case … of …`, lambdas, qualified names.

## Known limitations (v0)

- **Multi-line `case` arms** can produce `(ERROR …)` nodes when subsequent arms appear on indented lines. The external scanner only emits layout boundaries at column 0 (top-level decl boundary), not at the per-block indent levels that `case` / `do` / `let` use. Token-level highlighting still works around the error region; the LSP server delivers correct semantic state.
- **Nested block comments** (`{- {- inner -} outer -}`) parse only at the outer level.

The grammar is intentionally permissive — it is not a re-implementation of the compiler's frontend, and is not expected to reject malformed Awsum.

## Build

```bash
npm install                # install the tree-sitter CLI
npx tree-sitter generate   # produce src/parser.c from grammar.js
npx tree-sitter test       # run the corpus tests under test/corpus/
```

## Versioning

`tree-sitter-awsum` releases follow the `awsum` compiler version one-to-one: `tree-sitter-awsum A.B.C` is built and tested against `awsum A.B.C`. Same lockstep convention as `awsum-vscode` and `awsum-zed`.

## License

MIT — see [LICENSE](LICENSE).
