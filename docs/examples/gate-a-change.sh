#!/bin/sh
# gate-a-change.sh — CI documentation gate: audit exactly this branch's
# changes against current documentation; exit 1 blocks the merge.
# Needs: BRAMA_URL, BRAMA_API_KEY in the environment (see configuration.md).
# Run: sh gate-a-change.sh [base-ref]
set -eu
BASE="${1:-origin/main}"

# the three-dot diff audits only changes since the merge base with BASE;
# --json puts named findings (severity, code, requiredChange) in the log
kronika check --repo . --base "$BASE" --json

# exit status is the verdict: 0 = documentation covers the change,
# 1 = at least one blocker finding (or the audit itself failed — the gate
# never fails open). `set -eu` propagates it to CI.
