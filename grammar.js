/**
 * Tree-sitter grammar for the Awsum programming language.
 *
 * Source of truth for the surface forms is `awsum/docs/spec/grammar.ebnf`
 * in the compiler repo. This grammar is intentionally lenient — its
 * single job is correct syntax highlighting and a usable outline view
 * inside Tree-sitter-aware editors (Zed, Helix, Neovim, …). Precise
 * diagnostics never come from here; the LSP server (`awsum lsp`) drives
 * those by running the real Megaparsec parser + typechecker.
 *
 * Layout-sensitive forms (`do`-blocks, `case`-arms, multi-line `let`)
 * are accepted permissively without enforcing indentation. When the
 * source happens to be malformed at the layout level, Tree-sitter's
 * built-in error recovery emits an `(ERROR ...)` node and continues —
 * highlighting elsewhere in the file still works.
 *
 * Nested block comments (`{- {- inner -} outer -}`) are not handled by
 * the regex tokenizer; an external scanner would be required. For v0
 * we accept only flat block comments.
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
    $._layout_open,
    $._layout_end,
    $._layout_close,
    $._paren_open,
    $._paren_close,
    $._let_open,
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
    // `(name :` could be the start of a `pattern_ascribe` or a
    // `parens_pattern` whose inner pattern is being ascribed. The
    // grammar lets both shapes match `( _pattern` — fork until `:`
    // or `)` decides.
    [$.pattern_ascribe, $.parens_pattern],
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
    operator_name: $ => seq($._paren_open, '++', $._paren_close),

    _param: $ => choice($.lower_id, $._paren_pattern),
    _paren_pattern: $ => seq($._paren_open, $._pattern, $._paren_close),

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
      seq($._paren_open, $._type, $._paren_close),
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

    // `let` introduces a layout block: bindings on subsequent lines at
    // the same indent are siblings of the first binding. The closing
    // `in body` is optional (a `do`-internal `let` has no `in`).
    let_expr: $ => prec.right(seq(
      'let',
      $._let_open,
      $.let_binding,
      repeat(seq($._layout_end, $.let_binding)),
      // Scanner always emits `_layout_close` at end of bindings
      // (and pops the let-block stack entry). The optional `'in'
      // body` is then tokenised by tree-sitter's regular keyword
      // extraction at the post-close state, where `'in'` is a
      // valid lookahead and so wins over a generic `lower_id`.
      $._layout_close,
      optional(seq('in', field('body', $._expr))),
    )),

    let_binding: $ => seq(
      field('pattern', $._pattern),
      optional(seq(':', field('binding_type', $._type))),
      '=',
      field('value', $._expr),
    ),

    // `do` introduces a layout block: statements at the same indent
    // are siblings, separated by `_layout_end`.
    do_block: $ => prec.right(seq(
      'do',
      $._layout_open,
      $._do_stmt,
      repeat(seq($._layout_end, $._do_stmt)),
      $._layout_close,
    )),
    _do_stmt: $ => choice($.do_bind, $.do_let, $.do_expr),
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
      seq($._paren_open, $._expr, $._paren_close),
      $.string,
      $.integer,
    ),

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
    pattern_ascribe: $ => seq($._paren_open, $._pattern, ':', $._type, $._paren_close),
    // Parens-wrapped pattern with no ascription. Shares a `(` prefix
    // with `pattern_ascribe`; tree-sitter forks via the declared
    // conflict on `[$.pattern_ascribe, $.parens_pattern]`.
    parens_pattern: $ => seq($._paren_open, $._pattern, $._paren_close),
    _pattern_atom: $ => choice(
      $.lower_id,
      $.upper_id,
      $.parens_pattern,
      $.pattern_ascribe,
    ),

    // ─── Terminals ──────────────────────────────────────────────────────────

    string: $ => seq(
      '"',
      repeat(choice(
        $.escape_sequence,
        $._string_text,
      )),
      '"',
    ),
    escape_sequence: $ => /\\[ntr"\\0]/,
    _string_text: $ => /[^"\\]+/,

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
    // Non-nested block comment. Awsum actually allows nesting; covering
    // it here would require an external scanner. Files using nested
    // comments will get an (ERROR) node and the surrounding code
    // continues to highlight.
    block_comment: $ => seq('{-', /[\s\S]*?-\}/),
  },
});
