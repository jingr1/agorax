#!/usr/bin/env bash
# Ensure a Go toolchain new enough for agorax-agent-daemon (go.work: go 1.25).
#
# Hot path is a VERSION-file read of ~/.local/go${AGORAX_GO_VERSION}. A download
# happens only when no sufficient toolchain is already on PATH or in the usual
# install locations.
#
#   source scripts/ensure-go.sh
#   agorax_prefer_local_go   # prepend an existing SDK; never downloads
#   agorax_ensure_go         # install the pinned SDK when nothing usable exists

AGORAX_GO_VERSION_DEFAULT=1.27.2
AGORAX_GO_MIN_VERSION_DEFAULT=1.25.0

agorax_go_prefix() {
  if [[ -n "${AGORAX_GO_ROOT:-}" ]]; then
    printf '%s' "$AGORAX_GO_ROOT"
    return 0
  fi
  printf '%s' "${HOME:?}/.local/go${AGORAX_GO_VERSION:-$AGORAX_GO_VERSION_DEFAULT}"
}

agorax_prepend_path() {
  local dir="$1"
  case ":${PATH:-}:" in
    *":${dir}:"*) ;;
    *) export PATH="${dir}${PATH:+:${PATH}}" ;;
  esac
}

# $1 >= $2, versions like 1.25 or 1.27.2. Pre-release suffixes are ignored.
agorax_version_ge() {
  local have="$1" need="$2"
  local h1 h2 h3 n1 n2 n3
  have="${have%%[^0-9.]*}"
  need="${need%%[^0-9.]*}"
  IFS=. read -r h1 h2 h3 <<< "$have"
  IFS=. read -r n1 n2 n3 <<< "$need"
  h1=$((10#${h1:-0}))
  h2=$((10#${h2:-0}))
  h3=$((10#${h3:-0}))
  n1=$((10#${n1:-0}))
  n2=$((10#${n2:-0}))
  n3=$((10#${n3:-0}))
  if (( h1 != n1 )); then
    (( h1 > n1 ))
    return
  fi
  if (( h2 != n2 )); then
    (( h2 > n2 ))
    return
  fi
  (( h3 >= n3 ))
}

agorax_sdk_release() {
  local prefix="$1" line
  [[ -x "$prefix/bin/go" && -f "$prefix/VERSION" ]] || return 1
  IFS= read -r line < "$prefix/VERSION" || return 1
  line="${line#go}"
  [[ "$line" =~ ^[0-9]+\.[0-9]+([.][0-9]+)?$ ]] || return 1
  printf '%s' "$line"
}

agorax_go_release_cmd() {
  local line
  line=$("$@" version 2>/dev/null) || return 1
  [[ "$line" == "go version go"* ]] || return 1
  line="${line#"go version go"}"
  line="${line%% *}"
  line="${line%%[^0-9.]*}"
  [[ "$line" =~ ^[0-9]+\.[0-9]+ ]] || return 1
  printf '%s' "$line"
}

agorax_prefer_local_go() {
  local min="${AGORAX_GO_MIN_VERSION:-$AGORAX_GO_MIN_VERSION_DEFAULT}"
  local prefix rel
  prefix=$(agorax_go_prefix)
  if rel=$(agorax_sdk_release "$prefix"); then
    if agorax_version_ge "$rel" "$min"; then
      agorax_prepend_path "$prefix/bin"
    fi
  fi
  return 0
}

agorax_use_path_go() {
  local min="$1" rel
  command -v go >/dev/null 2>&1 || return 1
  rel=$(agorax_go_release_cmd go) || return 1
  agorax_version_ge "$rel" "$min" || return 1
  return 0
}

agorax_use_known_sdk() {
  local min="$1" dir rel best="" best_rel="" entry
  # Bash 3.2 + set -u errors on an empty array. Walk the globs directly;
  # an unmatched glob stays literal and fails the directory test.
  for entry in \
    "${HOME:?}/.local"/go*/ \
    "${HOME}/go" \
    "/usr/local/go"
  do
    dir="${entry%/}"
    [[ -d "$dir" ]] || continue
    rel=$(agorax_sdk_release "$dir") || continue
    agorax_version_ge "$rel" "$min" || continue
    if [[ -z "$best_rel" ]] || agorax_version_ge "$rel" "$best_rel"; then
      best="$dir"
      best_rel="$rel"
    fi
  done
  [[ -n "$best" ]] || return 1
  agorax_prepend_path "$best/bin"
}

agorax_go_sha256() {
  case "$1" in
    go1.27.2.darwin-arm64.tar.gz)
      printf '%s' '76812b213b1b2302c978d28fa52fa92d541704b9e7d9d5db8002c50e4018c4c5'
      ;;
    go1.27.2.darwin-amd64.tar.gz)
      printf '%s' '587b59182488b23aa6e5fc25110405a3e0e5b38ed2f5b2f46ed13c32aee356fe'
      ;;
    go1.27.2.linux-arm64.tar.gz)
      printf '%s' '94f3e30b8e374bc285e7dadc11e0865726b9bc6e85b841ccceaabc0214c6b7c8'
      ;;
    go1.27.2.linux-amd64.tar.gz)
      printf '%s' 'ecbadb99091a3f46e31f5f934b068b1864eafa7995211b39eaddf76996045fe5'
      ;;
    *)
      return 1
      ;;
  esac
}

agorax_sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi
  sha256sum "$1" | awk '{print $1}'
}

agorax_acquire_go_lock() {
  local lock="$1" ready="$2"
  local now mtime waited=0
  mkdir -p "$(dirname "$lock")"
  while true; do
    if mkdir "$lock" 2>/dev/null; then
      return 0
    fi
    if [[ -x "$ready" ]]; then
      return 1
    fi
    now=$(date +%s)
    mtime=$(stat -f %m "$lock" 2>/dev/null || stat -c %Y "$lock" 2>/dev/null || printf '%s' "$now")
    if (( now - mtime > 180 )) && rmdir "$lock" 2>/dev/null; then
      continue
    fi
    if (( waited >= 180 )); then
      echo "ensure-go: timed out waiting for another Go install" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
}

agorax_download_go() {
  local dest="$1"
  shift
  local url
  for url in "$@"; do
    echo "ensure-go: downloading $url" >&2
    if curl -fsSL --retry 3 --retry-delay 2 --connect-timeout 10 --max-time 600 \
      -o "$dest" "$url"; then
      return 0
    fi
    rm -f "$dest"
    echo "ensure-go: could not download $url" >&2
  done
  echo "ensure-go: all download URLs failed" >&2
  return 1
}

agorax_install_go() {
  local version="$1" prefix="$2"
  local os arch filename expect digest tmp lock home
  home="${HOME:?}"
  case "$prefix" in
    "$home/.local/go"[0-9]*) ;;
    *)
      echo "ensure-go: refusing to install Go outside ~/.local/go<version> ($prefix)" >&2
      exit 1
      ;;
  esac

  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *)
      echo "ensure-go: unsupported OS $os; install Go ${version} and put it on PATH" >&2
      exit 1
      ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=amd64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *)
      echo "ensure-go: unsupported arch $arch; install Go ${version} and put it on PATH" >&2
      exit 1
      ;;
  esac

  filename="go${version}.${os}-${arch}.tar.gz"
  expect=$(agorax_go_sha256 "$filename") || {
    echo "ensure-go: no pinned checksum for $filename" >&2
    exit 1
  }
  lock="${home}/.local/.agorax-go-${version}.lock"

  if ! agorax_acquire_go_lock "$lock" "$prefix/bin/go"; then
    return 0
  fi

  if rel=$(agorax_sdk_release "$prefix"); then
    if agorax_version_ge "$rel" "${AGORAX_GO_MIN_VERSION:-$AGORAX_GO_MIN_VERSION_DEFAULT}"; then
      rmdir "$lock" 2>/dev/null || true
      return 0
    fi
  fi

  echo "ensure-go: Go ${version} is not installed; downloading ${os}/${arch}" >&2
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/agorax-go.XXXXXX")
  (
    # Independent of the caller's shell options: a failed curl must not
    # fall through into checksum verification.
    set -euo pipefail
    if [[ -n "${AGORAX_GO_MIRROR:-}" ]]; then
      agorax_download_go "$tmp/go.tgz" "${AGORAX_GO_MIRROR%/}/${filename}"
    else
      agorax_download_go "$tmp/go.tgz" \
        "https://dl.google.com/go/${filename}" \
        "https://mirrors.aliyun.com/golang/${filename}" \
        "https://mirrors.cloud.tencent.com/go/${filename}"
    fi
    [[ -s "$tmp/go.tgz" ]]
    digest=$(agorax_sha256_file "$tmp/go.tgz")
    if [[ "$digest" != "$expect" ]]; then
      echo "ensure-go: checksum mismatch for $filename" >&2
      echo "ensure-go: expected $expect" >&2
      echo "ensure-go:      got $digest" >&2
      exit 1
    fi
    tar -C "$tmp" -xzf "$tmp/go.tgz"
    [[ -x "$tmp/go/bin/go" ]] || {
      echo "ensure-go: archive did not contain go/bin/go" >&2
      exit 1
    }
    rm -rf "$prefix"
    mkdir -p "$(dirname "$prefix")"
    mv "$tmp/go" "$prefix"
  ) || {
    rm -rf "$tmp"
    rmdir "$lock" 2>/dev/null || true
    exit 1
  }
  rm -rf "$tmp"
  rmdir "$lock" 2>/dev/null || true
  echo "ensure-go: installed $("$prefix/bin/go" version)" >&2
}

agorax_ensure_go() {
  local min="${AGORAX_GO_MIN_VERSION:-$AGORAX_GO_MIN_VERSION_DEFAULT}"
  local version="${AGORAX_GO_VERSION:-$AGORAX_GO_VERSION_DEFAULT}"
  local prefix rel
  prefix=$(agorax_go_prefix)

  if rel=$(agorax_sdk_release "$prefix"); then
    if agorax_version_ge "$rel" "$min"; then
      agorax_prepend_path "$prefix/bin"
      return 0
    fi
  fi

  if agorax_use_path_go "$min"; then
    return 0
  fi

  if agorax_use_known_sdk "$min"; then
    return 0
  fi

  agorax_install_go "$version" "$prefix"
  agorax_prepend_path "$prefix/bin"
  command -v go >/dev/null 2>&1 || {
    echo "ensure-go: install finished but go is still not on PATH" >&2
    exit 1
  }
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  agorax_ensure_go
  command -v go
  go version
fi
