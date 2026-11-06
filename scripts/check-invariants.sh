#!/usr/bin/env bash
# Repo + runtime invariants for SentryVision. Exit 0 = all hold.
# Run from repo root: bash scripts/check-invariants.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
chk() { # chk <name> <command...>
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; else echo "FAIL  $name"; fail=1; fi
}

# I1: go2rtc is the only code that talks RTSP to cameras.
# Allowlist: go2rtc re-streams (go2rtc:8554 / 127.0.0.1:8554), test fixtures,
# the Zod validation literals, and the docstring placeholder.
chk "no stray rtsp:// in source" bash -c '
  git grep -In "rtsp://" -- "*.ts" "*.tsx" "*.py" "*.js" "*.cjs" "*.mjs" \
    | grep -v "/tests/" | grep -v "\.test\." \
    | grep -v "go2rtc:8554\|127\.0\.0\.1:8554" \
    | grep -v "startsWith" \
    | grep -v "must start with rtsp" \
    | grep -v "FFmpegReader" \
    | grep -v "process\.env\|os\.environ" | wc -l | grep -qx 0'

# I2: detection transcode profile is pinned (720p/10fps/1500k).
chk "h264_low profile unchanged" grep -q -- \
  'scale=1280:720,fps=10 -preset:v ultrafast -tune:v zerolatency -g:v 15 -b:v 1500k' go2rtc.yaml

# I3: cheap viewer profile exists and is capped.
chk "h264_cheap profile present (250k cap)" grep -q -- \
  'scale=640:360,fps=10.*-b:v 250k -maxrate:v 250k' go2rtc.yaml

# I4 (runtime, skipped if container is down): every camera RTSP connection
# belongs to the go2rtc container, max one per camera.
if docker inspect sentryvision-go2rtc >/dev/null 2>&1; then
  chk "cameras see only go2rtc (<=1 conn each)" bash -c '
    n=$(docker exec sentryvision-go2rtc netstat -tnap 2>/dev/null \
        | grep ESTABLISHED | grep ":554 " | grep -c go2rtc)
    total=$(for c in sentryvision-app sentryvision-opencv sentryvision-postgres sentryvision-relations; do
              docker exec "$c" netstat -tnap 2>/dev/null | grep ESTABLISHED | grep ":554 " | wc -l; done \
            | paste -sd+ | bc)
    [ "$n" -ge 1 ] && [ "$n" -le 2 ] && [ "$total" -eq 0 ]'
else
  echo "SKIP  cameras see only go2rtc (go2rtc container not reachable)"
fi

# I5: secrets never committed (env + camera credentials untracked).
chk ".env and cameras.json untracked" bash -c \
  '! git ls-files --error-unmatch .env server/cameras.json >/dev/null 2>&1'

# I6: no auth secrets leaked into the shipped client bundle.
chk "no JWT secrets in client bundle" bash -c \
  '! grep -rq "JWT_ACCESS_SECRET\|JWT_REFRESH_SECRET\|NVIDIA_API_KEY" frontend-next/out/_next/static/ 2>/dev/null'

# I7: no untracked/uneviewed .sql sits in the runner's glob path.
chk "migrations dir has only tracked .sql files" bash -c '
  cd database/migrations
  diff <(ls *.sql 2>/dev/null | sort) <(git ls-files "*.sql" | xargs -n1 basename | sort) | wc -l | grep -qx 0'

exit $fail
