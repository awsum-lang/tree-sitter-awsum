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

// Total number of externals declared in `grammar.js`. Used by the
// error-recovery guard. MUST match the externals array length in
// `grammar.js` exactly — a mismatch makes `valid_symbols[i]`
// out-of-bounds reads, which silently corrupts scanner decisions.
//
// Block comments are NOT external — the grammar's
// `block_comment: $ => /\{-([^-]|-[^}])*-+\}/` regex matches them.
// Don't try `[\s\S]*?-\}`: tree-sitter's regex engine matches `*?`
// greedily, so two block comments in a file collapse into one (see
// the banner comment in grammar.js for the full why).
#define EXTERNAL_TOKEN_COUNT 6

// Stack depth ceiling for the indent stack. The compiler stress
// tests under `awsum/test/sources/successful/stress-*` push 300+
// levels of nested `case` blocks (artificial, not real code) and
// the layout-stack must hold one entry per opened block. The hard
// ceiling is set by tree-sitter's per-state serialization buffer
// (`TREE_SITTER_SERIALIZATION_BUFFER_SIZE = 1024` bytes): with the
// 3-byte-per-entry packed encoding below and a 3-byte header,
// `(1024 - 3) / 3 = 340` is the largest stack we can round-trip.
// 320 leaves a small margin.
//
// On overflow the scanner caps `s->len` at MAX_DEPTH on push
// (dropping deeper levels), and the parse degrades to `(ERROR ...)`
// rather than crashing.
#define MAX_DEPTH 320

// `col` is widened to `uint16_t` so deeply-indented stress tests
// (300+ levels at 2 spaces each → col 600+) don't collapse all
// distinct indent depths to 255. The high bit is reserved for the
// `is_let` flag so the serialized form stays at 3 bytes per entry
// (`col_low`, `col_high|is_let`, `paren_depth`); see serialize /
// deserialize. Realistic source columns never approach 32K.
typedef struct {
  uint16_t col;
  uint8_t paren_depth;
  uint8_t is_let;
} StackEntry;

// `len` is `uint16_t` so a stack of 256+ entries doesn't wrap to 0
// mid-push and clobber the bottom of the stack — the original bug
// that surfaced as catastrophic ERROR-node clusters on the 300-deep
// `case` stress test.
typedef struct {
  StackEntry stack[MAX_DEPTH];
  uint16_t len;
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

// Wire format: 1 byte global paren_depth, 2 bytes len (LE), then
// 3 bytes per entry: col_low, (col_high | is_let<<7), paren_depth.
// Packing `is_let` into the col-high bit keeps each entry at 3
// bytes — same width as the original (uint8_t col, uint8_t pd,
// uint8_t is_let) layout — so MAX_DEPTH still fits in tree-sitter's
// 1024-byte serialization buffer despite the col widening.
unsigned tree_sitter_awsum_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  if (s == NULL) return 0;
  unsigned i = 0;
  buffer[i++] = (char)s->paren_depth;
  buffer[i++] = (char)(s->len & 0xff);
  buffer[i++] = (char)((s->len >> 8) & 0xff);
  for (uint16_t j = 0; j < s->len; j++) {
    uint16_t col = s->stack[j].col & 0x7fff;
    uint8_t hi = (uint8_t)((col >> 8) & 0x7f);
    if (s->stack[j].is_let) hi |= 0x80;
    buffer[i++] = (char)(col & 0xff);
    buffer[i++] = (char)hi;
    buffer[i++] = (char)s->stack[j].paren_depth;
  }
  return i;
}

