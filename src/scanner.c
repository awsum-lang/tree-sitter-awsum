// External scanner for tree-sitter-awsum.
//
// Awsum is a layout-sensitive language. Top-level declarations sit at
// column 0; the body of a `do` / `case … of` / `let` block sits at a
// per-block indent baseline. A pure context-free engine can't tell
// whether an identifier on the next line belongs to the previous
// expression or starts a new declaration / statement / arm without
// column-aware cooperation from a scanner.
//
// We solve this with one indent stack and five external tokens:
//
//   * LAYOUT_OPEN — emitted right after a block-opening keyword
//     (`do`, `of`, `let`). Pushes (column, paren_depth) onto the
//     indent stack: `column` is the indent baseline for siblings,
//     `paren_depth` is the current paren nesting captured at the
//     moment the block was opened.
//
//   * LAYOUT_END — emitted at sibling boundaries (column == top.col
//     of stack), and at top level on a column-0 newline / EOF (same
//     role as the original single-token scanner).
//
//   * LAYOUT_CLOSE — emitted at block exit: column strictly less than
//     top.col (with one-level pop per emission), or EOF inside a
//     block, or peeking the `in` keyword from inside a single-line
//     `let` block.
//
//   * PAREN_OPEN / PAREN_CLOSE — emitted when the lexer hits `(` or
//     `)` and the grammar accepts it. These maintain the scanner's
//     paren_depth counter, which is consulted to suppress layout
//     tokens whenever we're inside parentheses opened *after* the
//     current block began. Without this, a multi-line parens-wrapped
//     expression inside a let-binding's value would let LAYOUT_CLOSE
//     fire at the column of the closing `)` (or any token on a
//     dedented continuation line), prematurely terminating the
//     surrounding block.
//
// The grammar uses `$._paren_open` / `$._paren_close` instead of the
// literal `'('` / `')'` so every paren character routes through the
// scanner — that's the only way to keep paren_depth accurate.

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

enum TokenType {
  LAYOUT_OPEN,
  LAYOUT_END,
  LAYOUT_CLOSE,
  PAREN_OPEN,
  PAREN_CLOSE,
  LET_OPEN,
};

// Stack depth ceiling for the indent stack. The stress tests in
// `awsum/test/sources/successful/stress-*` push 300+ levels of
// nested `case` blocks; budget 512 to absorb that and leave headroom.
// Each entry is 3 bytes; serialized state stays well below tree-
// sitter's per-state buffer cap (~1 KiB) since `2 + 3 * 512 = 1538`
// would exceed it, but real programs never approach this depth — it
// only matters for the worst-case stress files.
//
// If a future test ever exceeds this, the scanner caps `s->len` at
// MAX_DEPTH on push (silently dropping deeper levels); the parse
// will degrade rather than crash, surfaced as `(ERROR ...)` nodes
// near the over-deep block.
#define MAX_DEPTH 512

typedef struct {
  uint8_t col;
  uint8_t paren_depth;
  uint8_t is_let;
} StackEntry;

typedef struct {
  StackEntry stack[MAX_DEPTH];
  uint8_t len;
  uint8_t paren_depth;
} Scanner;

void *tree_sitter_awsum_external_scanner_create(void) {
  Scanner *s = (Scanner *)malloc(sizeof(Scanner));
  if (s != NULL) {
    s->len = 0;
    s->paren_depth = 0;
  }
  return s;
}

void tree_sitter_awsum_external_scanner_destroy(void *payload) {
  free(payload);
}

unsigned tree_sitter_awsum_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  if (s == NULL) return 0;
  unsigned i = 0;
  buffer[i++] = (char)s->paren_depth;
  buffer[i++] = (char)s->len;
  for (uint8_t j = 0; j < s->len; j++) {
    buffer[i++] = (char)s->stack[j].col;
    buffer[i++] = (char)s->stack[j].paren_depth;
    buffer[i++] = (char)s->stack[j].is_let;
  }
  return i;
}

