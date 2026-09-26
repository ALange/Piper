#!/usr/bin/env bash
# Start, stop or restart the Piper gateway from a console.
#
#   ./piper.sh [restart|start|stop|status|logs]      (default: restart)
#
# The gateway is found as the `node server.mjs` process running from this script's folder, so a
# second copy elsewhere is left alone. Stopping sends SIGTERM, which hibernates open chats and
# records their spend; they resume on the next message. Output is appended to gw.log.
#
# Environment:
#   PORT         port to health-check after starting (default: the running gateway's, else 8787)
#   LOG          log file (default: gw.log in this folder)
#   STOP_WAIT    seconds to wait for a clean stop before SIGKILL (default: 20)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${LOG:-$DIR/gw.log}"
STOP_WAIT="${STOP_WAIT:-20}"
NODE="$(command -v node || true)"

die() { echo "piper: $*" >&2; exit 1; }

# PIDs of `node server.mjs` processes whose working directory is $DIR.
gateway_pids() {
	local proc pid
	for proc in /proc/[0-9]*; do
		pid="${proc#/proc/}"
		[ "$(readlink "$proc/cwd" 2>/dev/null)" = "$DIR" ] || continue
		tr '\0' ' ' < "$proc/cmdline" 2>/dev/null | grep -qE '(^|/)node( [^ ]+)* server\.mjs( |$)' || continue
		echo "$pid"
	done
}

# The TCP port a PID listens on, if any.
listen_port() {
	ss -ltnpH 2>/dev/null | grep "pid=$1," | awk '{print $4}' | sed 's/.*://' | head -1
}

status() {
	local pids pid
	pids="$(gateway_pids)"
	if [ -z "$pids" ]; then
		echo "piper: not running"
		return 1
	fi
	for pid in $pids; do
		echo "piper: running, pid $pid, port $(listen_port "$pid" || echo '?')"
	done
	local port="${PORT:-$(listen_port "$(echo "$pids" | head -1)")}"
	[ -n "$port" ] && curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null | head -c 300 && echo
	return 0
}

stop() {
	local pids pid waited=0
	pids="$(gateway_pids)"
	if [ -z "$pids" ]; then
		echo "piper: not running"
		return 0
	fi
	# Remember the port so the restart can health-check the same one.
	PORT="${PORT:-$(listen_port "$(echo "$pids" | head -1)")}"
	echo "piper: stopping pid $(echo $pids) (open chats hibernate and resume later)"
	kill -TERM $pids 2>/dev/null || true
	while [ -n "$(gateway_pids)" ]; do
		if [ "$waited" -ge "$STOP_WAIT" ]; then
			echo "piper: still running after ${STOP_WAIT}s, killing"
			kill -KILL $(gateway_pids) 2>/dev/null || true
			sleep 1
			break
		fi
		sleep 1
		waited=$((waited + 1))
	done
	echo "piper: stopped"
}

start() {
	[ -n "$NODE" ] || die "node is not on PATH"
	[ -f "$DIR/server.mjs" ] || die "no server.mjs in $DIR"
	if [ -n "$(gateway_pids)" ]; then
		echo "piper: already running"
		status
		return 0
	fi
	local env=()
	# The gateway refuses to run as root unless told to; this host runs it as root on purpose.
	[ "$(id -u)" -eq 0 ] && env+=(ALLOW_ROOT=1)
	cd "$DIR"
	# Where this start's output begins, so only its own lines are shown.
	local from
	from="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
	env "${env[@]}" setsid nohup "$NODE" server.mjs >> "$LOG" 2>&1 < /dev/null &
	local port="${PORT:-8787}" i
	for i in $(seq 1 30); do
		if curl -fsS "http://127.0.0.1:$port/health" > /dev/null 2>&1; then
			echo "piper: started, pid $(gateway_pids | head -1), port $port"
			tail -c +"$((from + 1))" "$LOG" | grep -E '^Piper on|migrated|sweep' || true
			return 0
		fi
		if [ -z "$(gateway_pids)" ]; then
			echo "piper: exited during startup:" >&2
			tail -c +"$((from + 1))" "$LOG" | tail -n 20 >&2
			return 1
		fi
		sleep 1
	done
	echo "piper: running but not answering on port $port after 30s; see $LOG" >&2
	return 1
}

case "${1:-restart}" in
	restart) stop && start ;;
	start) start ;;
	stop) stop ;;
	status) status ;;
	logs) tail -n "${LINES:-50}" -f "$LOG" ;;
	-h|--help|help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' ;;
	*) die "unknown command: $1 (use restart, start, stop, status or logs)" ;;
esac
