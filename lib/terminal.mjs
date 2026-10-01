/**
 * The dashboard's interactive terminal: a shell in a running container, over a WebSocket.
 *
 * `docker exec -i` has no pty and a native pty module is not available, so the shell runs under a small Python
 * helper that is passed on the command line (nothing has to be in the image beyond python3, which every Piper
 * image has). The helper opens a pty, runs `bash -l`, and speaks a tiny framing on its stdin:
 *
 *   D<length>\n<bytes>        keystrokes
 *   R<columns>x<rows>\n       the window was resized
 *
 * Output is the pty's raw bytes on stdout. Control messages from the helper go on stderr: `X<code>` when the shell
 * has exited. When stdin ends the helper hangs up the shell and exits, so closing the connection, or the gateway
 * dying, never leaves a shell behind.
 *
 * It is a root shell in a container, so everything around it is strict: dashboard password required, same origin,
 * the container must be this gateway's and running, a limit on how many at once, an idle timeout, and an audit row
 * when one opens and when it closes. What is typed and what is printed is never recorded.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { config } from "./settings.mjs";
import { ENGINE_BIN, chatKeyOfContainer, inspectMany, runDocker } from "./engine.mjs";
import { audit, currentActor } from "./audit.mjs";

export const TERMINAL_HELPER = String.raw`
import os, pty, sys, select, fcntl, termios, struct, signal, time, errno

def size(spec):
    try:
        c, r = spec.lower().split("x")
        return max(10, min(500, int(c))), max(2, min(200, int(r)))
    except Exception:
        return 80, 24

def resize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def session_members(sid):
    # Everything still in the shell's session: jobs it started that outlived it.
    found = []
    try:
        names = os.listdir("/proc")
    except OSError:
        return found
    for name in names:
        if not name.isdigit():
            continue
        try:
            with open("/proc/%s/stat" % name) as f:
                data = f.read()
            fields = data[data.rindex(")") + 2:].split()
            if int(fields[3]) == sid:
                found.append(int(name))
        except Exception:
            pass
    return found

def hang_up(sid):
    for sig, wait in ((signal.SIGHUP, 0.3), (signal.SIGKILL, 0.0)):
        for p in session_members(sid):
            if p != os.getpid():
                try:
                    os.kill(p, sig)
                except OSError:
                    pass
        time.sleep(wait)

def main():
    cols, rows = size(os.environ.get("PIPER_TERM_SIZE", "80x24"))
    shell = "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
    pid, fd = pty.fork()
    if pid == 0:
        for k in ("PIPER_TERM_ID", "PIPER_TERM_SIZE"):
            os.environ.pop(k, None)
        os.execvp(shell, [shell, "-l"] if shell.endswith("bash") else [shell])
    resize(fd, cols, rows)
    buf = b""
    stdin_open = True
    deadline = None
    status = None

    def drain():
        # Whatever the shell printed on its way out.
        while True:
            try:
                ready, _, _ = select.select([fd], [], [], 0.05)
                if not ready:
                    return
                out = os.read(fd, 65536)
            except OSError:
                return
            if not out:
                return
            while out:
                try:
                    w = os.write(1, out)
                except OSError:
                    return
                out = out[w:]

    while True:
        wait = [fd] + ([0] if stdin_open else [])
        try:
            ready, _, _ = select.select(wait, [], [], 0.5)
        except InterruptedError:
            continue
        if 0 in ready:
            try:
                data = os.read(0, 65536)
            except OSError:
                data = b""
            if not data:
                stdin_open = False
                deadline = time.time() + 1.5
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
            else:
                buf += data
                while buf:
                    kind = buf[:1]
                    nl = buf.find(b"\n")
                    if nl < 0:
                        break
                    head = buf[1:nl]
                    if kind == b"D":
                        try:
                            n = int(head)
                        except ValueError:
                            buf = buf[nl + 1:]
                            continue
                        if len(buf) < nl + 1 + n:
                            break
                        payload = buf[nl + 1:nl + 1 + n]
                        buf = buf[nl + 1 + n:]
                        while payload:
                            try:
                                w = os.write(fd, payload)
                            except OSError:
                                break
                            payload = payload[w:]
                    elif kind == b"R":
                        c, r = size(head.decode("ascii", "ignore"))
                        try:
                            resize(fd, c, r)
                        except OSError:
                            pass
                        buf = buf[nl + 1:]
                    else:
                        buf = buf[1:]
        if fd in ready:
            try:
                out = os.read(fd, 65536)
            except OSError:
                out = b""
            while out:
                try:
                    w = os.write(1, out)
                except OSError:
                    out = b""
                    break
                out = out[w:]
        try:
            reaped, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            reaped, st = pid, 0
        if reaped == pid:
            status = st
            break
        if deadline is not None and time.time() > deadline:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
    drain()
    hang_up(pid)
    code = 0
    if status is not None:
        code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)
    sys.stderr.write("X%d\n" % code)
    sys.stderr.flush()
    sys.exit(0)

main()
`;

const open = new Set();

/** How many terminals are open now. */
export const terminalCount = () => open.size;

/** Close every open terminal (gateway shutdown, tests). */
export function closeAllTerminals(reason = "the gateway is stopping") {
	for (const t of [...open]) t.end(1001, reason);
}

/**
 * May a terminal open on this container? {ok: true} or {ok: false, status, message}. The wording of the refusals
 * follows the command box's.
 */
