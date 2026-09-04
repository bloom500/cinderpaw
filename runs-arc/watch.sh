#!/usr/bin/env bash
# Live view of a run. One line per game, refreshed every 5s.
#
#   bash runs-arc/watch.sh                 # the run named in CURRENT_AB
#   bash runs-arc/watch.sh clean-...-2238  # a specific one
#
# Reads the logs the games are already writing — it starts nothing, stops
# nothing and costs nothing, so it is safe to open and close at any time.
set -u
cd "D:/Cinderpaw Agent" || exit 1
RUN="${1:-$(cat runs-arc/CURRENT_AB)}"
ARM="${2:-B}"
DIR="runs-arc/$RUN/$ARM"
[ -d "$DIR" ] || { echo "no such run: $DIR"; exit 1; }

while true; do
  printf '\033[H\033[2J'                       # home, clear
  echo "ARC-AGI-3  $RUN  arm $ARM   $(date +%H:%M:%S)"
  echo
  printf '%-16s %7s %7s %-14s %-13s %s\n' GAME PRESSES LEVELS LAST STATE NOTE
  done_n=0; crash_n=0; total=0
  for f in "$DIR"/*.log; do
    [ -f "$f" ] || continue
    game=$(basename "$f" .log)
    # The press lines look like "   12  ACTION6:41,4   NOT_FINISHED  levels=0/9"
    last=$(grep -E '^ *[0-9]+  ' "$f" | tail -1)
    n=$(echo "$last" | awk '{print $1}')
    act=$(echo "$last" | awk '{print $2}')
    st=$(echo "$last" | awk '{print $3}')
    lv=$(echo "$last" | grep -o 'levels=[0-9]*/[0-9]*' | cut -d= -f2)
    note=""
    if grep -q '^result      ' "$f"; then
      note="done $(grep -m1 '^spend       ' "$f" | awk '{print $2}')"; done_n=$((done_n+1))
    elif grep -qE '^(error:|Bun v)' "$f"; then
      note="CRASHED"; crash_n=$((crash_n+1))
    fi
    total=$((total + ${n:-0}))
    printf '%-16s %7s %7s %-14s %-13s %s\n' "$game" "${n:-0}" "${lv:-–}" "${act:-–}" "${st:-starting}" "$note"
  done | sort
  echo
  # AVO is the only external number on this benchmark: 6,624 actions over 25
  # games. Ours beside it, live, so the comparison is not a post-hoc surprise.
  echo "presses $total   (NVIDIA AVO used 6624 over 25 games, ~265 each)"
  echo "finished $done_n/25   crashed $crash_n"
  echo
  echo "ctrl-c closes this view; the run keeps going."
  sleep 5
done
