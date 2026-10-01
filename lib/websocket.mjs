/**
 * A minimal WebSocket server (RFC 6455) for the dashboard's terminal, with no dependencies.
 *
 * It does what that needs and refuses the rest: the handshake, text and binary messages, fragmentation,
 * ping and pong, and the close handshake. Client frames must be masked, reserved bits must be clear, a
 * message may not exceed `maxMessage`, and text must be valid UTF-8; anything else closes the connection with
 * the code the RFC prescribes. A peer that stops answering pings is closed. No extensions, no subprotocols.
 *
 *   const peer = upgrade(req, socket, head);        // null when the handshake was refused (already answered)
 *   peer.onMessage = (data, isBinary) => …;         // data is a Buffer (binary) or a string (text)
 *   peer.onClose = (code, reason) => …;
 *   peer.send("text") / peer.send(Buffer) / peer.close(1000, "bye")
 */
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** The `Sec-WebSocket-Accept` value for a client's `Sec-WebSocket-Key`. */
export const acceptKey = (key) => crypto.createHash("sha1").update(`${key}${GUID}`).digest("base64");

const OP = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };
const validCloseCode = (c) => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1011) || (c >= 3000 && c <= 4999);

/** Answer a refused handshake and drop the connection. */
function refuse(socket, status, text, headers = {}) {
	const lines = [`HTTP/1.1 ${status} ${text}`, "Connection: close", "Content-Length: 0", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
	try {
		socket.end(`${lines.join("\r\n")}\r\n\r\n`);
	} catch {
		socket.destroy();
	}
}

/** One frame, server side (never masked). */
export function encodeFrame(opcode, payload) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	const n = body.length;
	let header;
	if (n < 126) header = Buffer.from([0x80 | opcode, n]);
	else if (n < 65536) header = Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]);
	else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 127;
		header.writeBigUInt64BE(BigInt(n), 2);
	}
	return Buffer.concat([header, body]);
}

/**
 * Complete the handshake on an `upgrade` event and return the peer, or null (after answering) when the request is
 * not a valid WebSocket handshake. The caller has already decided the request is allowed.
 */
