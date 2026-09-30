/** A short record of what an operator did to containers, images and keys. Actions only; never a secret. */
import { db } from "./settings.mjs";

const MAX_DETAIL = 200;

/** Record one action. Never throws: a full disk must not stop the action being audited. */
export function audit(action, target, detail = "") {
	try {
		db.prepare("INSERT INTO audit (ts, action, target, detail) VALUES (?, ?, ?, ?)").run(Date.now(), String(action), String(target), String(detail).replace(/\s+/g, " ").slice(0, MAX_DETAIL));
	} catch {
		/* the record is a courtesy */
	}
}

/** The newest records first. */
export function recentAudit(limit = 100) {
	return db.prepare("SELECT ts, action, target, detail FROM audit ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(500, Number(limit) || 100))).map((r) => ({ ...r }));
}