void tree_sitter_awsum_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  if (s == NULL) return;
  s->len = 0;
  s->paren_depth = 0;
  if (length < 3) return;
  s->paren_depth = (uint8_t)buffer[0];
  uint16_t n = (uint16_t)((uint8_t)buffer[1] | ((uint8_t)buffer[2] << 8));
  if (n > MAX_DEPTH) n = MAX_DEPTH;
  if ((unsigned)(3 + 3u * n) > length) n = (uint16_t)((length - 3) / 3);
  s->len = n;
  for (uint16_t j = 0; j < n; j++) {
    uint8_t lo = (uint8_t)buffer[3 + 3 * j];
    uint8_t hi = (uint8_t)buffer[3 + 3 * j + 1];
    s->stack[j].is_let = (hi & 0x80) ? 1 : 0;
    s->stack[j].col = (uint16_t)(lo | ((hi & 0x7f) << 8));
    s->stack[j].paren_depth = (uint8_t)buffer[3 + 3 * j + 2];
  }
}

// Skip whitespace AND comments inline. Consuming comments here
// (via `advance(true)`, marking the chars as extras) is what lets
// the scanner make layout decisions on the column of the actual
// next non-extras token, instead of stalling on a comment-start
// and hoping tree-sitter's `extras` cycle re-invokes us at the
// right place. The extras cycle is unreliable for layout-sensitive
// grammars: on inputs like a `case … of` with an indented comment
// before the first arm we observed it either failing to advance or
// losing saw_newline state. Same pattern as tree-sitter-elm's
// inline block-comment skip during indent measurement (lines 366–
// 449 of its scanner.c) — block-comment-skip in the scanner is
// effectively required for layout-sensitive grammars with nestable
// block comments.
//
// **Boundary-column / boundary-char tracking.** Tree-sitter's
// scanner API gives us only 1-char peek and no rewind. A `'-'` at
// the current position can start either a `--` line comment, a
// `->` arrow, or a negative-integer literal (`do\n  -705`) — to
// disambiguate we have to advance past it. If it turns out not to
// be a comment, the lexer's `get_column` / `lookahead` are now
// past the `-`, and:
//   • Layout decisions get the wrong col (col 3 of `7` instead of
//     col 2 of `-`), so `LAYOUT_OPEN` pushes the wrong baseline
//     and the next sibling gets read as a dedent.
//   • The `'i'` peek for the `in`-keyword close sees the digit
//     after `-`, not the boundary char.
// Fix: snapshot col + char BEFORE any speculative advance and
// return them via out parameters. Callers MUST use these instead
// of `get_column` / `lookahead` after `skip_extras` returns.
//
// Block comments support nesting (`{- {- inner -} outer -}`) via
// a counter — closes the gap that the regex-based `block_comment`
// extras token can't, since the negated-class regex stops at the
// first `-}` regardless of depth.
static bool skip_extras(TSLexer *lexer, uint32_t *boundary_col, int32_t *boundary_char) {
  bool saw_newline = false;
  while (true) {
    int32_t c = lexer->lookahead;
    // Snapshot col + char BEFORE any advance — if `c` turns out
    // not to start an extras run (line comment / block comment)
    // the boundary the caller wants is `c` at this col, not
    // whatever the lexer points at after our speculative advance.
    uint32_t pre_advance_col = lexer->get_column(lexer);
    if (c == '\n') {
      saw_newline = true;
      lexer->advance(lexer, true);
    } else if (c == '\r' || c == ' ' || c == '\t') {
      lexer->advance(lexer, true);
    } else if (c == '-') {
      lexer->advance(lexer, true);
      if (lexer->lookahead != '-') {
        // Not a line comment — `-` was the start of an arrow
        // (`->`) or a negative-integer literal. We've advanced
        // past it (no rewind in tree-sitter's lexer API); restore
        // the boundary view via the snapshot.
        if (boundary_col) *boundary_col = pre_advance_col;
        if (boundary_char) *boundary_char = c;
        return saw_newline;
      }
      lexer->advance(lexer, true);
      while (!lexer->eof(lexer) && lexer->lookahead != '\n') {
        lexer->advance(lexer, true);
      }
    } else if (c == '{') {
      lexer->advance(lexer, true);
      if (lexer->lookahead != '-') {
        // Not a block comment — `{` was a real expression token.
        if (boundary_col) *boundary_col = pre_advance_col;
        if (boundary_char) *boundary_char = c;
        return saw_newline;
      }
      lexer->advance(lexer, true);
      uint32_t nesting = 1;
      while (nesting > 0 && !lexer->eof(lexer)) {
        int32_t cc = lexer->lookahead;
        if (cc == '{') {
          lexer->advance(lexer, true);
          if (lexer->lookahead == '-') {
            lexer->advance(lexer, true);
            nesting++;
          }
        } else if (cc == '-') {
          lexer->advance(lexer, true);
          if (lexer->lookahead == '}') {
            lexer->advance(lexer, true);
            nesting--;
          }
        } else {
          if (cc == '\n') saw_newline = true;
          lexer->advance(lexer, true);
        }
      }
    } else {
      // Genuine non-extras token start: report its col + char.
      if (boundary_col) *boundary_col = pre_advance_col;
      if (boundary_char) *boundary_char = c;
      return saw_newline;
    }
  }
}

