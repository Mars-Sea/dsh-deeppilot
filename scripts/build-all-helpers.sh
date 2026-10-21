#!/bin/sh
# Build the embedded tunnel helper for every supported platform/arch and
# refresh bin/SHA256SUMS. Used by the build-helpers CI workflow and by
# maintainers who want to regenerate the full matrix locally.
#
# Every target is a pure-Go cross-compile (CGO_ENABLED=0): the tsnet code
# path the helper uses needs no cgo, so any host can build every target.
# Together with -trimpath, -buildvcs=false and a fixed Go version from
# helper/go.mod, the output is byte-identical whichever OS builds it, which
# is what lets CI verify bin/ by rebuilding it.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BIN_DIR="$PLUGIN_DIR/bin"
SUMS_FILE="$BIN_DIR/SHA256SUMS"

# Each entry is "<GOOS>-<GOARCH>". Adjust this list when adding new
# supported platforms. Each binary is roughly 20-22 MB (about 8 MB
# gzipped), so the matrix below adds ~48 MB to the npm tarball.
TARGETS="
darwin-amd64
darwin-arm64
linux-amd64
linux-arm64
windows-amd64
windows-arm64
"

# Allow callers to constrain the matrix, e.g. CI on a single host.
FILTER="${HELPER_TARGETS:-}"

if ! command -v go >/dev/null 2>&1; then
  echo "error: 'go' is not on PATH" >&2
  exit 1
fi

# Make sure the helper module is tidy. Failing here usually means a new
# indirect dependency was added without go mod tidy.
( cd "$PLUGIN_DIR/helper" && go mod download >/dev/null )

TMP_SUMS=$(mktemp)
trap 'rm -f "$TMP_SUMS"' EXIT

for target in $TARGETS; do
  if [ -n "$FILTER" ] && ! echo " $FILTER " | grep -q " $target "; then
    continue
  fi
  GOOS=${target%-*}
  GOARCH=${target#*-}
  OUT_DIR="$BIN_DIR/$target"
  OUT_NAME="dsh-deeppilot-tunnel"
  if [ "$GOOS" = "windows" ]; then
    OUT_NAME="dsh-deeppilot-tunnel.exe"
  fi
  mkdir -p "$OUT_DIR"
  echo "==> building $target"
  ( cd "$PLUGIN_DIR/helper" && \
    GOOS="$GOOS" GOARCH="$GOARCH" CGO_ENABLED=0 \
      go build -trimpath -buildvcs=false -ldflags='-s -w' \
        -o "$OUT_DIR/$OUT_NAME" . )
  chmod 0755 "$OUT_DIR/$OUT_NAME"
  # Compute the hash from a stable relative path so the manifest is
  # portable across checkouts.
  REL="./$target/$OUT_NAME"
  ( cd "$BIN_DIR" && shasum -a 256 -- "$REL" >> "$TMP_SUMS" )
done

# Sort by the relative path, matching the CI merge job, then atomically replace
# the published manifest.
LC_ALL=C sort -u -k 2,2 -o "$TMP_SUMS" "$TMP_SUMS"
mv "$TMP_SUMS" "$SUMS_FILE"
echo "==> wrote $SUMS_FILE"
cat "$SUMS_FILE"
