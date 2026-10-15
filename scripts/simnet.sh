#!/usr/bin/env bash
# Runs a command as if this machine were on a different network (Linux only).
#
#   scripts/simnet.sh [--profile none|hotspot|lossy] -- <command> [args...]
#
# The command gets its own network namespace with a private subnet behind a
# user-mode NAT (pasta), and cannot reach this machine's LAN, as a laptop on
# another network could not. The profile adds delay and loss to its outgoing
# traffic with tc netem. No root needed: it uses an unprivileged user namespace.
#
# Example, with `potluck serve` running normally on this machine:
#
#   scripts/simnet.sh --profile hotspot -- node scripts/rehearse.js consumer --label sim-hotspot
#
# What it does not simulate: a different public IP. Traffic still leaves
# through this machine's router, so carrier-grade NAT (phone hotspots) is
# not covered. Delay applies to outgoing traffic only.
set -euo pipefail

profile=none
while [ $# -gt 0 ]; do
  case $1 in
    --profile) profile=$2; shift 2 ;;
    --) shift; break ;;
    *) echo "usage: $0 [--profile none|hotspot|lossy] -- <command> [args...]" >&2; exit 1 ;;
  esac
done
[ $# -gt 0 ] || { echo "usage: $0 [--profile none|hotspot|lossy] -- <command> [args...]" >&2; exit 1; }

case $profile in
  none) netem= ;;
  hotspot) netem='delay 80ms 20ms loss 1%' ;;
  lossy) netem='delay 150ms 50ms loss 5%' ;;
  *) echo "unknown profile '$profile'" >&2; exit 1 ;;
esac

command -v pasta >/dev/null || { echo "simnet needs pasta (package: passt)" >&2; exit 1; }

# This machine's IPv4 subnets. Blocking them inside the namespace stops
# HyperDHT from taking a LAN shortcut that a separate network would not have.
lans=$(ip -o -4 route show scope link | awk '{print $1}' | sort -u | paste -sd ' ')

# Exported so the inner shell can read them without quoting the command.
export SIMNET_LANS=$lans SIMNET_NETEM=$netem

exec pasta --quiet --config-net -a 10.77.0.2 -n 24 -g 10.77.0.1 -T 11434 -- sh -c '
  for net in $SIMNET_LANS; do ip route add unreachable "$net"; done
  if [ -n "$SIMNET_NETEM" ]; then
    dev=$(ip route show default | awk "{print \$5; exit}")
    tc qdisc add dev "$dev" root netem $SIMNET_NETEM
  fi
  echo "simnet: subnet 10.77.0.0/24, LAN blocked (${SIMNET_LANS:-none}), netem: ${SIMNET_NETEM:-off}" >&2
  exec "$@"
' simnet "$@"
