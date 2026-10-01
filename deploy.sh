#!/usr/bin/env bash
# Deploy Piper on a Linux host that has Docker: check the host, install Node and Pi if they are
# missing, build the chat image, and start the gateway (optionally as a systemd service).
#
#   ./deploy.sh [options]          run it from a checkout of the repository; safe to run again
#
#   --systemd            install and start a systemd service (needs root); otherwise ./piper.sh runs it.
#                        Also installs a watchdog timer that alerts (webhook set on the dashboard) if it stops answering
#   --backups            with --systemd, also install a daily backup timer (keeps the newest 7)
#   --run-as USER        run the service as USER (with --systemd, as root). USER needs Docker access
#   --create-user        create USER (with a home and in the docker group) if it does not exist
#   --host ADDR          address to listen on at FIRST start (default 127.0.0.1). 0.0.0.0 exposes it
#   --port N             port at first start (default 8787)
#   --install-node       install Node.js 22 under ~/.local/node if it is missing or too old
#   --skip-pi            do not install Pi (you will install it yourself). An existing Pi is found on its own:
#                        PI_AGENT_PACKAGE, the gateway setting, the pi command, npm root -g, nvm/fnm/asdf/volta
#   --skip-image         do not build the chat image
#   --rebuild-image      build the image even if it exists and matches
#   --no-start           set everything up but do not start the gateway
#   --dry-run            print what would be done and change nothing
#   --print-unit         print the systemd unit that --systemd would install, and exit
#   -h, --help
#
# Environment: DASHBOARD_PASSWORD  set on first start only (the dashboard asks for it from then on)
#
# Host, port and password only take effect the first time the gateway creates its database;
# after that they are edited on the dashboard.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_VERSION="${NODE_VERSION:-22.19.0}"
NODE_MIN="${NODE_MIN:-22.19}"

SYSTEMD=0 BACKUPS=0 RUN_AS="" CREATE_USER=0 HOST_ADDR="" PORT_NUM="" INSTALL_NODE=0 SKIP_PI=0 SKIP_IMAGE=0
REBUILD=0 NO_START=0 DRY=0 PRINT_UNIT=0

say() { printf '%s\n' "$*"; }
ok() { printf '  [ok]   %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*" >&2; }
step() { printf '\n== %s\n' "$*"; }
die() { printf '  [FAIL] %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = 1 ]; then printf '  (dry run) %s\n' "$*"; else "$@"; fi; }

usage() { sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
	case "$1" in
		--systemd) SYSTEMD=1 ;;
		--backups) BACKUPS=1 ;;
		--run-as) RUN_AS="${2:?--run-as needs a user}"; shift ;;
		--create-user) CREATE_USER=1 ;;
		--host) HOST_ADDR="${2:?--host needs an address}"; shift ;;
		--port) PORT_NUM="${2:?--port needs a number}"; shift ;;
		--install-node) INSTALL_NODE=1 ;;
		--skip-pi) SKIP_PI=1 ;;
		--skip-image) SKIP_IMAGE=1 ;;
		--rebuild-image) REBUILD=1 ;;
		--no-start) NO_START=1 ;;
		--dry-run) DRY=1 ;;
		--print-unit) PRINT_UNIT=1 ;;
		-h|--help) usage; exit 0 ;;
		*) die "unknown option: $1 (see --help)" ;;
	esac
	shift
done

[ -z "$PORT_NUM" ] || [[ "$PORT_NUM" =~ ^[0-9]+$ && "$PORT_NUM" -ge 1 && "$PORT_NUM" -le 65535 ]] || die "--port must be 1-65535"
[ -z "$RUN_AS" ] || [ "$SYSTEMD" = 1 ] || die "--run-as needs --systemd (otherwise the gateway runs as you)"
[ "$BACKUPS" = 0 ] || [ "$SYSTEMD" = 1 ] || die "--backups needs --systemd (it installs a systemd timer)"
[ "$CREATE_USER" = 0 ] || [ -n "$RUN_AS" ] || die "--create-user needs --run-as USER"
[ "$RUN_AS" != root ] || RUN_AS=""

