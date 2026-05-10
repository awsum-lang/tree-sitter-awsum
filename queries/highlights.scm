; Tree-sitter highlight query for Awsum.
;
; Capture names follow the standard tree-sitter conventions used by Zed,
; Helix, Neovim, and Emacs ts-mode. The chosen captures map to roughly
; the same scope the existing `awsum.tmLanguage.json` (in awsum-vscode)
; assigns — so the file looks similar across editors.

; ─── Keywords ────────────────────────────────────────────────────────────────

[
  "import"
  "type"
  "empty"
  "case"
  "of"
  "do"
  "let"
  "in"
] @keyword

; ─── Operators / punctuation ────────────────────────────────────────────────

[
  "->"
  "<-"
  "|>"
  "++"
  "|"
  "="
  ":"
  "\\"
] @operator

[
  "("
  ")"
] @punctuation.bracket

"." @punctuation.delimiter

; ─── Comments ────────────────────────────────────────────────────────────────

(line_comment) @comment
(block_comment) @comment

; ─── Strings & integers ──────────────────────────────────────────────────────
;
; The string is a single lexer token (so extras don't bleed into its
; body — a literal `"--"` would otherwise get a `line_comment` node
; inside it). Escape sequences inside strings are highlighted via a
; second @string.escape capture on the same node, with the regex
; matching anywhere in the literal — editors that honour this layer
; (Zed / Helix / Neovim) overlay it on top of the base @string colour.

(string) @string
((string) @string.escape
  (#match? @string.escape "\\\\[ntr\"\\\\0]"))
(integer) @number

; ─── Type-decl name + constructors ──────────────────────────────────────────

(type_decl name: (upper_id) @type)
(empty_type_decl name: (upper_id) @type)
(con_def name: (upper_id) @constructor)
(type_decl parameter: (lower_id) @type.parameter)

; ─── Top-level signatures + function definitions ───────────────────────────

(signature name: (lower_id) @function)
(fun_def name: (lower_id) @function)
(fun_def parameter: (lower_id) @variable.parameter)

; The bundled prelude defines `(++) : ...` for the concat operator.
(operator_name) @function

; ─── Imports ────────────────────────────────────────────────────────────────

(import_decl module: (module_path (upper_id) @module))

; ─── Types in signatures / type decls ───────────────────────────────────────
;
; All `upper_id`s outside an explicit constructor or type-decl-name slot
; are treated as type references. This is over-broad (constructor uses in
; expressions also become @type), but the LSP delivers the precise
; semantic-token map; tree-sitter just paints the raw shape.

(arrow_type) @_arrow
(union_type) @_union
(type_app) @_app

((type_app callee: (upper_id) @type)
  (#match? @type "^[A-Z]"))
((type_app arg: (upper_id) @type)
  (#match? @type "^[A-Z]"))

; ─── Patterns ───────────────────────────────────────────────────────────────

(pattern_constructor (upper_id) @constructor)
(pattern_ascribe (lower_id) @variable.parameter)

; ─── Expressions ────────────────────────────────────────────────────────────

; `Module.subModule.foo` — module path coloured as @module, name as @function.call.
(qname (upper_id) @module)
(qname (lower_id) @function.call)

; Lambda parameters are user-introduced bindings.
(lambda parameter: (lower_id) @variable.parameter)

; A bare lower_id that flows through as an _atom in expression position is a
; variable read.
(app (lower_id) @variable)

; `_`-prefixed identifiers (intentional unused). Render dimmed where the
; theme supports it.
((lower_id) @comment.unused
  (#match? @comment.unused "^_"))
((upper_id) @comment.unused
  (#match? @comment.unused "^_"))
