#!/bin/sh
# inspect-boundary.sh — see exactly what a model call would read, without
# calling Brama: needs no BRAMA_URL, no key, changes nothing.
# Run: KRONIKA_MAX_INPUT_BYTES=<n> KRONIKA_MAX_FILE_BYTES=<n> sh inspect-boundary.sh [/path/to/repo]
set -eu
REPO="${1:-.}"
INPUT="${KRONIKA_MAX_INPUT_BYTES:?the total source budget, in bytes}"
FILE="${KRONIKA_MAX_FILE_BYTES:?the per-file source limit, in bytes}"

# the full boundary: selected files with byte counts, total, every skip
# with its reason
kronika sources --repo "$REPO" --max-input-bytes "$INPUT" --max-file-bytes "$FILE"

# explicit selection: only these paths are candidates (exclusion, size,
# binary, and encoding checks still apply)
kronika sources --repo "$REPO" --max-input-bytes "$INPUT" --max-file-bytes "$FILE" --source src --source README.md