ME="$(id -un)"
TARGET="${RUN_AS:-$ME}"
IS_ROOT=0; [ "$(id -u)" -eq 0 ] && IS_ROOT=1
[ -f "$DIR/server.mjs" ] && [ -d "$DIR/lib" ] && [ -f "$DIR/docker/Dockerfile" ] || die "run this from a checkout of the repository (server.mjs, lib/ and docker/ are next to it)"

# Run a command as the service's user (a no-op switch when that is the current user).
as_target() {
	# A dry run of "create the user" has no such user yet; the checks then run as the current one.
	if [ "$TARGET" = "$ME" ] || { [ "$DRY" = 1 ] && ! id "$TARGET" > /dev/null 2>&1; }; then "$@"; else runuser -u "$TARGET" -- "$@"; fi
}

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# ---------------------------------------------------------------------------------------------
# The systemd unit (printed, or installed)
# ---------------------------------------------------------------------------------------------
unit_text() {
	local node="$1" home="$2" GROUP_LINE="SupplementaryGroups=docker
"
	[ "$TARGET" != root ] || GROUP_LINE=""
	cat <<EOF
[Unit]
Description=Piper - OpenAI-compatible gateway for Pi
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
User=$TARGET
${GROUP_LINE}WorkingDirectory=$DIR
Environment=HOME=$home
# sbin too: on Debian iptables lives in /usr/sbin, and without it the network policy cannot be enforced.
Environment=PATH=$(dirname "$node"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$node server.mjs
Restart=on-failure
# The gateway stops each chat's container on SIGTERM; give it the ten seconds it may take.
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
}

# A daily backup: a oneshot service and the timer that runs it. Persistent, so a missed run (the
# machine was off at 03:30) happens at the next boot.
backup_service_text() {
	local node="$1"
	cat <<EOF
[Unit]
Description=Piper backup

[Service]
Type=oneshot
User=$TARGET
WorkingDirectory=$DIR
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node piper-backup.mjs backup --keep 7
Nice=10
EOF
}
backup_timer_text() {
	cat <<'EOF'
[Unit]
Description=Piper daily backup

[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=10min
Persistent=true

[Install]
WantedBy=timers.target
EOF
}

# The watchdog: a check every minute that the gateway answers, run by a timer. It alerts through the
# webhook set on the dashboard, and does nothing at all when there is none.
watchdog_service_text() {
	local node="$1"
	cat <<EOF
[Unit]
Description=Piper watchdog: is the gateway answering

[Service]
Type=oneshot
User=$TARGET
WorkingDirectory=$DIR
ExecStart=$node --disable-warning=ExperimentalWarning piper-watchdog.mjs
Nice=10
EOF
}
watchdog_timer_text() {
	cat <<'EOF'
[Unit]
Description=Piper watchdog, every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF
}

if [ "$PRINT_UNIT" = 1 ]; then
	NODE_BIN="$(command -v node || echo /usr/bin/node)"
	TARGET_HOME="$(getent passwd "$TARGET" | cut -d: -f6 || true)"
	unit_text "$NODE_BIN" "${TARGET_HOME:-/home/$TARGET}"
	if [ "$SYSTEMD" = 1 ]; then
		printf '\n# ---- piper-watchdog.service\n'; watchdog_service_text "$NODE_BIN"
		printf '\n# ---- piper-watchdog.timer\n'; watchdog_timer_text
	fi
	if [ "$BACKUPS" = 1 ]; then
		printf '\n# ---- piper-backup.service\n'; backup_service_text "$NODE_BIN"
		printf '\n# ---- piper-backup.timer\n'; backup_timer_text
	fi
	exit 0
fi

say "Piper deploy: $DIR"
[ "$DRY" = 0 ] || say "(dry run: nothing will be changed)"

# ---------------------------------------------------------------------------------------------
step "1. The host"
[ "$(uname -s)" = Linux ] || die "this is for Linux hosts"
ok "Linux $(uname -r), $(uname -m)"

command -v docker > /dev/null || die "Docker is not installed. Install Docker Engine 24+ (Debian/Ubuntu: apt-get install docker.io), then run this again."
DOCKER_VER="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
if [ -z "$DOCKER_VER" ]; then
	die "Docker is installed but not answering for $ME. Start it (systemctl start docker) and make sure $ME can use it (root, or the docker group)."
fi
version_ge "${DOCKER_VER%%[-+]*}" 24.0 || warn "Docker $DOCKER_VER is older than 24; it may work, but 24+ is what this was run against"
ok "Docker $DOCKER_VER"

if command -v iptables > /dev/null; then
	ok "iptables $(iptables --version | awk '{print $2}')"
else
	warn "iptables is missing: the default network policy (internet only) cannot be enforced, and chats will refuse to start. Install it (apt-get install iptables), or set CONTAINER_NETWORK to none or open on the dashboard."
fi
if [ "$IS_ROOT" = 0 ] && [ "$TARGET" = "$ME" ]; then
	warn "running as $ME, not root: the gateway needs permission to change firewall rules for the internet-only policy (root or CAP_NET_ADMIN). Without it, chats refuse to start on that policy."
fi

# The image and the chats' containers live in Docker's own data directory, not next to the gateway.
DOCKER_ROOT="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
[ -n "$DOCKER_ROOT" ] && [ -d "$DOCKER_ROOT" ] && [ -r "$DOCKER_ROOT" ] || DOCKER_ROOT="$DIR"
FREE_GB=$(( $(df -Pk "$DOCKER_ROOT" | awk 'NR==2{print $4}') / 1024 / 1024 ))
if [ "$FREE_GB" -lt 8 ]; then warn "only ${FREE_GB} GB free for Docker ($DOCKER_ROOT); the image alone is about 2 GB and each chat's container adds to it"; else ok "${FREE_GB} GB free for Docker ($DOCKER_ROOT)"; fi

PORT_CHECK="${PORT_NUM:-8787}"
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${PORT_CHECK}\$"; then
	if [ -f "$DIR/gateway.db" ]; then warn "port $PORT_CHECK is in use (probably this gateway already; it will be restarted)"; else warn "port $PORT_CHECK is already in use by something else; pass --port"; fi
fi

# ---------------------------------------------------------------------------------------------
step "2. The service user"
if [ -n "$RUN_AS" ]; then
	[ "$IS_ROOT" = 1 ] || die "--run-as needs root (to switch users and write the unit)"
	if id "$RUN_AS" > /dev/null 2>&1; then
		ok "user $RUN_AS exists"
	elif [ "$CREATE_USER" = 1 ]; then
		run useradd --create-home --shell /bin/bash "$RUN_AS"
		ok "created user $RUN_AS"
	else
		die "user $RUN_AS does not exist (add --create-user)"
	fi
	if getent group docker > /dev/null; then
		if id -nG "$RUN_AS" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then ok "$RUN_AS is in the docker group"; else run usermod -aG docker "$RUN_AS"; ok "added $RUN_AS to the docker group (root-equivalent access: see DEPLOYMENT.md for rootless Docker)"; fi
	else
		warn "there is no docker group here; make sure $RUN_AS can reach the Docker socket"
	fi
	run chown -R "$RUN_AS":"$RUN_AS" "$DIR"
	ok "$DIR is owned by $RUN_AS"
else
	ok "the gateway will run as $ME"
	[ "$IS_ROOT" = 0 ] || warn "as root, anything that escapes a container reaches the host as root; --systemd --run-as USER is safer (see DEPLOYMENT.md)"
fi

# ---------------------------------------------------------------------------------------------
step "3. Node.js $NODE_MIN or newer"
TARGET_HOME="$(getent passwd "$TARGET" | cut -d: -f6 || true)"
[ -n "$TARGET_HOME" ] || { [ "$DRY" = 1 ] && TARGET_HOME="/home/$TARGET" || TARGET_HOME="$HOME"; }
find_node() { as_target bash -lc 'command -v node' 2>/dev/null || true; }
NODE_BIN="$(find_node)"
[ -z "$NODE_BIN" ] && [ -x "$TARGET_HOME/.local/node/bin/node" ] && NODE_BIN="$TARGET_HOME/.local/node/bin/node"
have_node_ok() { [ -n "$NODE_BIN" ] && version_ge "$(as_target "$NODE_BIN" -p 'process.versions.node')" "$NODE_MIN"; }
if have_node_ok; then
	ok "node $(as_target "$NODE_BIN" -v) at $NODE_BIN"
elif [ "$INSTALL_NODE" = 1 ]; then
	case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "no Node.js tarball for $(uname -m); install Node $NODE_MIN+ yourself" ;; esac
	TAR="node-v${NODE_VERSION}-linux-${ARCH}.tar.xz"
	say "  installing Node $NODE_VERSION to $TARGET_HOME/.local/node"
	if [ "$DRY" = 1 ]; then
		say "  (dry run) download $TAR, verify its SHA-256, unpack"
	else
		TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
		curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/$TAR" -o "$TMP/$TAR"
		curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o "$TMP/SUMS"
		( cd "$TMP" && grep " $TAR\$" SUMS | sha256sum -c - > /dev/null ) || die "the Node.js download failed its SHA-256 check"
		as_target mkdir -p "$TARGET_HOME/.local/node"
		as_target tar -xJ --strip-components=1 -C "$TARGET_HOME/.local/node" -f "$TMP/$TAR"
		NODE_BIN="$TARGET_HOME/.local/node/bin/node"
		ok "installed node $(as_target "$NODE_BIN" -v)"
	fi
else
	die "Node.js $NODE_MIN or newer was not found for $TARGET. Install it, or run this again with --install-node."
fi
NODE_DIR="$(dirname "${NODE_BIN:-/usr/bin/node}")"
export PATH="$NODE_DIR:$PATH"

# ---------------------------------------------------------------------------------------------
step "4. Pi"
PI_PKG="@earendil-works/pi-coding-agent"
pi_dir() { as_target env PATH="$NODE_DIR:$PATH" bash -c 'echo "$(npm root -g)/'"$PI_PKG"'"' 2>/dev/null || true; }
valid_pi() { [ -f "$1/package.json" ] && [ -f "$1/dist/index.js" ]; }

# A path the gateway already has in its settings (PI_AGENT_PACKAGE on the dashboard), if any.
stored_pi() {
	[ -f "$DIR/gateway.db" ] || return 0
	as_target "$NODE_BIN" --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
try {
	const db = new DatabaseSync(process.argv[1], { readOnly: true });
	const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("PI_AGENT_PACKAGE");
	if (row && row.value) console.log(row.value);
} catch {}' "$DIR/gateway.db" 2>/dev/null || true
}

# Where Pi might be, most specific first: "source<TAB>package directory".
pi_candidates() {
	local bin real dir d
	[ -z "${PI_AGENT_PACKAGE:-}" ] || printf 'PI_AGENT_PACKAGE\t%s\n' "$PI_AGENT_PACKAGE"
	printf 'the gateway setting\t%s\n' "$(stored_pi)"
	# The `pi` command on the target's PATH: follow its link back to the package that owns it.
	bin="$(as_target bash -lc 'command -v pi' 2>/dev/null || true)"
	if [ -n "$bin" ]; then
		real="$(readlink -f "$bin" 2>/dev/null || true)"; dir="$(dirname "$real")"
		while [ -n "$real" ] && [ "$dir" != / ]; do
			if [ -f "$dir/package.json" ] && grep -q "\"name\": *\"$PI_PKG\"" "$dir/package.json" 2>/dev/null; then printf 'the pi command (%s)\t%s\n' "$bin" "$dir"; break; fi
			dir="$(dirname "$dir")"
		done
	fi
	printf 'npm root -g\t%s\n' "$(pi_dir)"
	for d in /usr/lib/node_modules /usr/local/lib/node_modules \
		"$TARGET_HOME"/.local/node/lib/node_modules "$TARGET_HOME"/.npm-global/lib/node_modules \
		"$TARGET_HOME"/.nvm/versions/node/*/lib/node_modules "$TARGET_HOME"/.local/share/fnm/node-versions/*/installation/lib/node_modules \
		"$TARGET_HOME"/.asdf/installs/nodejs/*/lib/node_modules "$TARGET_HOME"/.volta/tools/image/node/*/lib/node_modules; do
		printf 'a common install location\t%s/%s\n' "$d" "$PI_PKG"
	done
}

# Sets PI_DIR and PI_SOURCE to the first candidate that is really Pi (a package with dist/index.js).
PI_DIR="" PI_SOURCE=""
detect_pi() {
	local src dir
	PI_DIR="" PI_SOURCE=""
	while IFS=$'\t' read -r src dir; do
		dir="${dir%/}"
		[ -n "$dir" ] || continue
		if valid_pi "$dir"; then PI_DIR="$dir"; PI_SOURCE="$src"; return 0; fi
	done < <(pi_candidates)
	return 1
}

detect_pi || true
if [ "$SKIP_PI" = 1 ]; then
	warn "skipping Pi: install it with $NODE_DIR/npm install -g --ignore-scripts $PI_PKG"
elif [ -n "$PI_DIR" ]; then
	ok "Pi $(as_target "$NODE_BIN" -p "require('$PI_DIR/package.json').version") at $PI_DIR (found via $PI_SOURCE)"
else
	say "  Pi was not found (looked at PI_AGENT_PACKAGE, the gateway setting, the pi command, npm root -g and the usual Node install folders)"
	say "  installing $PI_PKG with this Node's npm"
	run as_target env PATH="$NODE_DIR:$PATH" npm install -g --ignore-scripts "$PI_PKG"
	if [ "$DRY" = 0 ]; then
		detect_pi || die "Pi did not install where npm root -g says"
		ok "installed Pi $(as_target "$NODE_BIN" -p "require('$PI_DIR/package.json').version") at $PI_DIR"
	fi
fi
# Does the gateway find this Pi by itself (npm root -g on its PATH), or has it to be told where it is?
PI_TELL=0
[ -z "$PI_DIR" ] || [ "$PI_DIR" = "$(pi_dir)" ] || PI_TELL=1
[ "$PI_TELL" = 0 ] || say "  the gateway will be told this path (PI_AGENT_PACKAGE), since npm root -g does not lead to it"
if [ ! -f "$TARGET_HOME/.pi/agent/auth.json" ]; then
	warn "Pi is not logged in for $TARGET yet: run 'pi', type /login, and sign in to your model provider(s). Models you configure for containers on the dashboard work without it."
fi

# ---------------------------------------------------------------------------------------------
step "5. Unit tests"
if [ "$DRY" = 1 ]; then say "  (dry run) node test.mjs"; else
	( cd "$DIR" && as_target env PATH="$NODE_DIR:$PATH" ${PI_DIR:+PI_AGENT_PACKAGE="$PI_DIR"} "$NODE_BIN" test.mjs > /tmp/piper-deploy-test.log 2>&1 ) && ok "node test.mjs passed" || { tail -15 /tmp/piper-deploy-test.log >&2; die "the unit tests failed on this host (log: /tmp/piper-deploy-test.log)"; }
fi

# ---------------------------------------------------------------------------------------------
step "6. The chat image"
IMAGE="${CONTAINER_IMAGE:-piper-agent}"
PI_NOW=""
[ -n "$PI_DIR" ] && [ -f "$PI_DIR/package.json" ] && PI_NOW="$(as_target "$NODE_BIN" -p "require('$PI_DIR/package.json').version")"
BUILT="$(docker image inspect --format '{{index .Config.Labels "piper.pi-version"}}' "$IMAGE" 2>/dev/null || true)"
if [ "$SKIP_IMAGE" = 1 ]; then
	warn "skipping the image build: build it with ./piper.sh image before the first chat"
elif [ -n "$BUILT" ] && [ "$BUILT" = "$PI_NOW" ] && [ "$REBUILD" = 0 ]; then
	ok "$IMAGE already built with Pi $BUILT (use --rebuild-image to build again)"
else
	[ -n "$PI_NOW" ] || [ "$DRY" = 1 ] || die "cannot tell which Pi version to build the image for; install Pi first"
	say "  building $IMAGE for Pi ${PI_NOW:-?} (a few minutes the first time)"
	run env PI_AGENT_PACKAGE="$PI_DIR" PATH="$NODE_DIR:$PATH" "$DIR/piper.sh" image
fi

# ---------------------------------------------------------------------------------------------
step "7. First start settings"
FIRST=0; [ -f "$DIR/gateway.db" ] || FIRST=1
if [ "$FIRST" = 1 ]; then
	SEED=()
	[ -z "$HOST_ADDR" ] || SEED+=("HOST=$HOST_ADDR")
	[ -z "$PORT_NUM" ] || SEED+=("PORT=$PORT_NUM")
	[ -z "${DASHBOARD_PASSWORD:-}" ] || SEED+=("DASHBOARD_PASSWORD=$DASHBOARD_PASSWORD")
	[ "$PI_TELL" = 0 ] || SEED+=("PI_AGENT_PACKAGE=$PI_DIR")
	ok "no database yet: this is a first start (${#SEED[@]} setting(s) to seed)"
	if [ "${HOST_ADDR:-127.0.0.1}" != 127.0.0.1 ] && [ -z "${DASHBOARD_PASSWORD:-}" ]; then
		warn "listening on ${HOST_ADDR} with no dashboard password: anyone who can reach the port can open the dashboard. Set DASHBOARD_PASSWORD, or put a password on it at Settings → Access straight away."
	fi
else
	SEED=()
	ok "gateway.db exists: settings are kept, and --host, --port and DASHBOARD_PASSWORD are not applied (edit them on the dashboard)"
	{ [ -z "$HOST_ADDR" ] && [ -z "$PORT_NUM" ] && [ -z "${DASHBOARD_PASSWORD:-}" ]; } || warn "ignored --host/--port/DASHBOARD_PASSWORD: the database already holds those settings"
	# Pi is the exception: the gateway has to find it, so a detected path is stored when the setting is empty or wrong.
	if [ "$PI_TELL" = 1 ] && [ "$(stored_pi)" != "$PI_DIR" ]; then
		if [ "$DRY" = 1 ]; then say "  (dry run) store PI_AGENT_PACKAGE=$PI_DIR in gateway.db"; else
			as_target "$NODE_BIN" --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
const [dir, now] = [process.argv[2], Date.now()];
const done = db.prepare("UPDATE settings SET value = ?, source = ?, updated_at = ? WHERE key = ?").run(dir, "deploy", now, "PI_AGENT_PACKAGE");
if (!done.changes) db.prepare("INSERT INTO settings (key, value, source, updated_at) VALUES (?, ?, ?, ?)").run("PI_AGENT_PACKAGE", dir, "deploy", now);' "$DIR/gateway.db" "$PI_DIR" && ok "stored the Pi path in the gateway settings (PI_AGENT_PACKAGE)"
		fi
	fi
fi

# ---------------------------------------------------------------------------------------------
step "8. Start"
PORT_USED="${PORT_NUM:-8787}"
if [ "$NO_START" = 1 ]; then
	say "  --no-start: leaving it stopped. Start it with $( [ "$SYSTEMD" = 1 ] && echo "systemctl start piper" || echo "./piper.sh start" )"
elif [ "$SYSTEMD" = 1 ]; then
	[ "$IS_ROOT" = 1 ] || die "--systemd needs root to write /etc/systemd/system/piper.service"
	command -v systemctl > /dev/null || die "systemd is not available here; run without --systemd"
	# The password and listen address are seeded by a first run of the gateway itself. Putting the
	# password in the unit would reset it on every start.
	if [ "$FIRST" = 1 ] && [ "${#SEED[@]}" -gt 0 ]; then
		say "  seeding the first-start settings with a short first run"
		if [ "$DRY" = 1 ]; then say "  (dry run) start once with ${SEED[*]//DASHBOARD_PASSWORD=*/DASHBOARD_PASSWORD=***}, then stop"; else
			as_target env PATH="$NODE_DIR:$PATH" "${SEED[@]}" PORT="$PORT_USED" "$DIR/piper.sh" start > /dev/null
			as_target "$DIR/piper.sh" stop > /dev/null
		fi
	fi
	if [ "$DRY" = 1 ]; then
		say "  (dry run) stop a gateway started by piper.sh, if one is running"
		say "  (dry run) write /etc/systemd/system/piper.service, enable and start it"; unit_text "$NODE_BIN" "$TARGET_HOME" | sed 's/^/      /'
		say "  (dry run) write piper-watchdog.service and piper-watchdog.timer (every minute), enable the timer"
		[ "$BACKUPS" = 0 ] || say "  (dry run) write piper-backup.service and piper-backup.timer (daily 03:30, keep 7), enable the timer"
	else
		# A gateway started by hand holds the port and would fight the service for it.
		if "$DIR/piper.sh" status > /dev/null 2>&1; then say "  stopping the running gateway so the service can take over"; "$DIR/piper.sh" stop > /dev/null; fi
		unit_text "$NODE_BIN" "$TARGET_HOME" > /etc/systemd/system/piper.service
		watchdog_service_text "$NODE_BIN" > /etc/systemd/system/piper-watchdog.service
		watchdog_timer_text > /etc/systemd/system/piper-watchdog.timer
		if [ "$BACKUPS" = 1 ]; then
			backup_service_text "$NODE_BIN" > /etc/systemd/system/piper-backup.service
			backup_timer_text > /etc/systemd/system/piper-backup.timer
		fi
		systemctl daemon-reload
		systemctl enable --now piper
		ok "systemd service piper enabled and started (journalctl -u piper -f)"
		systemctl enable --now piper-watchdog.timer
		ok "watchdog timer enabled: set an alert webhook on the dashboard (Settings → Containers) for it to tell you when the gateway stops answering"
		if [ "$BACKUPS" = 1 ]; then systemctl enable --now piper-backup.timer; ok "daily backup timer enabled (./piper.sh backup runs one now; backups are in $DIR/backups)"; fi
	fi
else
	if [ "$DRY" = 1 ]; then say "  (dry run) ./piper.sh restart with ${SEED[*]//DASHBOARD_PASSWORD=*/DASHBOARD_PASSWORD=***}"; else
		PORT="$PORT_USED" as_target env PATH="$NODE_DIR:$PATH" ${SEED[@]+"${SEED[@]}"} PORT="$PORT_USED" "$DIR/piper.sh" restart
	fi
fi

# ---------------------------------------------------------------------------------------------
step "9. Check"
if [ "$NO_START" = 1 ] || [ "$DRY" = 1 ]; then
	say "  skipped (the gateway is not started)"
else
	for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT_USED/health" > /dev/null 2>&1 && break; sleep 1; done
	curl -fsS "http://127.0.0.1:$PORT_USED/health" > /dev/null 2>&1 || die "the gateway is not answering on port $PORT_USED (see gw.log, or journalctl -u piper)"
	ok "gateway answering on port $PORT_USED"
	PORT="$PORT_USED" "$DIR/piper.sh" doctor || warn "doctor found problems (above)"
fi

cat <<EOF

Next steps
  1. Open http://127.0.0.1:${PORT_USED}/dashboard  ($( [ -n "${HOST_ADDR:-}" ] && [ "$HOST_ADDR" != 127.0.0.1 ] && echo "listening on $HOST_ADDR" || echo "on this machine only; put a TLS reverse proxy in front to reach it elsewhere" )).
  2. Set a dashboard password (Settings → Access) if you have not, and create an API key (API keys page).
  3. Models: run 'pi' as $TARGET and /login for cloud models, and/or add the models your containers
     should call directly under Settings → Containers → Pi config for containers.
  4. Check a container from the outside: DEPLOYMENT.md, section 9.
  Stop, restart, logs, rebuild the image: ./piper.sh [stop|restart|logs|image|doctor]
EOF
