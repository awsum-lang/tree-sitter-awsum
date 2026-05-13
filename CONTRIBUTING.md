# Contributing to `tree-sitter-awsum`

Thanks for your interest in contributing.

## Development setup

See [README.md](README.md) for an overview. Quick reference:

```bash
npm ci                       # Install tree-sitter-cli (and dependencies)
just generate                # Regenerate src/parser.c and run the corpus tests
```

Any change to [grammar.js](grammar.js) or [src/scanner.c](src/scanner.c) requires regenerating `src/parser.c` (and possibly `src/grammar.json` / `src/node-types.json`) and committing the result alongside. CI verifies that the committed generated files match what `grammar.js` produces — if they drift, the PR fails.

For end-to-end verification against the compiler (corpus + queries + property), run the `tree-sitter-tests` test-suite from inside the `awsum/` repo — see [README.md → How the grammar is verified against the compiler](README.md#how-the-grammar-is-verified-against-the-compiler).

## Signed commits

The `main` branch requires signed commits — every commit you push to a PR needs a verified signature, otherwise the merge button stays grey.

Minimal `~/.gitconfig` for SSH signing:

```ini
[user]
	email = ...
	name = ...
	signingkey = ~/.ssh/id_ed25519.pub
[commit]
	gpgsign = true
[gpg]
	format = ssh
```

For GPG signing instead, set `gpg.format = openpgp` (or omit — that's the default) and point `signingkey` at your GPG key ID. The option name `gpgsign` is git's historical name for "sign this thing" and applies regardless of format.

The same key file must be added to GitHub Settings → SSH and GPG keys as a **Signing Key** (a separate category from Authentication Key, even if you reuse the same file). Verify locally:

```bash
git commit -S -m "test" --allow-empty
git log --show-signature -1
```

If you already made unsigned commits on a feature branch, retroactively sign with:

```bash
git rebase --exec 'git commit --amend --no-edit -S' <range>
```

then force-push your branch.

## Pull requests

- Open against `main`. CI (`ci.yml`) must be green before merge.
- For user-visible changes, add a bullet under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Infrastructure-only changes (CI, dev tooling, internal refactors) still get an entry so the next release notes are complete.
- Versions are 1:1 with the `awsum` compiler. The version lives in both [package.json](package.json) (`#version`) and [tree-sitter.json](tree-sitter.json) (`#metadata.version`) — the npm registry reads one, the tree-sitter CLI embeds the other into `src/parser.c`. When bumping, edit both files and re-run `just generate` so the embedded version updates. CI and `just lint` reject any drift; `just release` runs `just lint` as a prerequisite, so a stale version sync aborts the tag before it gets pushed.
