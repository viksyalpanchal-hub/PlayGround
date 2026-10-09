#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
/usr/bin/time -p pwd
if [[ -z "${CAPTURE_URL:-}" ]]; then /usr/bin/time -p printf 'CAPTURE_URL is required\n' >&2; exit 1; fi
if [[ -z "${CAPTURE_DIR:-}" ]]; then /usr/bin/time -p printf 'CAPTURE_DIR is required\n' >&2; exit 1; fi
if [[ -z "${RUNTIME_DIR:-}" ]]; then /usr/bin/time -p printf 'RUNTIME_DIR is required\n' >&2; exit 1; fi
/usr/bin/time -p printf 'capture_url=%s\ncapture_dir=%s\n' "$CAPTURE_URL" "$CAPTURE_DIR"
/usr/bin/time -p mkdir -p "$CAPTURE_DIR"
/usr/bin/time -p test -d "$CAPTURE_DIR"
/usr/bin/time -p test -f "$RUNTIME_DIR/scripts/default-capture.mjs"
status=0
/usr/bin/time -p node "$RUNTIME_DIR/scripts/default-capture.mjs" || status=$?
/usr/bin/time -p printf 'capture_exit=%s\n' "$status"
if [[ $status -ne 0 ]]; then exit "$status"; fi
/usr/bin/time -p test -f "$CAPTURE_DIR/final-desktop.png"
/usr/bin/time -p test -f "$CAPTURE_DIR/final-mobile.png"
/usr/bin/time -p ls -l "$CAPTURE_DIR/final-desktop.png" "$CAPTURE_DIR/final-mobile.png"