export async function terminalGate(name) {
	if (!config.TERMINAL_ENABLED) return { ok: false, status: 403, message: "Terminals are switched off (Settings → Containers → Terminal)." };
	if (chatKeyOfContainer(name) === null) return { ok: false, status: 404, message: `${name} is not one of this gateway's containers` };
	const details = (await inspectMany([name])).get(name);
	if (!details) return { ok: false, status: 404, message: `no container ${name}` };
	if (!details.State?.Running) return { ok: false, status: 409, message: "the container is not running: a chat's container runs while the chat is; send the chat a message first" };
	if (open.size >= Number(config.TERMINAL_MAX_SESSIONS ?? 4)) return { ok: false, status: 429, message: `${open.size} terminals are open already (the limit is ${config.TERMINAL_MAX_SESSIONS})` };
	return { ok: true, details };
}

const clampSize = (cols, rows) => [Math.max(10, Math.min(500, Math.round(Number(cols)) || 80)), Math.max(2, Math.min(200, Math.round(Number(rows)) || 24))];

/**
 * Connect a WebSocket peer to a shell in `name`. Browser to gateway: a binary message is keystrokes, a text message
 * is JSON control (`{"t":"resize","cols":…,"rows":…}`). Gateway to browser: binary is the shell's output, text is
 * JSON (`{"t":"exit","code":…}`, `{"t":"error","message":…}`, `{"t":"idle"}`). Returns the handle.
 * `spawnFn` and `label` are parameters for the tests and the audit text.
 */
export function attachTerminal(peer, name, { cols = 80, rows = 24, label = name, spawnFn = spawn } = {}) {
	const id = crypto.randomBytes(4).toString("hex");
	const marker = `piper-term-${id}`;
	const [c, r] = clampSize(cols, rows);
	const args = ["exec", "-i", "-w", "/workspace", "-e", "TERM=xterm-256color", "-e", "HOME=/root", "-e", `PIPER_TERM_SIZE=${c}x${r}`, name, "python3", "-u", "-c", TERMINAL_HELPER, marker];
	const child = spawnFn(ENGINE_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
	const started = Date.now();
	// Who opened it, kept now: the close happens in a socket event, where the request's context is gone.
	const who = currentActor();
	let bytesIn = 0;
	let bytesOut = 0;
	let exited = null;
	let reason = null;
	let finished = false;
	let stderr = "";
	let idleTimer = null;

	const control = (message) => {
		if (peer.open) peer.send(JSON.stringify(message));
	};
	const finish = (why) => {
		if (finished) return;
		finished = true;
		reason = why;
		clearTimeout(idleTimer);
		open.delete(handle);
		try {
			child.stdin.end();
		} catch {
			/* already closed */
		}
		// Closing stdin hangs the shell up. If it is somehow still there, hang it up by name.
		const sweep = setTimeout(() => void runDocker(["exec", name, "pkill", "-HUP", "-f", "--", marker], { timeoutMs: 8000 }).catch(() => {}), 2000);
		sweep.unref?.();
		const kill = setTimeout(() => child.kill?.("SIGKILL"), 6000);
		kill.unref?.();
		child.on?.("close", () => {
			clearTimeout(sweep);
			clearTimeout(kill);
		});
		audit("terminal.close", label, `${why}; ${Math.round((Date.now() - started) / 1000)} s, ${bytesIn} bytes typed, ${bytesOut} bytes shown`, who ? { actor: who.actor, ip: who.ip } : {});
		if (peer.open) peer.close(1000, why);
	};
	const handle = {
		id,
		name,
		end(code, why) {
			if (peer.open) peer.close(code, why);
			finish(why);
		},
	};

	const armIdle = () => {
		clearTimeout(idleTimer);
		const ms = Number(config.TERMINAL_IDLE_MS ?? 0);
		if (ms > 0) {
			idleTimer = setTimeout(() => {
				control({ t: "idle" });
				finish("closed after being idle");
			}, ms);
			idleTimer.unref?.();
		}
	};
	armIdle();

	peer.onMessage = (data, isBinary) => {
		if (finished) return;
		if (isBinary) {
			bytesIn += data.length;
			armIdle();
			child.stdin.write(Buffer.concat([Buffer.from(`D${data.length}\n`), data]));
			return;
		}
		let message;
		try {
			message = JSON.parse(data);
		} catch {
			return;
		}
		if (message?.t === "resize") {
			const [cc, rr] = clampSize(message.cols, message.rows);
			child.stdin.write(`R${cc}x${rr}\n`);
		}
	};
	peer.onClose = () => finish(exited !== null ? `the shell exited (code ${exited})` : "closed by the browser");

	child.stdout.on("data", (chunk) => {
		bytesOut += chunk.length;
		if (!peer.open) return;
		peer.send(chunk);
		// Do not let a slow browser make the gateway hold megabytes of output.
		if (peer.buffered > 4 * 1024 * 1024) {
			child.stdout.pause();
			const resume = () => (peer.buffered > 1024 * 1024 ? setTimeout(resume, 100) : child.stdout.resume());
			setTimeout(resume, 100);
		}
	});
	child.stderr.setEncoding?.("utf8");
	child.stderr.on("data", (text) => {
		stderr = (stderr + text).slice(-1000);
		const m = /X(\d+)\s*$/m.exec(stderr);
		if (m && exited === null) {
			exited = Number(m[1]);
			control({ t: "exit", code: exited });
		}
	});
	child.on("error", (err) => {
		control({ t: "error", message: `could not run docker: ${err.message}` });
		finish("docker could not be run");
	});
	child.on("close", (code) => {
		if (finished) return;
		if (exited === null) {
			const detail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300);
			control({ t: "error", message: code === 127 || /not found|no such|executable file/i.test(stderr) ? `the shell could not start: ${detail || "python3 is not in this container"}` : `the container stopped or the shell ended (${detail || `exit ${code}`})` });
		}
		finish(exited !== null ? `the shell exited (code ${exited})` : "the container stopped or the shell could not run");
	});

	open.add(handle);
	audit("terminal.open", label, `a root shell in ${name}`);
	return handle;
}
