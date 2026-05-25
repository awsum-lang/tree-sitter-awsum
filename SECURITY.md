# Security Policy

## Reporting a vulnerability

Report suspected security vulnerabilities in `tree-sitter-awsum` through one of the following channels:

- **Preferred:** [GitHub Private Vulnerability Reporting](https://github.com/awsum-lang/tree-sitter-awsum/security/advisories/new) — visible only to maintainers and the reporter, and can be coordinated into a published advisory with a CVE.
- **Fallback:** email `security@awsum-lang.org` with subject `[security] <short description>`.

Please do not report security vulnerabilities through public issues, pull requests, or discussions.

For vulnerabilities in the Awsum compiler or the `awsum lsp` server, see [awsum-lang/awsum/SECURITY.md](https://github.com/awsum-lang/awsum/blob/main/SECURITY.md).

## Scope

Issues in this grammar that allow denial of service via crafted input (parse explosion, runaway recursion) or incorrect tokenisation that downstream tools rely on for safety. Functional bugs go on the public issue tracker.

## Supported versions

Security fixes are released against the latest published version. `tree-sitter-awsum` follows the compiler's version in lockstep; a long-term-support policy will be defined for the 1.0 release.

## Response timeline

We aim to acknowledge new reports within 7 days and to publish a fix or mitigation within 90 days. Reporters will be kept informed throughout.
