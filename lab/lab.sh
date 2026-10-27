#!/usr/bin/env bash
# Manage the local lab VMs.  Usage: lab/lab.sh up|down|ps|status|ssh <router> [cmd]
set -euo pipefail

LAB_DIR="$(cd "$(dirname "$0")" && pwd)"
STATE="$LAB_DIR/state"
ROUTERS=(r1 r2 r3 r4)
KEY="$STATE/id_ed25519"
export LAB_STATE="$STATE"

port() { echo $((2220 + ${1#r})); }

# QEMU runs in its own session (the NixOS run script detaches it): find VMs by process name.
vm_pid() { pgrep -f "qemu-system.*-name $1( |\$)" | head -1 || true; }

ssh_r() {
  local r=$1; shift
  timeout 8 ssh -i "$KEY" -p "$(port "$r")" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o LogLevel=ERROR -o ConnectTimeout=3 root@127.0.0.1 "$@"
}

up() {
  mkdir -p "$STATE"
  [[ -f $KEY ]] || ssh-keygen -q -t ed25519 -N "" -C netmedic-lab -f "$KEY"
  cp "$KEY.pub" "$STATE/authorized_keys"
  for r in "${ROUTERS[@]}"; do
    if [[ -n $(vm_pid "$r") ]]; then
      echo "$r already running"; continue
    fi
    nix build "$LAB_DIR#vm-$r" -o "$STATE/vm-$r"
    # Each VM gets its own working dir (QEMU drops sockets/temp files there).
    mkdir -p "$STATE/$r"
    # Redirect the whole subshell, or it keeps our stdout open for the VM's lifetime.
    (cd "$STATE/$r" && TMPDIR="$STATE/$r" exec setsid "$STATE/vm-$r/bin/run-$r-vm") \
      </dev/null >"$STATE/$r.log" 2>&1 &
    echo "$r started (ssh port $(port "$r"), log $STATE/$r.log)"
  done
  echo "waiting for SSH..."
  for r in "${ROUTERS[@]}"; do
    for _ in $(seq 60); do ssh_r "$r" true 2>/dev/null && break; sleep 2; done
    ssh_r "$r" true && echo "$r ready"
  done
}

down() {
  local r pid
  for r in "${ROUTERS[@]}"; do
    pid=$(vm_pid "$r")
    if [[ -n $pid ]]; then
      kill "$pid" && echo "$r stopped"
    fi
  done
  for _ in $(seq 20); do
    pgrep -f "qemu-system.*-name r[0-9]" >/dev/null || break
    sleep 0.5
  done
}

ps_vms() {
  local r pid
  for r in "${ROUTERS[@]}"; do
    pid=$(vm_pid "$r")
    if [[ -n $pid ]]; then
      echo "$r  running  pid $pid  ssh 127.0.0.1:$(port "$r")"
    else
      echo "$r  stopped"
    fi
  done
}

status() {
  for r in "${ROUTERS[@]}"; do
    echo "=== $r"
    ssh_r "$r" birdc show protocols 2>/dev/null || echo "(unreachable)"
  done
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  ps) ps_vms ;;
  status) status ;;
  ssh) shift; ssh_r "$@" ;;
  *) echo "usage: $0 up|down|ps|status|ssh <router> [cmd]"; exit 1 ;;
esac
