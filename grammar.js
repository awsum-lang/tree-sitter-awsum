/**
 * Tree-sitter grammar for the Awsum programming language.
 *
 * Source of truth for the surface forms is `awsum/docs/spec/grammar.ebnf`
 * in the compiler repo. This grammar is intentionally lenient — its
 * single job is correct syntax highlighting and a usable outline view
 * inside Tree-sitter-aware editors (Zed, Neovim, Emacs). Precise
 * diagnostics never come from here; the LSP server (`awsum lsp`) drives
 * those by running the real Megaparsec parser + typechecker.
 *
 * Layout-sensitive forms (`do`-blocks, `case`-arms, multi-line `let`)
 * are accepted permissively without enforcing indentation. When the
 * source happens to be malformed at the layout level, Tree-sitter's
 * built-in error recovery emits an `(ERROR ...)` node and continues —
 * highlighting elsewhere in the file still works.
 *
 * ──────────────────────────────────────────────────────────────────
 * DO NOT use `*?` / `+?` non-greedy quantifiers in token regexes.
 *
 * tree-sitter's regex engine matches them GREEDILY in practice. An
 * early regex `block_comment`, `seq('{-', /[\s\S]*?-\}/)`, consumed
 * everything up to the LAST `-}` in the buffer: on a file with two
 * block comments the first `{-` paired with the second `-}`,
 * collapsing the code between into one comment token, and the parser
 * entered runaway error recovery (22 GiB of RAM in 10 seconds on a
 * 4-line file). Use a negated character class with a plain greedy
 * `*` instead (as `line_comment` below does), so the match stops at
 * the first closer.
 * ──────────────────────────────────────────────────────────────────
 */

