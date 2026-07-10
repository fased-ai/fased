#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=install-runtime-profile.sh
. "$ROOT_DIR/scripts/install-runtime-profile.sh"

expect_prebuilt() {
  fased_should_use_prebuilt_release_runtime "$@" || {
    echo "Expected prebuilt runtime: $*" >&2
    exit 1
  }
}

expect_source() {
  if fased_should_use_prebuilt_release_runtime "$@"; then
    echo "Expected source runtime: $*" >&2
    exit 1
  fi
}

expect_prebuilt local 0 0 0 Linux x86_64
expect_prebuilt local 0 0 0 Linux aarch64
expect_prebuilt hosting 0 0 0 Linux x86_64
expect_source local 1 0 0 Linux x86_64
expect_source local 0 1 0 Linux x86_64
expect_source hosting 0 0 1 Linux x86_64
expect_source local 0 0 0 Darwin arm64
expect_source local 0 0 0 Linux riscv64

echo "install runtime profile smoke passed"
