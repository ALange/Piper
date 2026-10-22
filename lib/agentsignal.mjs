/**
 * Agent-linked Signal numbers: the server side of the bridge's piper_signal_* tools.
 *
 * An agent talks to the gateway over its chat's own bridge socket (lib/runner.mjs), which is bound to
 * that chat's record, so the caller's key and agent come from the record and never from the request.
 * With Signal switched on globally (SIGNAL_ENABLED) and for the caller -- an agent's own can_signal
 * switch, or, for a chat running as a plain key with no agent endpoint, that key's own can_signal
 * switch -- the tools the bridge registers can link, list and unlink phone numbers for the caller's
 * own key and scope.
 *
 * Linking a number sends it an actual Signal message from Piper's own account (lib/signal.mjs),
 * immediately -- there is no reply-to-confirm step. That is deliberate (trust-on-enable, agreed with
 * the operator); what bounds it is a per-scope cap on how many numbers one agent/key may link
 * (SIGNAL_MAX_CONTACTS_PER_SCOPE) and a gateway-wide daily cap on how many numbers get linked at all
 * (SIGNAL_MAX_NEW_CONTACTS_PER_DAY), plus the dashboard's own contacts list, where any number can be
 * revoked on the spot. A number already linked to a *different* scope can never be taken over by this
 * one -- only the scope that linked it (or the operator, from the dashboard) can unlink it.
 */
import { config } from "./settings.mjs";
import { agents } from "./agents.mjs";
import { apiKeys } from "./auth.mjs";
import { audit } from "./audit.mjs";
import { contactsOf, getContactByNumber, linkContact, newContactsToday, normalizePhoneNumber, sendSignalMessage, setContactEnabled } from "./signal.mjs";

/** Whether this chat may link Signal numbers at all, now -- an agent via its own switch, or a plain key via its own. */
export function maySignal(record) {
	if (!config.SIGNAL_ENABLED) return false;
	if (record?.agentId) return Boolean(agents.get(record.agentId)?.canSignal);
	return Boolean(record?.keyId && apiKeys.get(record.keyId)?.canSignal);
}

function requireSignal(record) {
	if (!maySignal(record)) throw new Error(record?.agentId ? "this agent may not link Signal numbers" : "this key may not link Signal numbers");
}

const sameScope = (contact, record) => contact.keyId === record.keyId && (contact.agentId ?? null) === (record.agentId ?? null);

function callerName(record) {
	if (record?.agentId) return agents.get(record.agentId)?.name ?? "an agent on Piper";
	return apiKeys.get(record?.keyId)?.name ?? "Piper";
}

/**
 * What the bridge hands to a chat's socket: `{enable, list, disable}`. Bound to `record`, so a tool
 * call can only ever see or touch numbers linked to its own key and scope. Errors carry a message for
 * the calling agent to read.
 */
export function signalFor(record) {
	requireSignal(record);
	const mine = (id) => {
		const found = contactsOf(record).find((c) => c.id === String(id ?? ""));
		if (!found) throw new Error("there is no such linked number of yours; list them first");
		return found;
	};
	return {
		async enable({ phoneNumber, message } = {}) {
			requireSignal(record);
			const number = normalizePhoneNumber(phoneNumber);
			if (!number) throw new Error("that does not look like a phone number; use the full +<country code><number> form");
			const existing = getContactByNumber(number);
			if (existing && !sameScope(existing, record)) throw new Error("that number is already linked elsewhere; ask its operator to unlink it first");
			if (existing?.enabled) return existing; // already linked here -- no-op, no second welcome message
			if (!existing) {
				const scopeCap = Number(config.SIGNAL_MAX_CONTACTS_PER_SCOPE ?? 5);
				if (contactsOf(record).length >= scopeCap) throw new Error(`${record.agentId ? "this agent" : "this key"} already has ${scopeCap} linked numbers, the most it may have; unlink one first`);
				const dailyCap = Number(config.SIGNAL_MAX_NEW_CONTACTS_PER_DAY ?? 20);
				if (newContactsToday() >= dailyCap) throw new Error(`${dailyCap} new numbers have already been linked gateway-wide in the last 24 hours, the most allowed; try again later`);
			}
			const contact = linkContact({ keyId: record.keyId, agentId: record.agentId ?? null, phoneNumber: number });
			const welcome = String(message ?? "").trim() || `Hi, this is ${callerName(record)} on Piper. You can message me here from now on.`;
			await sendSignalMessage(number, welcome);
			audit("signal.contact.enable", number, `linked to ${record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`}`);
			return contact;
		},
		list() {
			requireSignal(record);
			return contactsOf(record);
		},
		disable({ id, phoneNumber } = {}) {
			requireSignal(record);
			const contact = id ? mine(id) : contactsOf(record).find((c) => c.phoneNumber === normalizePhoneNumber(phoneNumber));
			if (!contact) throw new Error("there is no such linked number of yours; list them first");
			setContactEnabled(contact.id, false);
			audit("signal.contact.disable", contact.phoneNumber, record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`);
			return true;
		},
	};
}
