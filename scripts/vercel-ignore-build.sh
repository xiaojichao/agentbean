#!/usr/bin/env bash
set -euo pipefail

echo "Checking whether the Vercel web build should run..."
echo "VERCEL_GIT_COMMIT_REF=${VERCEL_GIT_COMMIT_REF:-}"
echo "VERCEL_GIT_PREVIOUS_SHA=${VERCEL_GIT_PREVIOUS_SHA:-}"
echo "VERCEL_GIT_COMMIT_SHA=${VERCEL_GIT_COMMIT_SHA:-}"

# Always allow production branch deployments.
if [[ "${VERCEL_GIT_COMMIT_REF:-}" == "main" ]]; then
  echo "Production branch detected. Continue Vercel build."
  exit 1
fi

previous_sha="${VERCEL_GIT_PREVIOUS_SHA:-}"
commit_sha="${VERCEL_GIT_COMMIT_SHA:-HEAD}"

if [[ -n "$previous_sha" ]] &&
  [[ "$previous_sha" != "0000000000000000000000000000000000000000" ]] &&
  git cat-file -e "$previous_sha^{commit}" 2>/dev/null &&
  git cat-file -e "$commit_sha^{commit}" 2>/dev/null; then
  changed_files="$(git diff --name-only "$previous_sha" "$commit_sha")"
elif git rev-parse --verify HEAD^ >/dev/null 2>&1; then
  changed_files="$(git diff --name-only HEAD^ HEAD)"
else
  echo "Unable to determine changed files safely. Continue Vercel build."
  exit 1
fi

echo "Changed files:"
if [[ -n "$changed_files" ]]; then
  echo "$changed_files"
else
  echo "(none)"
fi

if echo "$changed_files" | grep -E '^apps/web-next/' >/dev/null; then
  echo "web-next changes detected. Continue Vercel build."
  exit 1
fi

if echo "$changed_files" | grep -E '^packages/contracts/' >/dev/null; then
  echo "contracts changes detected (web-next depends on it). Continue Vercel build."
  exit 1
fi

if echo "$changed_files" | grep -E '^(package\.json|package-lock\.json|\.npmrc)$' >/dev/null; then
  echo "root dependency files changed (web-next installs from the root workspace). Continue Vercel build."
  exit 1
fi

if echo "$changed_files" | grep -E '^scripts/vercel-ignore-build\.sh$' >/dev/null; then
  echo "Vercel ignore script changed. Continue Vercel build."
  exit 1
fi

if echo "$changed_files" | grep -E '^apps/web/' | grep -Ev '^apps/web/(vercel\.json|\.nvmrc)$' >/dev/null; then
  echo "Legacy web changes detected (transition). Continue Vercel build."
  exit 1
fi

echo "No web-related changes detected. Skip Vercel build."
exit 0
