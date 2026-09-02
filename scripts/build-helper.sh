#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TARGET_OS=${GOOS:-$(go env GOOS)}
TARGET_ARCH=${GOARCH:-$(go env GOARCH)}
OUTPUT_DIR="$PLUGIN_DIR/bin/$TARGET_OS-$TARGET_ARCH"

mkdir -p "$OUTPUT_DIR"
cd "$PLUGIN_DIR/helper"
CGO_ENABLED=0 GOOS="$TARGET_OS" GOARCH="$TARGET_ARCH" \
  go build -trimpath -buildvcs=false -ldflags='-s -w' -o "$OUTPUT_DIR/dsh-deeppilot-tunnel" .
chmod 0755 "$OUTPUT_DIR/dsh-deeppilot-tunnel"
