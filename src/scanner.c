// External scanner for tree-sitter-awsum.
//
// Awsum is a layout-sensitive language: a top-level declaration occupies
// one logical line and the next declaration starts in column 0. Without
// awareness of newlines plus column, tree-sitter's pure-context-free
// engine cannot tell whether an identifier on the next line belongs to
// the previous expression or starts a new declaration. Concretely:
//
//     main : IO Never Unit
//     main = ...
//
// is parsed by a layout-blind grammar as `main : (IO Never Unit main)`
// because `main` is a valid type variable continuation.
//
// This scanner emits a single zero-length token, LAYOUT_END, whenever
// the lexer is positioned after one or more newlines whose immediately
// following non-whitespace character is at column 0 (or EOF). The
// grammar uses LAYOUT_END as a terminator between top-level items and
// signature/fun-def constructs that are otherwise ambiguous against an
// extending type or expression.
//
// We consume the run of whitespace as part of LAYOUT_END (with
// `advance(lexer, false)`); subsequent ordinary lexing then resumes
// from a known column-0 position.

#include "tree_sitter/parser.h"

#include <stdbool.h>
#include <stdint.h>
#include <string.h>

enum TokenType {
  LAYOUT_END,
};

void *tree_sitter_awsum_external_scanner_create(void) {
  return NULL;
}

void tree_sitter_awsum_external_scanner_destroy(void *payload) {
  (void)payload;
}

unsigned tree_sitter_awsum_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload;
  (void)buffer;
  return 0;
}

void tree_sitter_awsum_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload;
  (void)buffer;
  (void)length;
}

bool tree_sitter_awsum_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  (void)payload;

  if (!valid_symbols[LAYOUT_END]) {
    return false;
  }

  // Walk forward over whitespace, remembering whether we crossed a newline.
  bool saw_newline = false;
  while (true) {
    int32_t c = lexer->lookahead;
    if (c == '\n') {
      saw_newline = true;
      lexer->advance(lexer, false);
    } else if (c == '\r' || c == ' ' || c == '\t') {
      lexer->advance(lexer, false);
    } else {
      break;
    }
  }

  // We only fire LAYOUT_END if we actually crossed a newline. Whitespace
  // alone (`a : b c`) must not break a single declaration apart.
  if (!saw_newline) {
    return false;
  }

  // The next non-whitespace character must start at column 0 — that's
  // the layout signal that a new top-level item begins. EOF is also
  // accepted so the very last item terminates cleanly.
  uint32_t col = lexer->get_column(lexer);
  if (col == 0 || lexer->eof(lexer)) {
    lexer->mark_end(lexer);
    lexer->result_symbol = LAYOUT_END;
    return true;
  }

  // We crossed a newline but the next char is indented (continuation
  // line of the previous declaration). Reject — the grammar will keep
  // extending the in-progress item.
  return false;
}
