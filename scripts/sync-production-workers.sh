#!/bin/zsh
set -euo pipefail

# launchd starts with a minimal PATH; include Homebrew and the normal system
# locations so git, npm, PM2, and yt-dlp are available during unattended runs.
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_DIR="/Users/hiro/.openclaw/workspace/animacut"
LOCK_DIR="${TMPDIR:-/tmp}/animacut-worker-sync.lock"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

cd "$REPO_DIR"
git fetch --quiet origin main

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
UPDATED=0
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  # Never merge or discard local work on the worker host. A fast-forward either
  # applies the exact reviewed main branch or exits without touching PM2.
  git merge --ff-only origin/main

  # Stale yt-dlp builds can expose only 360p even when HD streams exist.
  if command -v brew >/dev/null 2>&1; then
    brew upgrade yt-dlp >/dev/null 2>&1 || true
  fi

  npm ci
  npm run build
  UPDATED=1
fi

SERVICES_RECOVERED=0
if ! pm2 describe animacut-web >/dev/null 2>&1; then
  GIT_COMMIT_SHA="$REMOTE_SHA" pm2 start npm --name animacut-web -- start
  SERVICES_RECOVERED=1
fi
for WORKER_NAME in animacut-worker-1 animacut-worker-2 animacut-worker-3; do
  if ! pm2 describe "$WORKER_NAME" >/dev/null 2>&1; then
    GIT_COMMIT_SHA="$REMOTE_SHA" pm2 start npm --name "$WORKER_NAME" -- run worker
    SERVICES_RECOVERED=1
  fi
done

if [[ "$UPDATED" == "1" ]]; then
  GIT_COMMIT_SHA="$REMOTE_SHA" pm2 restart animacut-web animacut-worker-1 animacut-worker-2 animacut-worker-3 --update-env
fi

if [[ "$UPDATED" == "0" && "$SERVICES_RECOVERED" == "0" ]]; then
  exit 0
fi

pm2 save --force >/dev/null

echo "AnimaCut services synced to $REMOTE_SHA"