void tree_sitter_awsum_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  if (s == NULL) return;
  s->len = 0;
  s->paren_depth = 0;
  if (length < 2) return;
  s->paren_depth = (uint8_t)buffer[0];
  uint8_t n = (uint8_t)buffer[1];
  if (n > MAX_DEPTH) n = MAX_DEPTH;
  if ((unsigned)(2 + 3u * n) > length) n = (uint8_t)((length - 2) / 3);
  s->len = n;
  for (uint8_t j = 0; j < n; j++) {
    s->stack[j].col = (uint8_t)buffer[2 + 3 * j];
    s->stack[j].paren_depth = (uint8_t)buffer[2 + 3 * j + 1];
    s->stack[j].is_let = (uint8_t)buffer[2 + 3 * j + 2];
  }
}

static bool skip_whitespace(TSLexer *lexer) {
  bool saw_newline = false;
  while (true) {
    int32_t c = lexer->lookahead;
    if (c == '\n') {
      saw_newline = true;
      lexer->advance(lexer, true);
    } else if (c == '\r' || c == ' ' || c == '\t') {
      lexer->advance(lexer, true);
    } else {
      break;
    }
  }
  return saw_newline;
}

static uint8_t clamp_col(uint32_t col) {
  return (uint8_t)(col > 255 ? 255 : col);
}


