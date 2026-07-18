#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

image="${1:?usage: scripts/check-hosted-image.sh IMAGE}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/nettle-host-smoke.XXXXXX")"
archive="$scratch/sources.tar.gz"
download="$scratch/design.nettle"
container="nettle-host-smoke-$$"
volume="nettle-host-smoke-$$"
port="${NETTLE_HOST_SMOKE_PORT:-18080}"
base_url="http://127.0.0.1:$port"

cleanup() {
  status=$?
  trap - EXIT
  if docker container inspect "$container" > /dev/null 2>&1; then
    if [[ "$status" -ne 0 ]]; then
      docker logs "$container" || true
    fi
    docker rm --force "$container" > /dev/null || true
  fi
  docker volume rm "$volume" > /dev/null 2>&1 || true
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT

COPYFILE_DISABLE=1 tar \
  --create \
  --gzip \
  --file "$archive" \
  --directory "$root/integration_tests/smoke" \
  project.f rtl

docker volume create "$volume" > /dev/null
docker run --detach --platform linux/amd64 --name "$container" \
  --user 10001:10001 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --publish "127.0.0.1:$port:8080" \
  --mount "type=volume,source=$volume,target=/data" \
  --tmpfs /scratch:rw,nosuid,nodev,noexec,size=1g,mode=1777 \
  "$image" host \
  --storage-root=/data \
  --scratch-root=/scratch \
  --max-queued-builds=2 \
  --max-upload-bytes=10485760 \
  --build-timeout=120s \
  --evict-after=1d > /dev/null

wait_until_ready() {
  for _ in {1..30}; do
    if curl --fail --silent "$base_url/readyz" > /dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  printf "Timed out waiting for hosted Nettle readiness\n" >&2
  return 1
}
wait_until_ready

created="$(
  curl \
    --fail \
    --silent \
    --show-error \
    --header "X-Nettle-Upload: 1" \
    --form-string "kind=sources" \
    --form "file=@$archive;filename=smoke.tar.gz;type=application/gzip" \
    "$base_url/api/v1/sessions"
)"
token="$(
  printf "%s" "$created" \
    | sed -n 's/.*"token":"\([0-9a-f]\{64\}\)".*/\1/p'
)"
if [[ ${#token} -ne 64 ]]; then
  printf "Hosted smoke returned no valid capability token: %s\n" "$created" >&2
  exit 1
fi

state=""
for _ in {1..120}; do
  status="$(
    curl \
      --fail \
      --silent \
      --show-error \
      "$base_url/api/v1/sessions/$token/status"
  )"
  state="$(
    printf "%s" "$status" \
      | sed -n 's/.*"state":"\([^"]*\)".*/\1/p'
  )"
  case "$state" in
    ready)
      break
      ;;
    failed)
      printf "Hosted source build failed: %s\n" "$status" >&2
      exit 1
      ;;
    queued | building)
      sleep 1
      ;;
    *)
      printf "Hosted source build returned invalid status: %s\n" "$status" >&2
      exit 1
      ;;
  esac
done
if [[ "$state" != "ready" ]]; then
  printf "Timed out waiting for hosted source build\n" >&2
  exit 1
fi

docker exec "$container" test ! -e "/data/sessions/$token/sources.tar.gz"
docker restart "$container" > /dev/null
wait_until_ready

status="$(
  curl \
    --fail \
    --silent \
    --show-error \
    "$base_url/api/v1/sessions/$token/status"
)"
if [[ "$status" != *'"state":"ready"'* ]]; then
  printf "Hosted session was not ready after restart: %s\n" "$status" >&2
  exit 1
fi

curl \
  --fail \
  --silent \
  --show-error \
  "$base_url/api/v1/sessions/$token/download" \
  --output "$download"
docker run --rm \
  --platform linux/amd64 \
  --user 10001:10001 \
  --read-only \
  --network none \
  --volume "$download:/tmp/design.nettle:ro" \
  "$image" validate /tmp/design.nettle > /dev/null

printf "Hosted image smoke passed: uploaded, queued, compiled, persisted, restarted, downloaded, and validated.\n"
