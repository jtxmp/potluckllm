#!/usr/bin/env bash
# Plays the README demo in tmux. Recorded by demo/demo.tape (vhs); can also be
# run by hand from the repo root to watch it live.
#
# Left: laptop A, the provider, on this machine's network.
# Right: laptop B, in a simulated separate network (scripts/simnet.sh):
#   top pane runs `potluck use`, bottom pane is the client.
#
# Needs Linux, tmux, jq, pasta, and Ollama on 127.0.0.1:11434 with llama3.2:3b.
# Identities and the team file are throwaway, created in a temp directory.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d /tmp/potluck-demo.XXXXXX)
mkdir -p "$W/a" "$W/b"
OUTER="tmux -S $W/outer.sock"
INNER="tmux -S $W/inner.sock"
A=demo:0.0 B1=b:0.0 B2=b:0.1

# Runs however the script ends, including when vhs closes the terminal.
cleanup () {
  set +e
  [ -n "${PLAYER:-}" ] && kill "$PLAYER" 2>/dev/null
  $INNER kill-server 2>/dev/null
  $OUTER kill-server 2>/dev/null
  rm -rf "$W"
}
trap cleanup EXIT HUP INT TERM

cat > "$W/tmux.conf" <<'EOF'
set -g status off
set -g pane-border-status top
set -g pane-border-format ' #{pane_title} '
set -g pane-border-style fg=colour244
set -g pane-active-border-style fg=colour244
set -g default-terminal screen-256color
EOF

for side in a b; do
  label=$(echo $side | tr ab AB)
  cat > "$W/$side.rc" <<EOF
export HOME=$W/$side
cd $W/$side
PS1='\[\e[1;36m\]$label \$\[\e[0m\] '
potluck () { node $REPO/bin/potluck.js "\$@"; }
ask () {
  curl -sN localhost:11500/v1/chat/completions -H 'content-type: application/json' \\
    -d "\$(jq -nc --arg p "\$1" '{model:"llama3.2:3b",stream:true,messages:[{role:"user",content:\$p}]}')" |
    sed -un 's/^data: //p' | grep --line-buffered -v '^\[DONE\]' |
    jq -j --unbuffered '.choices[0].delta.content // empty'
  echo
}
EOF
done

# Identities exist before the recording so `potluck id` prints the key at once.
KEY_B=$(HOME=$W/b node "$REPO/bin/potluck.js" id 2>/dev/null)
HOME=$W/a node "$REPO/bin/potluck.js" id >/dev/null 2>&1

$OUTER -f "$W/tmux.conf" new-session -d -s demo -x 180 -y 46 "bash --rcfile $W/a.rc"
$OUTER select-pane -t $A -T 'laptop A · home network · provider'
$OUTER split-window -h -t $A \
  "$REPO/scripts/simnet.sh --profile hotspot -- tmux -S $W/inner.sock -f $W/tmux.conf new-session -s b 'bash --rcfile $W/b.rc' 2>/dev/null"
$OUTER select-pane -t demo:0.1 -T 'laptop B · simulated separate network: own NAT, +80 ms, 1% loss'

# type <tmux> <pane> <text>: types like a person, then presses Enter.
type () {
  local tm=$1 pane=$2 text=$3 i
  for ((i = 0; i < ${#text}; i++)); do $tm send-keys -t "$pane" -l "${text:i:1}"; sleep 0.03; done
  sleep 0.3
  $tm send-keys -t "$pane" Enter
}
# wait_for <tmux> <pane> <regex>
wait_for () {
  local i
  for i in $(seq 300); do
    $1 capture-pane -p -t "$2" | grep -qE "$3" && return 0
    sleep 0.2
  done
  echo "timed out waiting for /$3/ in $2" >&2
  return 1
}

play () {
  for i in $(seq 50); do [ -S "$W/inner.sock" ] && break; sleep 0.1; done
  $INNER split-window -v -t $B1 "bash --rcfile $W/b.rc"
  $INNER select-pane -t $B1 -T 'potluck use'
  $INNER select-pane -t $B2 -T 'client'
  sleep 2

  type "$INNER" $B2 'potluck id'
  sleep 1.5
  type "$OUTER" $A 'potluck team init demo --member laptop-a'
  sleep 1
  type "$OUTER" $A "potluck team add laptop-b $KEY_B"
  sleep 1.5
  cp "$W/a/team.json" "$W/b/team.json"
  type "$INNER" $B2 '# team.json received from laptop A'
  sleep 1

  type "$OUTER" $A 'ss -tln | grep 11434    # Ollama listens on localhost only'
  sleep 2
  type "$OUTER" $A 'potluck serve'
  wait_for "$OUTER" $A 'serving'
  sleep 1

  type "$INNER" $B1 'potluck use'
  wait_for "$INNER" $B1 'hello'
  sleep 1.5

  type "$INNER" $B2 'curl -s localhost:11500/potluck/status | jq -c'
  sleep 2.5
  type "$INNER" $B2 '# ask = streamed POST to localhost:11500/v1/chat/completions'
  type "$INNER" $B2 'ask "In two sentences, why should a team ship a smaller scope first?"'
  wait_for "$OUTER" $A ' end peer='
  sleep 2.5

  type "$INNER" $B2 'HOME=./intruder potluck use --port 11501    # a key not in team.json'
  wait_for "$OUTER" $A 'reject peer='
  sleep 2
  $INNER send-keys -t $B2 C-c
  sleep 0.5
  type "$INNER" $B2 '# rejected by laptop A: not in team.json'
  sleep 4
  $OUTER kill-server 2>/dev/null || true
}

play &
PLAYER=$!
$OUTER attach -t demo || true
