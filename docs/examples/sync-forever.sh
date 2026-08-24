#!/bin/sh
# sync-forever.sh — one schedulable reconciliation tick: audit drifted
# documents, rewrite only audited defects, commit and push the result.
# Point cron/launchd/CI at this script and documentation follows the repo.
# Needs: BRAMA_URL, BRAMA_API_KEY; a kronika.sync.json at the repo root.
# Run: sh sync-forever.sh [/path/to/repo]
set -eu
REPO="${1:-.}"

# rehearse first: what would this tick do? Audits run, nothing is written.
kronika sync --repo "$REPO" --dry-run

# the real tick: baselines advance, passing audits ARE the update, blocked
# audits trigger a findings-guided rewrite; the sync commit stages exactly
# the rewritten documents plus kronika.sync-state.json and pushes.
# Exit 1 means at least one document failed to reconcile — its baseline
# stays put and the next tick retries the same range.
kronika sync --repo "$REPO" --commit --push

# the receipt: the loop's memory is committed history
git -C "$REPO" log --oneline -2
