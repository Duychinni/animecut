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
if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  exit 0
fi

# Never merge or discard local work on the worker host. A fast-forward either
# applies the exact reviewed main branch or exits without touching PM2.
git merge --ff-only origin/main

# Stale yt-dlp builds can expose only 360p even when HD streams exist.
if command -v brew >/dev/null 2>&1; then
  brew upgrade yt-dlp >/dev/null 2>&1 || true
fi

npm ci
npm run build
if ! pm2 describe animacut-worker-3 >/dev/null 2>&1; then
  GIT_COMMIT_SHA="$REMOTE_SHA" pm2 start npm --name animacut-worker-3 -- run worker
fi
GIT_COMMIT_SHA="$REMOTE_SHA" pm2 restart animacut-web animacut-worker-1 animacut-worker-2 animacut-worker-3 --update-env
pm2 save --force >/dev/null

echo "Updated AnimaCut workers from $LOCAL_SHA to $REMOTE_SHA"
