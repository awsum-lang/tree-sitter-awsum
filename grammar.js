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
    // Zero-length token emitted by `src/scanner.c` whenever one or more
    // newlines are followed by a column-0 non-whitespace token (or EOF).
    // Used as the boundary between top-level items so that
    //
    //     main : IO Never Unit
    //     main = ...
    //
    // doesn't parse as a single type expression `IO Never Unit main`.
    $._layout_end,
  ],

  conflicts: $ => [
    // 'Just x' as a pattern atom vs 'Just x' as a constructor application
    // in expression position cannot be disambiguated by tree-sitter without
    // semantic context. Both interpretations are listed here.
    [$.pattern_constructor, $._atom],
    // Inside a `do`-block, `let n = e` is ambiguous: it can be a do_let
    // (which makes the let visible to subsequent do statements) or it
    // can start a do_expr containing a top-level let_expr. Both produce
    // the same highlight output.
    [$.let_expr, $.do_let],
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
    operator_name: $ => seq('(', '++', ')'),

    _param: $ => choice($.lower_id, $._paren_pattern),
    _paren_pattern: $ => seq('(', $._pattern, ')'),

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
      seq('(', $._type, ')'),
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
      field('parameter', $.lower_id),
      repeat(field('parameter', $.lower_id)),
      '->',
      field('body', $._expr),
    ),

    let_expr: $ => prec.right(seq(
      'let',
      $.let_binding,
      repeat($.let_binding),
      optional(seq('in', field('body', $._expr))),
    )),

    let_binding: $ => seq(
      field('pattern', $._pattern),
      optional(seq(':', field('binding_type', $._type))),
      '=',
      field('value', $._expr),
    ),

    do_block: $ => prec.right(seq('do', repeat($._do_stmt))),
    _do_stmt: $ => choice($.do_bind, $.do_let, $.do_expr),
    do_bind: $ => prec.right(seq(
      field('pattern', $._pattern),
      '<-',
      field('value', $._expr),
    )),
    do_let: $ => seq('let', $.let_binding),
    do_expr: $ => $._expr,

    case_expr: $ => prec.right(seq(
      'case',
      field('scrutinee', $._expr),
      'of',
      repeat($.case_arm),
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
      seq('(', $._expr, ')'),
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
    ),
    pattern_constructor: $ => prec.left(seq($.upper_id, repeat($._pattern_atom))),
    pattern_ascribe: $ => seq('(', $._pattern, ':', $._type, ')'),
    _pattern_atom: $ => choice(
      $.lower_id,
      $.upper_id,
      seq('(', $._pattern, ')'),
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
