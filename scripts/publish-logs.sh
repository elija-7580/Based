#!/usr/bin/env bash
# Commit /tmp/out/* to the `ci-logs` branch (folder = $1) so build results can be read without the Actions UI.
set -u
job="$1"
git config user.name "ci-bot"
git config user.email "ci-bot@users.noreply.github.com"
work=$(mktemp -d)
if git fetch -q origin ci-logs 2>/dev/null; then
  git worktree add -q "$work" FETCH_HEAD
else
  git worktree add -q --detach "$work"
  (cd "$work" && git checkout -q --orphan ci-logs && git rm -rq . >/dev/null 2>&1 || true)
fi
mkdir -p "$work/$job"
rm -f "$work/$job"/*
cp /tmp/out/* "$work/$job/" 2>/dev/null || true
echo "${GITHUB_SHA:-local} $(date -u +%FT%TZ) run ${GITHUB_RUN_ID:-0}" > "$work/$job/commit.txt"
cd "$work"
git add -A
git commit -qm "logs($job): ${GITHUB_SHA:-local}" || true
for i in 1 2 3; do
  git push -q origin HEAD:ci-logs && break
  git pull -q --rebase origin ci-logs || true
done
