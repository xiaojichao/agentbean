#!/bin/sh
# THROWAWAY PROTOTYPE for #677.
set -eu

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo 'MACOS_ARM64_REQUIRED' >&2
  exit 1
fi

prototype_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d "${TMPDIR:-/tmp}/agentbean-credential-prototype.XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM

if [ -x /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc ]; then
  swift_compiler=/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc
  macos_sdk=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk
else
  swift_compiler=$(xcrun --find swiftc)
  macos_sdk=$(xcrun --show-sdk-path)
fi

mkdir -p "$scratch/module-cache"
CLANG_MODULE_CACHE_PATH="$scratch/module-cache" \
  "$swift_compiler" \
  -sdk "$macos_sdk" \
  -module-cache-path "$scratch/module-cache" \
  "$prototype_root/MacOSCredentialProbe.swift" \
  -framework Security \
  -o "$scratch/macos-credential-probe"
"$scratch/macos-credential-probe"
