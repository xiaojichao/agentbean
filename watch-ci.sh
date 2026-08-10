#!/bin/bash
# Watch PR#1188 CI checks until none are pending/running
prev=""
while true; do
  s=$(gh pr checks 1188 --json name,bucket 2>/dev/null)
  cur=$(echo "$s" | jq -r '.[] | select(.bucket!="pending" and .bucket!="running") | "\(.name): \(.bucket)"' 2>/dev/null | sort)
  running=$(echo "$s" | jq -r '[.[] | select(.bucket=="pending" or .bucket=="running")] | length' 2>/dev/null)
  diff <(echo "$prev") <(echo "$cur") | grep '^>' | sed 's/^> /STATUS: /'
  prev="$cur"
  if [ "$running" = "0" ] && [ -n "$s" ]; then
    echo "ALL_CHECKS_DONE:"
    echo "$cur" | sed 's/^/  /'
    break
  fi
  sleep 30
done
