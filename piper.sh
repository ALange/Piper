#!/usr/bin/env bash
# Run the Piper gateway from a console, and build the image its chats run in.
#
#   ./piper.sh [restart|start|stop|status|logs|image|doctor|backup|restore]      (default: restart)
#
#   backup [--out DIR] [--keep N] [--no-chats]   one owner-only archive of the database, profiles, workspaces,
#                                                shared bundles and container Pi config (default: ./backups)
#   restore FILE [--stop]                        put a backup back; whatever it replaces is moved aside, never deleted
#
#   image [env] [docker build options]   build a chat image, pinned to the Pi version this host runs. env is
#                                  full (the default, piper-agent) or a folder under docker/environments,
#                                  e.g. slim (piper-agent-slim). Options go to docker build,
#                                  e.g. ./piper.sh image --build-arg WITH_RUST=0
#   doctor                         is Docker up, is the image built and current, is the network policy in place
#
# The gateway is found as the `node server.mjs` process running from this script's folder, so a
# second copy elsewhere is left alone. When a systemd unit named piper runs this folder's gateway
# (./deploy.sh --systemd), start, stop, restart and logs go through it instead. Stopping sends SIGTERM, which stops open chats' containers and
# records their spend; they resume on the next message. Output is appended to gw.log.
#
# Environment:
#   PORT         port to health-check after starting (default: the running gateway's, else 8787)
#   LOG          log file (default: gw.log in this folder)
#   CONTAINER_IMAGE  image name for `image` (default: piper-agent)
#   PI_AGENT_PACKAGE the Pi package directory, when `npm root -g` does not find it
#   STOP_WAIT    seconds to wait for a clean stop before SIGKILL (default: 20)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="${LOG:-$DIR/gw.log}"
STOP_WAIT="${STOP_WAIT:-20}"
NODE="$(command -v node || true)"

die() { echo "piper: $*" >&2; exit 1; }

# When a systemd unit runs this folder's gateway, it is the one way to start and stop it: a second
# copy started here would fight it for the port, and systemd would restart whatever was stopped.
UNIT="${PIPER_UNIT:-piper}"
systemd_owns() {
	command -v systemctl > /dev/null 2>&1 || return 1
	[ "$(systemctl show -p WorkingDirectory --value "$UNIT" 2>/dev/null)" = "$DIR" ] || return 1
	systemctl is-enabled --quiet "$UNIT" 2>/dev/null
}

# Wait until the gateway answers, wherever it listens.
wait_healthy() {
	local i pid port
	for i in $(seq 1 30); do
		pid="$(gateway_pids | head -1)"
		port="${PORT:-$( [ -n "$pid" ] && listen_port "$pid" )}"
		if [ -n "$port" ] && curl -fsS "http://127.0.0.1:$port/health" > /dev/null 2>&1; then
			echo "piper: running, pid $pid, port $port"
			return 0
		fi
		sleep 1
	done
	echo "piper: not answering after 30s; see: journalctl -u $UNIT -n 50" >&2
	return 1
}

