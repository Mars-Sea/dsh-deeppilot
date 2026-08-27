#!/bin/sh
# Build the embedded tunnel helper for every supported platform/arch and
# refresh bin/SHA256SUMS. Used by the build-helpers CI workflow and by
# maintainers who want to regenerate the full matrix locally.
#
# On a single machine we can only cross-compile the helper for foreign OS
# targets. CGO is required by some Tailscale subsystems (macOS frameworks,
# Windows sspi, Linux netlink), so we leave CGO_ENABLED unset and rely on
# the platform-native Go toolchain. Cross-compiling from macOS to Linux
# typically still works because Tailscale keeps the affected files behind
# build tags; cross-compiling to Windows from macOS requires cgo and is
# expected to be done by the windows-latest runner in CI.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BIN_DIR="$PLUGIN_DIR/bin"
SUMS_FILE="$BIN_DIR/SHA256SUMS"

# Each entry is "<GOOS>-<GOARCH>". Adjust this list when adding new
# supported platforms. The bundle size for every entry is roughly 6 MB
# (compressed); the matrix below is ~36 MB on the wire.
TARGETS="
darwin-arm64
darwin-amd64
linux-arm64
linux-amd64
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
      go build -trimpath -ldflags='-s -w' \
        -o "$OUT_DIR/$OUT_NAME" . )
  chmod 0755 "$OUT_DIR/$OUT_NAME"
  if [ "$GOOS" = "windows" ]; then
    # Windows cannot chmod +x, but the .exe is already executable.
    :
  fi
  # Compute the hash from a stable relative path so the manifest is
  # portable across checkouts.
  REL="$target/$OUT_NAME"
  ( cd "$BIN_DIR" && shasum -a 256 -- "$REL" >> "$TMP_SUMS" )
done

# Sort + dedupe, then atomically replace the published manifest.
sort -u -o "$TMP_SUMS" "$TMP_SUMS"
mv "$TMP_SUMS" "$SUMS_FILE"
echo "==> wrote $SUMS_FILE"
cat "$SUMS_FILE"
