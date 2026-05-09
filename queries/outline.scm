; Outline query for Zed (and any other editor that consumes a
; tree-sitter outline.scm). Drives the structure pane / breadcrumb.
;
; We surface the same shapes that `awsum symbols --json` reports —
; top-level functions, constants, and types. Constructors are NOT
; included in v0 (matches the existing `awsum-vscode` outline; the LSP
; server may add them later via `textDocument/documentSymbol`).
;
; @item    — the whole declaration (sets the navigation range)
; @name    — the identifier that names the item (highlighted in pane)
; @context — additional context-only tokens (the leading keyword, etc.)

(signature
  name: (_) @name) @item

(fun_def
  name: (_) @name) @item

(type_decl
  "type" @context
  name: (_) @name) @item

(empty_type_decl
  "empty" @context
  "type" @context
  name: (_) @name) @item