# PIDs of `node server.mjs` processes whose working directory is $DIR and that use this folder's own
# database. A gateway is its database: a test copy started from here with GATEWAY_DB elsewhere is
# a different gateway, and is left alone.
gateway_pids() {
	local proc pid db
	for proc in /proc/[0-9]*; do
		pid="${proc#/proc/}"
		[ "$(readlink "$proc/cwd" 2>/dev/null)" = "$DIR" ] || continue
		tr '\0' ' ' < "$proc/cmdline" 2>/dev/null | grep -qE '(^|/)node( [^ ]+)* server\.mjs( |$)' || continue
		db="$(tr '\0' '\n' < "$proc/environ" 2>/dev/null | sed -n 's/^GATEWAY_DB=//p' | head -1)"
		[ -z "$db" ] || [ "$db" = "$DIR/gateway.db" ] || continue
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
	if systemd_owns; then
		echo "piper: stopping the systemd unit $UNIT (open chats' containers are stopped and resume later)"
		systemctl stop "$UNIT" || die "systemctl stop $UNIT failed (are you root?)"
		echo "piper: stopped"
		return 0
	fi
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
	if systemd_owns; then
		systemctl start "$UNIT" || die "systemctl start $UNIT failed (are you root?)"
		wait_healthy
		return
	fi
	[ -n "$NODE" ] || die "node is not on PATH"
	[ -f "$DIR/server.mjs" ] || die "no server.mjs in $DIR"
	if [ -n "$(gateway_pids)" ]; then
		echo "piper: already running"
		status
		return 0
	fi
	cd "$DIR"
	# Where this start's output begins, so only its own lines are shown.
	local from
	from="$(stat -c %s "$LOG" 2>/dev/null || echo 0)"
	setsid nohup "$NODE" server.mjs >> "$LOG" 2>&1 < /dev/null &
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

# The Pi version this host runs, which the image has to match.
host_pi_version() {
	local dir="${PI_AGENT_PACKAGE:-$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent}"
	[ -f "$dir/package.json" ] || die "cannot find the Pi package (looked in $dir); set PI_AGENT_PACKAGE"
	"$NODE" -p "require('$dir/package.json').version"
}

image() {
	command -v docker > /dev/null || die "docker is not installed"
	local env=full name dockerfile context version
	# The first word is an environment unless it is an option for docker build.
	if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then env="$1"; shift; fi
	if [ "$env" = full ]; then
		name="${CONTAINER_IMAGE:-piper-agent}"; dockerfile="$DIR/docker/Dockerfile"; context="$DIR/docker"
	else
		[[ "$env" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "\"$env\" is not an environment name"
		name="piper-agent-$env"; dockerfile="$DIR/docker/environments/$env/Dockerfile"; context="$DIR/docker/environments/$env"
		[ -f "$dockerfile" ] || die "no environment $env: there is no $dockerfile (environments: full $(ls "$DIR/docker/environments" 2>/dev/null | tr '\n' ' '))"
	fi
	version="$(host_pi_version)"
	echo "piper: building $name ($env) with Pi $version"
	docker build -t "$name" -f "$dockerfile" --build-arg "PI_VERSION=$version" --label "piper.env=$env" "$@" "$context"
	echo "piper: built $name (running chats keep their container until it is next recreated; the Containers page shows which are behind)"
}

doctor() {
	local ok=0 name="${CONTAINER_IMAGE:-piper-agent}" version
	if ! command -v docker > /dev/null; then echo "docker:   NOT INSTALLED"; return 1; fi
	if version="$(docker version --format '{{.Server.Version}}' 2>&1)"; then echo "docker:   $version"; else echo "docker:   not answering: $version"; return 1; fi
	local built pi
	if built="$(docker image inspect --format '{{index .Config.Labels "piper.pi-version"}}' "$name" 2>/dev/null)"; then
		pi="$(host_pi_version 2>/dev/null || echo '?')"
		if [ "$built" = "$pi" ]; then echo "image:    $name, Pi $built (matches this host)"; else echo "image:    $name has Pi $built but this host runs Pi $pi: run ./piper.sh image"; ok=1; fi
	else
		echo "image:    $name is NOT BUILT: run ./piper.sh image"; ok=1
	fi
	local pids port
	pids="$(gateway_pids)"
	if [ -z "$pids" ]; then echo "gateway:  not running (start it to check the network policy)"; return "$ok"; fi
	port="${PORT:-$(listen_port "$(echo "$pids" | head -1)")}"
	echo "gateway:  running on port $port; asking it about the network policy"
	# The dashboard may have a password: then the question needs a session. Sign in when the password is given in
	# DASHBOARD_PASSWORD; otherwise say so, rather than choking on the refusal.
	local base="http://127.0.0.1:$port" tmp code
	tmp="$(mktemp -d)"
	code="$(curl -sS -o "$tmp/body" -w '%{http_code}' -X POST "$base/dashboard/containers/recheck" 2>"$tmp/err" || true)"
	if [ "$code" = "401" ] && [ -n "${DASHBOARD_PASSWORD:-}" ]; then
		"$NODE" -e 'process.stdout.write(JSON.stringify({password:process.env.DASHBOARD_PASSWORD}))' \
			| curl -sS -o /dev/null -c "$tmp/jar" -X POST -H 'Content-Type: application/json' --data-binary @- "$base/dashboard/login" 2>/dev/null || true
		code="$(curl -sS -o "$tmp/body" -w '%{http_code}' -b "$tmp/jar" -X POST "$base/dashboard/containers/recheck" 2>"$tmp/err" || true)"
	fi
	if [ "$code" = "401" ]; then
		echo "network:  not checked: the dashboard is locked by its password. Run it as  DASHBOARD_PASSWORD=... ./piper.sh doctor  or read the red strip and the Containers page on the dashboard"
	elif [ "$code" != "200" ]; then
		echo "network:  the gateway did not answer the question (HTTP ${code:-none}$(head -c 200 "$tmp/err" 2>/dev/null | tr '\n' ' ')): see ./piper.sh logs"
		ok=1
	else
		"$NODE" -e 'let t="";process.stdin.on("data",c=>t+=c).on("end",()=>{let s;try{s=JSON.parse(t)}catch{console.log("network:  the answer was not understood");process.exit(1)}
			console.log("network:  "+s.network.mode+(s.network.ok?"":" (PROBLEM)"));
			console.log("firewall: "+(s.firewall.ok?"in place":"NOT ENFORCED")+(s.firewall.allowed.length?"; containers may also reach "+s.firewall.allowed.map(a=>a.endpoint+" ("+a.why+")").join(", "):""));
			for(const p of s.problems) console.log("PROBLEM:  "+p);
			for(const w of s.warnings) console.log("warning:  "+w);
			process.exit(s.ok?0:1)})' < "$tmp/body" || ok=1
	fi
	rm -rf "$tmp"
	return "$ok"
}

case "${1:-restart}" in
	restart) stop && start ;;
	start) start ;;
	stop) stop ;;
	status) status ;;
	logs) if systemd_owns; then journalctl -u "$UNIT" -n "${LINES:-50}" -f; else tail -n "${LINES:-50}" -f "$LOG"; fi ;;
	backup) shift; [ -n "$NODE" ] || die "node is not on PATH"; exec "$NODE" --disable-warning=ExperimentalWarning "$DIR/piper-backup.mjs" backup "$@" ;;
	restore) shift; [ -n "$NODE" ] || die "node is not on PATH"; exec "$NODE" --disable-warning=ExperimentalWarning "$DIR/piper-backup.mjs" restore "$@" ;;
	image) shift; image "$@" ;;
	doctor) doctor ;;
	-h|--help|help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//' ;;
	*) die "unknown command: $1 (use restart, start, stop, status, logs, image, doctor, backup or restore)" ;;
esac
