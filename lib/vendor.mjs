/**
 * The few third-party files the dashboard loads (see THIRD_PARTY.md). Which files can be served is this list and
 * nothing else: the name in a request is looked up here, never turned into a path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_DIR } from "./settings.mjs";

export const VENDOR_FILES = {
	"xterm/xterm.js": { type: "text/javascript; charset=utf-8" },
	"xterm/xterm.css": { type: "text/css; charset=utf-8" },
	"xterm/addon-fit.js": { type: "text/javascript; charset=utf-8" },
	"xterm/LICENSE": { type: "text/plain; charset=utf-8" },
};

/** {type, body} for a vendor file by its name, or null for anything not on the list. */
export function vendorFile(name, dir = GATEWAY_DIR) {
	if (!Object.hasOwn(VENDOR_FILES, name)) return null;
	try {
		return { type: VENDOR_FILES[name].type, body: readFileSync(join(dir, "vendor", name)) };
	} catch {
		return null;
	}
}
