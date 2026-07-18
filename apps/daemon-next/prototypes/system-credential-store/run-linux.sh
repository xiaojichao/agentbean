#!/bin/sh
# THROWAWAY PROTOTYPE for #677.
set -eu

if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
  echo 'LINUX_X64_REQUIRED' >&2
  exit 1
fi

prototype_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "${1:-}" != "--inside-session" ]; then
  exec dbus-run-session -- "$0" --inside-session
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/agentbean-secret-service-prototype.XXXXXX")
trap 'rm -rf "$scratch"' EXIT INT TERM

cc "$prototype_root/LinuxSecretServiceProbe.c" \
  $(pkg-config --cflags --libs libsecret-1) \
  -o "$scratch/linux-secret-service-probe"

export XDG_DATA_HOME="$scratch/data"
export XDG_CONFIG_HOME="$scratch/config"
export XDG_RUNTIME_DIR="$scratch/runtime"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

keyring_password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
daemon_environment=$(printf '%s' "$keyring_password" | gnome-keyring-daemon --unlock --components=secrets)
eval "$daemon_environment"
unset keyring_password daemon_environment

"$scratch/linux-secret-service-probe"
env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY "$scratch/linux-secret-service-probe" --probe-unavailable