module.exports = grammar({
  name: 'awsum',

  extras: $ => [
    /\s/,
    $.line_comment,
    $.block_comment,
  ],

  word: $ => $.lower_id,

  externals: $ => [
    // Tokens emitted by `src/scanner.c`. See the scanner header for
    // the full indent-stack model.
    //
    //   * `_layout_open` — push (column, paren_depth, is_let=0) for a
    //     do / case block.
    //   * `_let_open` — push for a let block (is_let=1). Distinct
    //     from `_layout_open` so the scanner can gate the `in`-
    //     keyword close peek on the block kind: only let blocks have
    //     `in` as their single-line close marker.
    //   * `_layout_end` — sibling separator (column == top.col),
    //     also top-level boundary on column-0 newline / EOF.
    //   * `_layout_close` — block exit on dedent / EOF / `in` peek.
    //   * `_paren_open` / `_paren_close` — emitted on `(` / `)` to
    //     keep the scanner's paren_depth accurate so layout tokens
    //     stay suppressed while we're inside parens that opened
    //     after the current block began.
    //   * `_block_comment_content` — the text between a block
    //     comment's `{-` and its matching `-}`; see `block_comment`.
    $._layout_open,
    $._layout_end,
    $._layout_close,
    $._paren_open,
    $._paren_close,
    $._let_open,
    $._block_comment_content,
  ],

  conflicts: $ => [
    // 'Just x' as a pattern atom vs 'Just x' as a constructor application
    // in expression position cannot be disambiguated by tree-sitter without
    // semantic context. Both interpretations are listed here.
    [$.pattern_constructor, $._atom],
    // After `do`, `(x)` is ambiguous: it could be a `do_expr` containing
    // a parenthesised expression, or a `do_bind` whose pattern is a
    // parens-wrapped binding-name (followed by `<-` …). The two share
    // the prefix `(_id`; tree-sitter needs to fork until `<-` (or its
    // absence) decides.
    [$._atom, $._pattern],
    // A let-item starting `n : T …` is a `let_signature` (own-line form)
    // until a following `=` reveals it was a `let_binding` with an inline
    // ascription; the binder forks between `let_signature`'s name and the
    // `_pattern` heading a `let_binding`.
    [$.let_signature, $._pattern],
  ],

  rules: {
    source_file: $ => seq(
      repeat(seq($.import_decl, optional($._layout_end))),
      repeat(seq($._top_item, optional($._layout_end))),
    ),

    // ─── Imports ────────────────────────────────────────────────────────────

    import_decl: $ => seq('import', field('module', $.module_path)),
    module_path: $ => prec.left(seq($.upper_id, repeat(seq('.', $.upper_id)))),

    // ─── Top-level items ────────────────────────────────────────────────────

    // `prec.dynamic(2, ...)` here, paired with the same on `fun_def`,
    // biases tree-sitter to start a new top-level item rather than
    // extend whatever inner construct (type_app, app) is in progress.
    // This is the only knob that consistently makes
    //
    //     main : IO Never Unit
    //     main = ...
    //
    // parse as two siblings (signature + fun_def) instead of letting
    // the second `main` sink into the type expression.
    _top_item: $ => prec.dynamic(2, choice(
      $.empty_type_decl,
      $.type_decl,
      $.signature,
      $.fun_def,
    )),

    // `empty type X`. No type parameters, no constructors — that's the
    // whole point of the form (row identity, see compiler docs).
    empty_type_decl: $ => seq('empty', 'type', field('name', $.upper_id)),

    type_decl: $ => prec.right(seq(
      'type',
      field('name', $.upper_id),
      repeat(field('parameter', $.lower_id)),
      optional(seq('=', $._con_def_list)),
    )),

    _con_def_list: $ => seq($.con_def, repeat(seq('|', $.con_def))),
    // `prec.dynamic(1, ...)` biases tree-sitter to extend a constructor
    // definition rather than close it and start a new top-level item.
    // Without it, `type T = Just a` parses with `a` re-interpreted as a
    // sibling fun_def name, because both paths are syntactically valid
    // until layout context (which we don't track) decides for one of them.
    con_def: $ => prec.dynamic(1, prec.right(seq(
      field('name', $.upper_id),
      repeat($._type_atom),
    ))),

    signature: $ => seq(
      field('name', $._decl_name),
      ':',
      field('type', $._type),
    ),

    // `prec.dynamic(2, ...)` biases tree-sitter to start a new fun_def
    // (closing whatever signature came before) over extending the
    // signature's type with the new `name` token. Without it, the
    // canonical pattern
    //
    //     foo : Int32 -> Int32
    //     foo n = n
    //
    // parses with `foo` (the second one) absorbed as a type_app `arg`
    // because layout-blind tree-sitter cannot see the newline boundary.
    fun_def: $ => prec.dynamic(2, prec.right(seq(
      field('name', $._decl_name),
      repeat(field('parameter', $._param)),
      '=',
      field('body', $._expr),
    ))),

    // The bundled prelude spells the concat operator's binding as
    // `(++) = …` so hover / go-to-definition on `a ++ b` lands on the
    // same definition. Syntactically allowed in user code too, but
    // practically prelude-only.
    _decl_name: $ => choice($.lower_id, $.operator_name),
    operator_name: $ => seq(alias($._paren_open, '('), '++', alias($._paren_close, ')')),

    // A parameter (function definition or lambda — both reach here)
    // is a bare name, a parens-wrapped destructuring pattern `(p)`, or
    // a parens-wrapped type ascription `(p : T)`. The ascription form
    // reuses the `pattern_ascribe` node from the pattern side, so the
    // `(pattern_ascribe (lower_id) @variable.parameter)` highlight rule
    // covers it with no query change. `pattern_ascribe` and
    // `_paren_pattern` share the `(` prefix; tree-sitter forks on the
    // post-pattern `:` vs `)` lookahead, same as on the `_pattern` side.
    //
    // The grammar is lenient by design: it accepts `f (x : T) = …` even
    // though the typechecker rejects a type annotation on a top-level
    // parameter (the type comes from the signature). Highlighting is the
    // grammar's job; the LSP drives diagnostics.
    _param: $ => choice($.lower_id, $._paren_pattern, $.pattern_ascribe),
    _paren_pattern: $ => seq(alias($._paren_open, '('), $._pattern, alias($._paren_close, ')')),

    // ─── Types ──────────────────────────────────────────────────────────────
    // Precedence (loosest → tightest): '|' < '->' < TypeApp < TypeAtom.
    // '|' and '->' are right-associative; TypeApp is left-associative.
    // Same flattened idiom as `_op_expr` — each operator is one rule
    // with explicit numeric precedence + associativity.

    _type: $ => choice(
      $.union_type,
      $.arrow_type,
      $.type_app,
      $._type_atom,
    ),
    union_type: $ => prec.right(1, seq(
      field('left', $._type),
      '|',
      field('right', $._type),
    )),
    arrow_type: $ => prec.right(2, seq(
      field('domain', $._type),
      '->',
      field('codomain', $._type),
    )),
    type_app: $ => prec.left(3, seq(
      field('callee', $._type),
      field('arg', $._type_atom),
    )),

    _type_atom: $ => choice(
      $.upper_id,
      $.lower_id,
      seq(alias($._paren_open, '('), $._type, alias($._paren_close, ')')),
    ),

    // ─── Expressions ────────────────────────────────────────────────────────

    // Expressions split into "wide" forms (lambda / let / do / case —
    // bodies extend right as far as possible) and "operator" forms.
    // Standard Tree-sitter idiom: each binary operator is one rule with
    // its own associativity + numeric precedence; the dispatch goes
    // through `_op_expr`.
    _expr: $ => choice(
      $.lambda,
      $.let_expr,
      $.do_block,
      $.case_expr,
      $._op_expr,
    ),

    _op_expr: $ => choice(
      $.pipe_expr,
      $.concat_expr,
      $.app,
      $._atom,
    ),

    lambda: $ => seq(
      '\\',
      field('parameter', $._param),
      repeat(field('parameter', $._param)),
      '->',
      field('body', $._expr),
    ),

    // `let` introduces a layout block: items on subsequent lines at the
    // same indent are siblings of the first. An item is an ordinary
    // binding (`pat [: T] = e`) or an own-line signature (`n : T`) whose
    // definition (`n = e`) follows as the next item. The closing
    // `in body` is optional (a `do`-internal `let` has no `in`).
    let_expr: $ => prec.right(seq(
      'let',
      $._let_open,
      $._let_item,
      repeat(seq($._layout_end, $._let_item)),
      // Scanner always emits `_layout_close` at end of bindings
      // (and pops the let-block stack entry). The optional `'in'
      // body` is then tokenised by tree-sitter's regular keyword
      // extraction at the post-close state, where `'in'` is a
      // valid lookahead and so wins over a generic `lower_id`.
      $._layout_close,
      optional(seq('in', field('body', $._expr))),
    )),

    // `prec.dynamic(2, ...)` mirrors top-level signature/fun_def: it
    // biases tree-sitter to start a new let-item over extending the
    // previous item's type with the next binder. Without it the own-line
    // `n : T` / `n = e` shape sinks the definition's `n` into the
    // signature's type as a `type_app` arg (layout-blind, same as the
    // top-level `foo : T` / `foo n = …` case).
    _let_item: $ => prec.dynamic(2, choice($.let_signature, $.let_binding)),

    // Own-line signature: `n : T`, with the definition `n = e` on the
    // next line as its own item. `prec.dynamic(3, …)` (above
    // `let_binding`'s 2) makes reducing the signature win over extending
    // its type with the next line's binder; the inline `n : T = e` form
    // still parses as a `let_binding` because the trailing `=` leaves the
    // signature interpretation with nowhere to go.
    let_signature: $ => prec.dynamic(3, seq(
      field('name', $.lower_id),
      ':',
      field('type', $._type),
    )),

    let_binding: $ => prec.dynamic(2, prec.right(seq(
      field('pattern', $._pattern),
      optional(seq(':', field('binding_type', $._type))),
      '=',
      field('value', $._expr),
    ))),

    // `do` introduces a layout block: statements at the same indent
    // are siblings, separated by `_layout_end`.
    do_block: $ => prec.right(seq(
      'do',
      $._layout_open,
      $._do_stmt,
      repeat(seq($._layout_end, $._do_stmt)),
      $._layout_close,
    )),
    // `let` at the start of a do-stmt is ambiguous: it can be
    // `do_let` (no `in`, just `let pat = expr`) or `do_expr` whose
    // body is a `let_expr` (opens a let-block via `_let_open`,
    // requires `_layout_close`, optional `in body`). In a do-stmt
    // position the user normally means `do_let` — the scanner
    // doesn't emit `_layout_close` for a let-block that ends at a
    // do-block sibling boundary (column-equality emits LAYOUT_END,
    // not LAYOUT_CLOSE), so the `do_expr → let_expr` branch never
    // closes and degrades to ERROR. `prec.dynamic` biases tree-
    // sitter toward `do_let` so the do-stmt completes cleanly even
    // when the binding's value is a multi-line / parens-spanning
    // expression like `let b = (let p = e in q) (r)`.
    _do_stmt: $ => choice($.do_bind, prec.dynamic(1, $.do_let), $.do_expr),
    do_bind: $ => prec.right(seq(
      field('pattern', $._pattern),
      '<-',
      field('value', $._expr),
    )),
    do_let: $ => seq('let', $.let_binding),
    do_expr: $ => $._expr,

    // `case … of` introduces a layout block whose siblings are arms.
    // Arms at the same indent are separated by `_layout_end`.
    case_expr: $ => prec.right(seq(
      'case',
      field('scrutinee', $._expr),
      'of',
      $._layout_open,
      $.case_arm,
      repeat(seq($._layout_end, $.case_arm)),
      $._layout_close,
    )),
    case_arm: $ => prec.right(seq(
      field('pattern', $._pattern),
      '->',
      field('body', $._expr),
    )),

    // Operator chain (lowest → highest precedence):
    //   1: |>   left-assoc
    //   2: ++   left-assoc
    //   3: app  left-assoc (juxtaposition)
    pipe_expr: $ => prec.left(1, seq($._op_expr, '|>', $._op_expr)),
    concat_expr: $ => prec.left(2, seq($._op_expr, '++', $._op_expr)),
    app: $ => prec.left(3, seq($._op_expr, $._atom)),

    _atom: $ => choice(
      $.qname,
      $.upper_id,
      $.lower_id,
      seq(alias($._paren_open, '('), $._expr, alias($._paren_close, ')')),
      $.expr_ascribe,
      $.string,
      $.integer,
    ),
    // Expression-level type ascription `(e : T)`. Shares the `(` prefix
    // with the parens-wrapped expression atom; tree-sitter forks on the
    // post-expr `:` vs `)` lookahead — same shape as the
    // `pattern_ascribe` / `parens_pattern` pairing on the pattern side.
    expr_ascribe: $ => seq(alias($._paren_open, '('), $._expr, ':', $._type, alias($._paren_close, ')')),

    // Qualified identifier: at least one `Mod.` prefix, then a lower id.
    // Disambiguated from a sequence of `Mod` atoms in App by the dot.
    qname: $ => seq(
      $.upper_id,
      '.',
      repeat(seq($.upper_id, '.')),
      $.lower_id,
    ),

    // ─── Patterns ───────────────────────────────────────────────────────────

    _pattern: $ => choice(
      $.pattern_constructor,
      $.lower_id,
      $.pattern_ascribe,
      $.parens_pattern,
    ),
    pattern_constructor: $ => prec.left(seq($.upper_id, repeat($._pattern_atom))),
    pattern_ascribe: $ => seq(alias($._paren_open, '('), $._pattern, ':', $._type, alias($._paren_close, ')')),
    // Parens-wrapped pattern with no ascription. Shares a `(` prefix
    // with `pattern_ascribe`; tree-sitter forks via the declared
    // conflict on `[$.pattern_ascribe, $.parens_pattern]`.
    parens_pattern: $ => seq(alias($._paren_open, '('), $._pattern, alias($._paren_close, ')')),
    _pattern_atom: $ => choice(
      $.lower_id,
      $.upper_id,
      $.parens_pattern,
      $.pattern_ascribe,
    ),

    // ─── Terminals ──────────────────────────────────────────────────────────

    // String literal as a single lexer token via `token(...)`. A
    // composite `seq('"', repeat(...), '"')` lets the global extras
    // pipeline (`line_comment` / `block_comment`) compete for the
    // body's lexer slot — `"--"` would then parse with a
    // `line_comment` node covering the inner `--"`, the closing
    // quote goes MISSING, and the rest of the file degenerates.
    // `token.immediate` on the inner pieces is NOT enough: it
    // gates only "no extras BEFORE this token", not "extras
    // disallowed for the lexer-choice at this position", so an
    // overlapping line_comment still wins on length.
    //
    // Trade-off: per-escape `escape_sequence` sub-nodes are gone.
    // Editors that highlight escapes do it via a #match? regex in
    // queries/highlights.scm against the whole string node.
    string: $ => token(seq(
      '"',
      repeat(choice(
        /\\[ntr"\\0]/,
        /[^"\\]+/,
      )),
      '"',
    )),

    // Optional leading '-' followed by digits with optional `_` separators
    // (no two consecutive '_' or trailing '_'; surface grammar enforces
    // that, but we accept loose forms here — the LSP catches semantically
    // invalid literals).
    integer: $ => /-?\d(_?\d)*/,

    // Identifier classes.
    //   lower_id: starts with lowercase OR underscore-followed-by-lowercase,
    //             and the bare wildcard '_' (the parser/typechecker decide
    //             where '_' is acceptable; we accept it everywhere).
    //   upper_id: starts with uppercase, OR '_' followed by uppercase.
    //
    // Listing the underscore variants /first/ matters: tree-sitter's
    // alternation picks the first match, and `_Foo` should not be
    // mistaken for `_` followed by `Foo`.
    lower_id: $ => /_[a-z][A-Za-z0-9_']*|[a-z][A-Za-z0-9_']*|_/,
    upper_id: $ => /_[A-Z][A-Za-z0-9_']*|[A-Z][A-Za-z0-9_']*/,

    line_comment: $ => token(seq('--', /[^\n]*/)),
    // Block comment. Comments nest (`{- a {- b -} c -}` is one
    // comment, as in the compiler), which no regex can match, so the
    // delimiters are ordinary tokens and the content between them is
    // an external token that `src/scanner.c` reads with a depth
    // counter. An internal `{-` keeps the layout tokens firing
    // (zero-width) before the comment, as before any other extra.
    block_comment: $ => seq('{-', $._block_comment_content, '-}'),
  },
});
