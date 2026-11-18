// Host-wide slots for heavy commands (builds, test runs, simulators). Pure text and parsing, no I/O:
// artifacts.ts publishes the script and the capacity file, delegationBrief.ts tells agents to use it.

/** The wait chunk stays under about 9 minutes so an agent's Bash tool does not background the call. */
export const HEAVY_LIMITS = { waitSeconds: 480, beatSeconds: 15, pollSeconds: 2 };

/** The heavySlots setting: an integer string 1 to 8, anything else means 2 (like stallThresholdMs). */
export function heavySlotCount(values: { heavySlots?: string }): number {
  return /^[1-8]$/.test(values.heavySlots ?? "") ? Number(values.heavySlots) : 2;
}

/** The wrapper `chief-heavy-<hash>.sh`: `bash <script> <sim|test|build> -- <command> [args...]` runs the command once a slot
 * of the pool is free; its exit status passes through. bash 3.2 (macOS /bin/bash). No `${` in the text: it would clash with the template.
 * The capacity is never baked in: every admission round reads `slots` beside the script (missing or invalid = 1; sim = 1).
 * Admission is recorded by removing a private marker file inside the lock, so a payload's own exit 75 is never read as "busy". */
export function heavyScript(limits = HEAVY_LIMITS): string {
  return String.raw`#!/bin/bash
# Usage: bash chief-heavy-<hash>.sh <sim|test|build> -- <command> [args...]
# shortcut: macOS lockf only; add flock(1) when a Linux host runs Chief workers
# shortcut: lockf is not FIFO; a waiter can lose to a newer one. Add a ticket queue if starvation shows up.
SECONDS=0
WAIT=${limits.waitSeconds}
BEAT=${limits.beatSeconds}
POLL=${limits.pollSeconds}

usage() {
  echo "usage: bash $0 <sim|test|build> -- <command> [args...]" >&2
  exit 2
}
if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then usage; fi
case "$1" in sim|test|build) ;; *) usage ;; esac
POOL=$1
shift 2

if ( set -u; : "$CHIEF_HEAVY_HELD" ) 2>/dev/null; then exec "$@"; fi
if ! command -v lockf >/dev/null 2>&1; then
  echo "[chief-heavy] no lockf: running unthrottled" >&2
  exec "$@"
fi

HEAVY=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HEAVY/locks"

# The pool's capacity: sim is always 1; else the first line of slots when it is exactly one digit 1-8, else 1.
capacity() {
  if [ "$POOL" = sim ]; then echo 1; return; fi
  line=""
  { { IFS= read -r line; } < "$HEAVY/slots"; } 2>/dev/null
  case "$line" in [1-8]) echo "$line" ;; *) echo 1 ;; esac
}

no_marker() {
  echo "[chief-heavy] cannot create admission marker; command not run" >&2
  exit 70
}
TMPD=$TMPDIR
if [ -z "$TMPD" ]; then TMPD=/tmp; fi
MARK=$(mktemp "$TMPD/chief-heavy.XXXXXX") || no_marker
trap 'rm -f "$MARK"' EXIT

# Runs inside the lock: removing the marker records the admission before the command starts.
INNER='rm "$1" || exit 70
who="$2.who"
shift 2
t=$BB_THREAD_ID
if [ -z "$t" ]; then t=unknown; fi
{ printf "%s\n%s\n%s\n%s\n" "$$" "$t" "$(date +%s)" "$(printf "%s" "$*" | tr "\n" " " | cut -c1-120)"; } 2>/dev/null > "$who" || true
export CHIEF_HEAVY_HELD=1
if [ -n "$CHIEF_HEAVY_WAITED" ]; then printf "[chief-heavy] got %s after %ss\n" "$CHIEF_HEAVY_SLOT" "$CHIEF_HEAVY_WAITED" >&2; fi
unset CHIEF_HEAVY_SLOT CHIEF_HEAVY_WAITED
exec "$@"'

# One stderr line naming the holder of each of the N busy slots.
beat() {
  out=""
  i=1
  while [ "$i" -le "$1" ]; do
    t=""; e=""; c=""
    { { IFS= read -r t; IFS= read -r t; IFS= read -r e; IFS= read -r c; } < "$HEAVY/locks/$POOL.$i.who"; } 2>/dev/null
    case "$e" in
      ""|*[!0-9]*) who=unknown ;;
      *) who="$t $c $(( $(date +%s) - e ))s" ;;
    esac
    out="$out$who; "
    i=$(( i + 1 ))
  done
  printf '[chief-heavy] waiting %ss for %s (%s busy): %s\n' "$SECONDS" "$POOL" "$1" "$out" >&2
}

# The deadline gates every round: checked after each failed round and after each poll sleep, before lockf runs again.
expired() {
  if [ "$SECONDS" -ge "$WAIT" ]; then
    printf '[chief-heavy] %s: all %s slots busy for %ss; run the same command again in the foreground\n' "$POOL" "$1" "$SECONDS" >&2
    exit 75
  fi
}

WAITED=""
LAST_BEAT=0
while :; do
  N=$(capacity)
  i=1
  while [ "$i" -le "$N" ]; do
    { : > "$MARK"; } 2>/dev/null || no_marker
    CHIEF_HEAVY_SLOT="$POOL slot $i" CHIEF_HEAVY_WAITED="$WAITED" lockf -k -s -t 0 "$HEAVY/locks/$POOL.$i" /bin/bash -c "$INNER" _ "$MARK" "$HEAVY/locks/$POOL.$i" "$@"
    s=$?
    # The marker alone tells whether the command ran: gone = it ran and exited s, whatever s is.
    if [ ! -e "$MARK" ]; then exit "$s"; fi
    if [ "$s" -ne 75 ]; then
      echo "[chief-heavy] admission failed (status $s); command not run" >&2
      exit "$s"
    fi
    i=$(( i + 1 ))
  done
  WAITED=$SECONDS
  expired "$N"
  if [ $(( SECONDS - LAST_BEAT )) -ge "$BEAT" ]; then
    beat "$N"
    LAST_BEAT=$SECONDS
  fi
  sleep "$POLL"
  expired "$N"
done
`;
}