// Clamp to 32767 — uint16_t minus the high bit reserved for is_let
// in the serialized form (see serialize). 32K columns is far beyond
// any realistic source line.
static uint16_t clamp_col(uint32_t col) {
  return (uint16_t)(col > 32767 ? 32767 : col);
}

bool tree_sitter_awsum_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  // Pin every layout-token emit at scan-call-start (zero-width)
  // BEFORE we advance through ws + comments inside `skip_extras`.
  // Without this pin, mark_end would default to the post-skip
  // position and the emitted LAYOUT_* token's range would cover any
  // intervening block_comment / line_comment chars. Tree-sitter then
  // (a) consumes those chars as part of the layout token, hiding
  // them from extras processing — which means highlighting queries
  // `(block_comment) @comment` get nothing, AND (b) — the runaway
  // we're chasing — appears to cause a GLR fork explosion when a
  // block_comment in the layout-token range collides with an
  // earlier-in-file block_comment matched as extras (minimal repro:
  // `{-x-}\nf c = case c of\n  {-y-}\n  X -> 1`). Pinning at scan-
  // start makes layout tokens truly zero-width, so the block_comment
  // is matched only once — by tree-sitter's internal lexer as extras
  // after the parser shifts the layout token.
  //
  // Real-content tokens (PAREN_OPEN, PAREN_CLOSE, BLOCK_COMMENT)
  // call `mark_end` again at their post-advance position so the
  // token spans the actual content.
  lexer->mark_end(lexer);

  // Error-recovery guard. Tree-sitter sets EVERY `valid_symbols`
  // entry to true when it has hit a parse error and is searching for
  // any token that could continue the parse. Without this guard, the
  // scanner happily emits a layout token on every recovery probe,
  // each of which spawns a fresh parser fork — and on inputs that
  // already pushed the parser into recovery (an indented comment
  // between a block opener and its first sibling, a stray `-` not
  // forming `--`, …) the fork count grows exponentially, eating
  // gigabytes of memory in seconds. Returning false here lets tree-
  // sitter's error-recovery code path do its bounded thing instead.
  // Same pattern as `in_error_recovery` in tree-sitter-elm.
  bool all_valid = true;
  for (int i = 0; i < EXTERNAL_TOKEN_COUNT; i++) {
    if (!valid_symbols[i]) {
      all_valid = false;
      break;
    }
  }
  if (all_valid) {
    return false;
  }

  // LAYOUT_OPEN / LET_OPEN — push a new (column, paren_depth, is_let)
  // entry onto the indent stack. The grammar uses LET_OPEN after the
  // `let` keyword and LAYOUT_OPEN after `do` / `of`; only one of the
  // two is in valid_symbols at any given parse state.
  if (valid_symbols[LAYOUT_OPEN] || valid_symbols[LET_OPEN]) {
    bool is_let = valid_symbols[LET_OPEN];
    uint32_t col = 0;
    int32_t bc = 0;
    skip_extras(lexer, &col, &bc);
    bool at_eof = lexer->eof(lexer);
    (void)bc; // unused at LAYOUT_OPEN — only the col is pushed.
    if (s != NULL && s->len < MAX_DEPTH) {
      uint16_t base = at_eof ? 0 : clamp_col(col);
      s->stack[s->len].col = base;
      s->stack[s->len].paren_depth = s->paren_depth;
      s->stack[s->len].is_let = is_let ? 1 : 0;
      s->len++;
    }
    // mark_end was pinned at scan-call-start at the very top of
    // `scan`; don't re-call here, so the LAYOUT_OPEN token stays
    // zero-width and the block_comment / line_comment skipped by
    // `skip_extras` is matched again by tree-sitter's internal
    // lexer as proper extras after the parser shifts this token.
    lexer->result_symbol = is_let ? LET_OPEN : LAYOUT_OPEN;
    return true;
  }

  // Walk past whitespace, newlines AND comments. saw_newline is
  // recorded for the top-level (stack-empty) emit rule. The
  // boundary col + char tracked by `skip_extras` are what every
  // layout comparison below wants — using `lexer->get_column` /
  // `lexer->lookahead` here would be wrong on the path where
  // `skip_extras` advanced past a `-` that turned out to be a
  // negative-integer literal (or `->` arrow) rather than a `--`
  // comment: the lexer's col is then one past the `-`, and its
  // lookahead is the digit / `>` after `-`, not the `-` itself.
  uint32_t col = 0;
  int32_t c = 0;
  bool saw_newline = skip_extras(lexer, &col, &c);
  bool at_eof = lexer->eof(lexer);

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
      // the rest. mark_end stays pinned at scan-call-start.
      if (need_close) {
        s->len--;
        lexer->result_symbol = LAYOUT_CLOSE;
        return true;
      }
      if (need_end) {
        // EOF with only LAYOUT_END valid: emit so the surrounding
        // repeat exits and the next scan call closes the block.
        lexer->result_symbol = LAYOUT_END;
        return true;
      }
    } else {
      // An enclosing `)` is about to close a paren that was open at
      // the moment this block was opened (top.paren_depth captured
      // that depth at LAYOUT_OPEN / LET_OPEN; we're back at the same
      // depth now). The block must close before that paren can —
      // otherwise the inner case/do/let stays open across the
      // boundary and the parser falls into error recovery (e.g.
      //   `case (case True of True -> 1 False -> 2) of …`,
      //   `(let x = 1)` without an `in`,
      //   `(do x <- e; pureEither x)`).
      //
      // Gate on `top.paren_depth > 0`: a `)` at top.paren_depth == 0
      // is malformed input — there was no wrapping paren when the
      // block opened, so closing the block on a stray `)` would mask
      // a real error.
      //
      // Chained closes (multiple blocks wrapped by the same `)`)
      // work via repeated scan calls: each emission pops one stack
      // entry without advancing the lexer, so the next call sees the
      // same `)` and closes the next layer until the stack at this
      // paren depth is drained — then PAREN_CLOSE fires below.
      if (need_close && !at_eof && c == ')' && top.paren_depth > 0
          && s->paren_depth == top.paren_depth) {
        s->len--;
        lexer->result_symbol = LAYOUT_CLOSE;
        return true;
      }
      uint16_t ucol = clamp_col(col);
      if (ucol < top.col && saw_newline) {
        // Dedent into outer scope, emitted ONLY across a newline:
        // a let-binding's value can be a parens-form whose closing
        // `)` lands at a column smaller than the let-block's
        // baseline (`let b = (1\n  ) (3)`), and after the
        // PAREN_CLOSE pops paren_depth back to the let-block's
        // depth the next non-extras char is on the SAME line as
        // the `)` — that's an expression continuation, not a
        // layout decision, so we must not close on it. The
        // saw_newline gate distinguishes a real dedent (after the
        // newline that precedes the lower-column token) from a
        // bare same-line lower-column position.
        //
        // Chained closes (multi-level dedent across consecutive
        // scan calls without re-crossing a newline) still work
        // here: each subsequent scan call hits skip_extras with
        // no newline to consume but with saw_newline set true on
        // the first call (the lookahead position hasn't moved
        // since), and tree-sitter calls the scanner repeatedly
        // until it stops emitting close.
        //
        // Suppress close when the next char begins a `|>` / `++`
        // operator — the parser must be free to extend the current
        // expression across the dedent.
        if (c != '|' && c != '+' && need_close) {
          s->len--;
          lexer->result_symbol = LAYOUT_CLOSE;
          return true;
        }
      } else if (ucol == top.col && saw_newline) {
        // Sibling boundary, also gated on a newline so a parens-
        // form ending at the block's baseline col on the same
        // line doesn't prematurely separate siblings. Wins over
        // PAREN_OPEN below.
        if (need_end) {
          lexer->result_symbol = LAYOUT_END;
          return true;
        }
      } else {
        // ucol > top.col — same line as the opener (single-line
        // let) or a continuation line. The only legitimate close
        // trigger here is the `in` keyword inside a let-block:
        // `let x = e in body` on a single physical line never
        // dedents, but the let-block must still close before `in`
        // can be tokenised as a keyword (tree-sitter's regular
        // lexer otherwise lexes it as `lower_id`, the let-binding's
        // value swallows `in` as an application argument, and the
        // parser fails). Emit a zero-width LAYOUT_CLOSE on lookahead
        // `in` when the top frame is a let-block at the SAME paren
        // depth — same-paren-depth so a stray `in` inside a parens
        // expression that opened after the let doesn't trigger.
        if (need_close && top.is_let && s->paren_depth == top.paren_depth
            && c == 'i') {
          // Peek the next char without committing — we don't want to
          // consume `in` itself; that's the regular lexer's job.
          // The mark_end at scan-call-start keeps this token zero-width
          // regardless of what we advance through here.
          lexer->advance(lexer, false);
          int32_t c2 = lexer->lookahead;
          if (c2 == 'n') {
            lexer->advance(lexer, false);
            int32_t c3 = lexer->lookahead;
            // `in` must be a complete token — not a prefix of a
            // longer identifier (`integer`, `index`, `info`, …).
            bool ident_cont =
              (c3 >= 'a' && c3 <= 'z') ||
              (c3 >= 'A' && c3 <= 'Z') ||
              (c3 >= '0' && c3 <= '9') ||
              c3 == '_' || c3 == '\'';
            if (!ident_cont) {
              s->len--;
              lexer->result_symbol = LAYOUT_CLOSE;
              return true;
            }
          }
          // Not `in` — fall through. The advances above are
          // discarded because mark_end was pinned at scan-call-start
          // and we never re-mark.
        }
      }
    }
  }


  // PAREN_OPEN / PAREN_CLOSE — when the next character is a paren
  // and the parser expects one, consume it as a 1-char token and
  // update the paren-depth counter. Routing parens through the
  // scanner is what gives layout-token suppression a usable signal
  // inside parens.
  //
  // Each branch re-calls `mark_end` AFTER `advance` so the emitted
  // token spans the `(` / `)` character. The top-of-scan `mark_end`
  // pinned the default at scan-call-start (for zero-width layout
  // tokens); these real-content tokens override it.
  if (!at_eof && c == '(' && valid_symbols[PAREN_OPEN]) {
    lexer->advance(lexer, false);
    if (s != NULL && s->paren_depth < 255) s->paren_depth++;
    lexer->mark_end(lexer);
    lexer->result_symbol = PAREN_OPEN;
    return true;
  }
  if (!at_eof && c == ')' && valid_symbols[PAREN_CLOSE]) {
    lexer->advance(lexer, false);
    if (s != NULL && s->paren_depth > 0) s->paren_depth--;
    lexer->mark_end(lexer);
    lexer->result_symbol = PAREN_CLOSE;
    return true;
  }

  // Top-level (stack empty) LAYOUT_END: emitted after crossing a
  // newline that lands on column 0 (or at EOF). The in-block layout
  // logic above doesn't reach here when stack is empty. mark_end
  // stays pinned at scan-call-start (zero-width).
  if (need_end && (s == NULL || s->len == 0) && saw_newline && (col == 0 || at_eof)) {
    lexer->result_symbol = LAYOUT_END;
    return true;
  }

  return false;
}