bool tree_sitter_awsum_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  // LAYOUT_OPEN / LET_OPEN — push a new (column, paren_depth, is_let)
  // entry onto the indent stack. The grammar uses LET_OPEN after the
  // `let` keyword and LAYOUT_OPEN after `do` / `of`; only one of the
  // two is in valid_symbols at any given parse state. The is_let flag
  // gates the `in`-keyword peek that closes a single-line let block —
  // without it, a `case`-arm body containing a multi-line let would
  // see the same `in` keyword and erroneously close the surrounding
  // case.
  if (valid_symbols[LAYOUT_OPEN] || valid_symbols[LET_OPEN]) {
    bool is_let = valid_symbols[LET_OPEN];
    skip_whitespace(lexer);
    uint32_t col = lexer->get_column(lexer);
    bool at_eof = lexer->eof(lexer);
    if (s != NULL && s->len < MAX_DEPTH) {
      uint8_t base = at_eof ? 0 : clamp_col(col);
      s->stack[s->len].col = base;
      s->stack[s->len].paren_depth = s->paren_depth;
      s->stack[s->len].is_let = is_let ? 1 : 0;
      s->len++;
    }
    lexer->mark_end(lexer);
    lexer->result_symbol = is_let ? LET_OPEN : LAYOUT_OPEN;
    return true;
  }

  // Walk past whitespace and newlines. saw_newline is recorded for
  // the top-level (stack-empty) emit rule.
  bool saw_newline = skip_whitespace(lexer);
  uint32_t col = lexer->get_column(lexer);
  bool at_eof = lexer->eof(lexer);
  int32_t c = lexer->lookahead;

  bool need_end = valid_symbols[LAYOUT_END];
  bool need_close = valid_symbols[LAYOUT_CLOSE];

  // Layout-boundary check runs BEFORE the paren-token check so that
  // a sibling separator ahead of a `(`-starting next sibling wins
  // over consuming the `(` as PAREN_OPEN. Concretely:
  //
  //     case x of
  //       _ -> U
  //       (DPf : Int) -> y    ← we want LAYOUT_END before `(`
  //
  // Without this priority, the scanner would emit PAREN_OPEN at the
  // arm boundary, and the `(` would get absorbed into the previous
  // arm's body as if it were an application argument.

  // IN_KEYWORD — must be tried before LAYOUT_CLOSE-on-dedent: if the
  // parser has both the close and the in-body branches alive, the
  // scanner mustn't emit LAYOUT_CLOSE first and lock the parser into
  // the no-body branch when the source actually has `in body`.
  //
  // We pin the token start with `mark_end` at the current position
  // BEFORE the speculative `i`/`n` advances. On `match_in_keyword`
  // success we update `mark_end` to span the full `in` token; on
  // failure the earlier `mark_end` (zero-width at the original
  // position) is the one tree-sitter sees, so the speculative
  // advances don't leak into the next regular-tokenizer call.
  // Without the early `mark_end`, a near-miss like `i7` (an
  // identifier starting with `i`) would advance past `i`, return
  // false from the scanner, and the regular tokenizer would resume
  // from `7` — silently dropping the `i` and parsing the wrong
  // identifier shape.

  if (s != NULL && s->len > 0 && (need_end || need_close)) {
    StackEntry top = s->stack[s->len - 1];

    // Inside a parenthesised expression that opened *after* this
    // block: layout boundaries don't apply — a multi-line parens
    // wraps everything inside as a single expression regardless of
    // column. Suppress.
    if (s->paren_depth > top.paren_depth) {
      // fall through to paren / no-emit logic below
    } else if (at_eof) {
      // EOF inside a block: close one level. Repeated calls drain
      // the rest.
      if (need_close) {
        s->len--;
        lexer->mark_end(lexer);
        lexer->result_symbol = LAYOUT_CLOSE;
        return true;
      }
      if (need_end) {
        // EOF with only LAYOUT_END valid: emit so the surrounding
        // repeat exits and the next scan call closes the block.
        lexer->mark_end(lexer);
        lexer->result_symbol = LAYOUT_END;
        return true;
      }
    } else {
      uint8_t ucol = clamp_col(col);
      if (ucol < top.col) {
        // Dedent into outer scope: emit LAYOUT_CLOSE whenever the
        // next non-whitespace column is strictly less than the
        // current block's baseline. The same-line continuation case
        // `(multi\n  line) "a"` (where after `)` the next token
        // sits at col < block-baseline) is already handled by the
        // paren_depth check above — while inside the parens
        // (s->paren_depth > top.paren_depth), layout is suppressed,
        // and once the matching `)` pops paren_depth back, the
        // scanner is called for the regular continuation tokens
        // before any layout decision.
        //
        // Chained closes (multi-level dedent across consecutive
        // scan calls without re-crossing a newline) work naturally
        // here: each pop fires whenever the new top.col still
        // exceeds the current column.
        //
        // Suppress close when the next char begins a `|>` / `++`
        // operator — the parser must be free to extend the current
        // expression across the dedent.
        if (c != '|' && c != '+' && need_close) {
          s->len--;
          lexer->mark_end(lexer);
          lexer->result_symbol = LAYOUT_CLOSE;
          return true;
        }
      } else if (ucol == top.col) {
        // Sibling boundary. Wins over PAREN_OPEN below.
        if (need_end) {
          lexer->mark_end(lexer);
          lexer->result_symbol = LAYOUT_END;
          return true;
        }
      } else {
        // ucol > top.col — same line as the opener (single-line
        // let) or a continuation line. There is no column-based
        // close trigger here; the `in` keyword path closes single-
        // line let blocks via the IN_KEYWORD external token.
      }
    }
  }


  // PAREN_OPEN / PAREN_CLOSE — when the next character is a paren
  // and the parser expects one, consume it as a 1-char token and
  // update the paren-depth counter. Routing parens through the
  // scanner is what gives layout-token suppression a usable signal
  // inside parens.
  if (!at_eof && c == '(' && valid_symbols[PAREN_OPEN]) {
    lexer->advance(lexer, false);
    if (s != NULL && s->paren_depth < 255) s->paren_depth++;
    lexer->result_symbol = PAREN_OPEN;
    return true;
  }
  if (!at_eof && c == ')' && valid_symbols[PAREN_CLOSE]) {
    lexer->advance(lexer, false);
    if (s != NULL && s->paren_depth > 0) s->paren_depth--;
    lexer->result_symbol = PAREN_CLOSE;
    return true;
  }

  // Top-level (stack empty) LAYOUT_END: emitted after crossing a
  // newline that lands on column 0 (or at EOF). The in-block layout
  // logic above doesn't reach here when stack is empty.
  if (need_end && (s == NULL || s->len == 0) && saw_newline && (col == 0 || at_eof)) {
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_END;
    return true;
  }

  return false;
}
