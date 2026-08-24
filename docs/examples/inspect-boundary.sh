#!/bin/sh
# inspect-boundary.sh — see exactly what a model call would read, without
# calling Brama: needs no BRAMA_URL, no key, changes nothing.
# Run: sh inspect-boundary.sh [/path/to/repo]
set -eu
REPO="${1:-.}"

# the full boundary: selected files with byte counts, total, every skip
# with its reason
kronika sources --repo "$REPO"

# the same boundary under a tight per-file budget — larger files land in
# "skipped" as "larger than 4000 bytes"; ordering decides who survives
kronika sources --repo "$REPO" --max-file-bytes 4000

# explicit selection: only these paths are candidates (exclusion, size,
# binary, and encoding checks still apply)
kronika sources --repo "$REPO" --source src --source README.md
