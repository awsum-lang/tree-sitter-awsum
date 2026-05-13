_default:
  @ just --list --unsorted

# Regenerate src/parser.c from grammar.js, then run the corpus tests
generate:
  npx tree-sitter generate
  npx tree-sitter test

# Same checks CI runs: version sync, no grammar warnings, generated files committed
lint:
  #!/bin/sh
  set -eu
  pkg_v=$(node -p 'require("./package.json").version')
  ts_v=$(node -p 'require("./tree-sitter.json").metadata.version')
  if [ "$pkg_v" != "$ts_v" ]; then
    echo "Version drift: package.json=$pkg_v, tree-sitter.json=$ts_v" >&2
    exit 1
  fi
  output=$(npx tree-sitter generate 2>&1)
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -qE '^Warning:'; then
    echo "tree-sitter generate emitted warnings — fix them in grammar.js / tree-sitter.json." >&2
    exit 1
  fi
  git diff --exit-code -- src/grammar.json src/node-types.json src/parser.c

# Confirm potentially dangerous actions with a specific confirmation input (e.g. version, environment name)
[private]
manual-confirmation-input message required_confirmation:
  #!/bin/sh
  set -eu

  message="{{ message }}"
  required_confirmation="{{ required_confirmation }}"

  echo "$message"
  echo "Type '$required_confirmation' to confirm:"
  read response

  if [ "$response" != "$required_confirmation" ]; then
    echo "Confirmation failed. Exiting..."
    exit 1
  fi

# Tag and push the version currently in package.json. Run after the prep PR is merged into main.
# Depends on `lint` so version drift (package.json ↔ tree-sitter.json), grammar warnings,
# or stale generated files abort the tag *before* it gets pushed.
release: lint
  #!/bin/sh
  set -eu
  git checkout main
  git pull
  version=$(node -p 'require("./package.json").version')
  just manual-confirmation-input "About to tag and push v$version" "$version"
  git tag -a "v$version" -m "Release $version"
  git push origin "v$version"