export function upgrade(req, socket, head, { maxMessage = 64 * 1024, pingMs = 25_000, closeWaitMs = 2000 } = {}) {
	const key = String(req.headers["sec-websocket-key"] ?? "");
	if (req.method !== "GET" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || !/\bupgrade\b/i.test(String(req.headers.connection ?? ""))) {
		refuse(socket, 400, "Bad Request");
		return null;
	}
	if (String(req.headers["sec-websocket-version"] ?? "") !== "13") {
		refuse(socket, 426, "Upgrade Required", { "Sec-WebSocket-Version": "13" });
		return null;
	}
	// A key is 16 random bytes, base64.
	if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) {
		refuse(socket, 400, "Bad Request");
		return null;
	}
	socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
	socket.setNoDelay?.(true);
	socket.setTimeout?.(0);

	const decoder = new TextDecoder("utf-8", { fatal: true });
	let buffer = Buffer.alloc(0);
	let fragment = null;
	let closed = false;
	let closeSent = false;
	let alive = true;
	let closeTimer = null;
	const peer = {
		onMessage: () => {},
		onClose: () => {},
		/** Bytes queued to the client and not yet written: a caller can pause its source above some figure. */
		get buffered() {
			return socket.writableLength ?? 0;
		},
		get open() {
			return !closed && !closeSent;
		},
		send(data) {
			if (closed || closeSent) return false;
			const isText = typeof data === "string";
			return socket.write(encodeFrame(isText ? OP.TEXT : OP.BINARY, isText ? Buffer.from(data) : data));
		},
		ping() {
			if (!closed && !closeSent) socket.write(encodeFrame(OP.PING, Buffer.alloc(0)));
		},
		/** Start the close handshake; the socket ends when the client answers, or after a short wait. */
		close(code = 1000, reason = "") {
			if (closed || closeSent) return;
			closeSent = true;
			const text = Buffer.from(String(reason)).subarray(0, 120);
			const payload = Buffer.alloc(2 + text.length);
			payload.writeUInt16BE(code, 0);
			text.copy(payload, 2);
			try {
				socket.write(encodeFrame(OP.CLOSE, payload));
			} catch {
				/* the socket is gone */
			}
			closeTimer = setTimeout(() => socket.destroy(), closeWaitMs);
			closeTimer.unref?.();
		},
	};
	const finish = (code, reason) => {
		if (closed) return;
		closed = true;
		clearInterval(pinger);
		clearTimeout(closeTimer);
		try {
			peer.onClose(code, reason);
		} catch {
			/* a listener's bug must not leave the socket open */
		}
		// End rather than destroy, so a close frame still queued is written; destroy follows if the client lingers.
		try {
			socket.end();
		} catch {
			/* already gone */
		}
		setTimeout(() => socket.destroy(), 200).unref?.();
	};
	const fail = (code, reason) => {
		peer.close(code, reason);
		// A protocol error does not wait for the other side to agree.
		setTimeout(() => finish(code, reason), 50).unref?.();
	};

	const pinger = setInterval(() => {
		if (!alive) return fail(1001, "no answer to ping");
		alive = false;
		peer.ping();
	}, pingMs);
	pinger.unref?.();

	const handleMessage = (opcode, payload) => {
		if (opcode === OP.TEXT) {
			let text;
			try {
				text = decoder.decode(payload);
			} catch {
				return fail(1007, "text is not valid UTF-8");
			}
			peer.onMessage(text, false);
		} else {
			peer.onMessage(payload, true);
		}
	};

	const handleFrame = (fin, opcode, payload) => {
		if (opcode === OP.PING) {
			if (!closeSent) socket.write(encodeFrame(OP.PONG, payload));
			return;
		}
		if (opcode === OP.PONG) {
			alive = true;
			return;
		}
		if (opcode === OP.CLOSE) {
			if (payload.length === 1) return fail(1002, "bad close frame");
			const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
			if (payload.length >= 2 && !validCloseCode(code)) return fail(1002, "bad close code");
			let reason = "";
			try {
				reason = payload.length > 2 ? decoder.decode(payload.subarray(2)) : "";
			} catch {
				return fail(1007, "close reason is not valid UTF-8");
			}
			if (!closeSent) peer.close(payload.length >= 2 ? code : 1000);
			return finish(code, reason);
		}
		if (opcode === OP.CONTINUATION) {
			if (!fragment) return fail(1002, "continuation with nothing to continue");
			fragment.size += payload.length;
			if (fragment.size > maxMessage) return fail(1009, "message too big");
			fragment.chunks.push(payload);
			if (fin) {
				const whole = Buffer.concat(fragment.chunks);
				const first = fragment.opcode;
				fragment = null;
				handleMessage(first, whole);
			}
			return;
		}
		// A new data message.
		if (fragment) return fail(1002, "a new message began before the last one ended");
		if (!fin) {
			fragment = { opcode, chunks: [payload], size: payload.length };
			return;
		}
		handleMessage(opcode, payload);
	};

	const pump = () => {
		while (!closed) {
			if (buffer.length < 2) return;
			const b0 = buffer[0];
			const b1 = buffer[1];
			const fin = Boolean(b0 & 0x80);
			const opcode = b0 & 0x0f;
			if (b0 & 0x70) return fail(1002, "reserved bits set");
			if (![0, 1, 2, 8, 9, 10].includes(opcode)) return fail(1002, "unknown opcode");
			if (!(b1 & 0x80)) return fail(1002, "client frames must be masked");
			let length = b1 & 0x7f;
			let offset = 2;
			if (opcode >= 8 && (length > 125 || !fin)) return fail(1002, "bad control frame");
			if (length === 126) {
				if (buffer.length < 4) return;
				length = buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (buffer.length < 10) return;
				const big = buffer.readBigUInt64BE(2);
				if (big > BigInt(maxMessage)) return fail(1009, "message too big");
				length = Number(big);
				offset = 10;
			}
			if (length > maxMessage) return fail(1009, "message too big");
			if (buffer.length < offset + 4 + length) return;
			const mask = buffer.subarray(offset, offset + 4);
			const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
			for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
			buffer = buffer.subarray(offset + 4 + length);
			handleFrame(fin, opcode, payload);
		}
	};

	socket.on("data", (chunk) => {
		buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
		pump();
	});
	socket.on("error", () => finish(1006, "connection error"));
	socket.on("close", () => finish(1006, "connection closed"));
	socket.on("end", () => finish(1006, "connection ended without a close frame"));
	if (head?.length) {
		buffer = Buffer.from(head);
		pump();
	}
	return peer;
}
