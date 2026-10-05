#!/bin/sh
# inspect-boundary.sh — see exactly what a model call would read, without
# calling Brama: needs no BRAMA_URL, no key, changes nothing.
# Run: sh inspect-boundary.sh [/path/to/repo]
set -eu
REPO="${1:-.}"


# the full boundary: selected files with byte counts, total, every skip
# with its reason
kronika sources --repo "$REPO"

# explicit selection: only these paths are candidates (exclusion, size,
# binary, and encoding checks still apply)
kronika sources --repo "$REPO" --source src --source README.md
