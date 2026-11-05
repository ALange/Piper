/**
 * Agent-linked Signal numbers: the server side of the bridge's piper_signal_* tools.
 *
 * An agent talks to the gateway over its chat's own bridge socket (lib/runner.mjs), which is bound to
 * that chat's record, so the caller's key and agent come from the record and never from the request.
 * With Signal switched on globally (SIGNAL_ENABLED) and for the caller -- an agent's own can_signal
 * switch, or, for a chat running as a plain key with no agent endpoint, that key's own can_signal
 * switch -- the tools the bridge registers can link, list and unlink phone numbers for the caller's
 * own key and scope, send a plain message or a file from its own workspace to one of them, and end
 * its own Signal session on request (its "+ New chat", since a Signal conversation otherwise never
 * gets one on its own -- see lib/signal.mjs for the automatic version of the same thing, by age).
 *
 * Linking a number sends it an actual Signal message from Piper's own account (lib/signal.mjs),
 * immediately -- there is no reply-to-confirm step. That is deliberate (trust-on-enable, agreed with
 * the operator); what bounds it is a per-scope cap on how many numbers one agent/key may link
 * (SIGNAL_MAX_CONTACTS_PER_SCOPE) and a gateway-wide daily cap on how many numbers get linked at all
 * (SIGNAL_MAX_NEW_CONTACTS_PER_DAY), plus the dashboard's own contacts list, where any number can be
 * revoked on the spot. A number already linked to a *different* scope can never be taken over by this
 * one -- only the scope that linked it (or the operator, from the dashboard) can unlink it.
 *
 * The same `can_signal` switch, and the same object this module hands the bridge, also covers Signal
 * GROUPS: list the ones the bot is currently a member of and not yet linked to anyone
 * (piper_signal_groups), link/unlink one, and send a message or file into it. Linking a group sends
 * nothing into it -- unlike a 1:1 number's welcome message, a group stays quiet until actually
 * @-mentioned, matching every other message there. SIGNAL_MAX_GROUPS_PER_SCOPE /
 * SIGNAL_MAX_NEW_GROUPS_PER_DAY are the group equivalents of the two caps above, kept separate so one
 * can't silently eat into the other.
 */
import { config } from "./settings.mjs";
import { agentScope, agents } from "./agents.mjs";
import { apiKeys } from "./auth.mjs";
import { audit } from "./audit.mjs";
import {
	closeSignalSession,
	contactsOf,
	getContactByNumber,
	getGroupByGroupId,
	groupsOf,
	linkContact,
	linkGroup,
	listSignalGroups,
	newContactsToday,
	newGroupsToday,
	normalizePhoneNumber,
	sendSignalFile,
	sendSignalGroupFile,
	sendSignalGroupMessage,
	sendSignalMessage,
	setContactEnabled,
	setGroupEnabled,
} from "./signal.mjs";

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

/** Which linked, enabled number a send (a message, a file) means: the one named, or the caller's
 * only one, or -- with more than one -- an error naming all of them rather than guessing. Shared by
 * sendMessage and sendFile so the two can never pick a target differently from one another. */
function pickTarget(record, phoneNumber) {
	const own = contactsOf(record).filter((c) => c.enabled);
	if (!own.length) throw new Error("no number is linked yet; use piper_signal_enable first");
	if (phoneNumber) {
		const number = normalizePhoneNumber(phoneNumber);
		const target = own.find((c) => c.phoneNumber === number);
		if (!target) throw new Error("that is not one of your own linked numbers; list them first");
		return target;
	}
	if (own.length === 1) return own[0];
	throw new Error(`more than one number is linked; say which one with phone_number: ${own.map((c) => c.phoneNumber).join(", ")}`);
}

/** Same idea as pickTarget, for a linked GROUP instead of a phone number. Shared by sendGroupMessage
 * and sendGroupFile so the two can never pick a target differently from one another. */
function pickGroupTarget(record, groupId) {
	const own = groupsOf(record).filter((g) => g.enabled);
	if (!own.length) throw new Error("no group is linked yet; use piper_signal_link_group first");
	if (groupId) {
		const target = own.find((g) => g.groupId === groupId);
		if (!target) throw new Error("that is not one of your own linked groups; list them first");
		return target;
	}
	if (own.length === 1) return own[0];
	throw new Error(`more than one group is linked; say which one with group_id: ${own.map((g) => g.groupId).join(", ")}`);
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
		async sendMessage({ message, phoneNumber } = {}) {
			requireSignal(record);
			const text = String(message ?? "").trim();
			if (!text) throw new Error("say what to send");
			const target = pickTarget(record, phoneNumber);
			await sendSignalMessage(target.phoneNumber, text);
			audit("signal.message.send", target.phoneNumber, `${record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`} sent a message`);
			return { sent: true, phoneNumber: target.phoneNumber };
		},
		async sendFile({ path, phoneNumber, message } = {}) {
			requireSignal(record);
			const relPath = String(path ?? "").trim();
			if (!relPath) throw new Error("name a file from your workspace to send");
			const target = pickTarget(record, phoneNumber);
			// Derived directly, like credentialFor's own scopeId, rather than trusted from record.scopeId:
			// that field happens to be set correctly on the real session record the bridge hands in, but
			// nothing here should depend on a caller having already computed it right.
			const scopeId = record.agentId ? agentScope(record.keyId, record.agentId) : record.keyId;
			await sendSignalFile(target.phoneNumber, scopeId, relPath, message);
			audit("signal.file.send", target.phoneNumber, `${record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`} sent ${relPath}`);
			return { sent: true, phoneNumber: target.phoneNumber };
		},
		reset() {
			requireSignal(record);
			const wasRunning = closeSignalSession(record.keyId, record.agentId ?? null);
			audit("signal.session.reset", record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`, wasRunning ? "ended on request; the next message starts fresh" : "nothing was running");
			return { reset: true, wasRunning };
		},
		// ---- groups: same shape as the 1:1 methods above, see lib/signal.mjs's own doc comment for
		// how a linked group differs (mention-only, its own session). ----
		async groups() {
			requireSignal(record);
			const live = await listSignalGroups();
			const liveIds = new Set(live.map((g) => g.groupId));
			const linked = groupsOf(record).map((g) => ({ ...g, stale: !liveIds.has(g.groupId) }));
			const linkedIds = new Set(linked.map((g) => g.groupId));
			const available = live.filter((g) => !linkedIds.has(g.groupId) && !getGroupByGroupId(g.groupId));
			return { linked, available };
		},
		async linkGroup({ groupId, name } = {}) {
			requireSignal(record);
			const id = String(groupId ?? "").trim();
			if (!id) throw new Error("say which group, by its id from piper_signal_groups");
			const existing = getGroupByGroupId(id);
			if (existing && !sameScope(existing, record)) throw new Error("that group is already linked elsewhere; ask its operator to unlink it first");
			if (existing?.enabled) return existing; // already linked here -- no-op
			const live = await listSignalGroups();
			const found = live.find((g) => g.groupId === id);
			if (!found) throw new Error("the bot is not currently a member of that group; invite it first, then list groups again");
			if (!existing) {
				const scopeCap = Number(config.SIGNAL_MAX_GROUPS_PER_SCOPE ?? 5);
				if (groupsOf(record).length >= scopeCap) throw new Error(`${record.agentId ? "this agent" : "this key"} already has ${scopeCap} linked groups, the most it may have; unlink one first`);
				const dailyCap = Number(config.SIGNAL_MAX_NEW_GROUPS_PER_DAY ?? 20);
				if (newGroupsToday() >= dailyCap) throw new Error(`${dailyCap} new groups have already been linked gateway-wide in the last 24 hours, the most allowed; try again later`);
			}
			const group = linkGroup({ keyId: record.keyId, agentId: record.agentId ?? null, groupId: id, name: found.name ?? name ?? null });
			// Unlike enable()'s 1:1 welcome message, nothing is sent into the group the moment it's
			// linked -- it stays quiet until actually mentioned, same as every other message there.
			audit("signal.group.enable", id, `linked to ${record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`}`);
			return group;
		},
		unlinkGroup({ id, groupId } = {}) {
			requireSignal(record);
			const found = id ? groupsOf(record).find((g) => g.id === String(id)) : groupsOf(record).find((g) => g.groupId === String(groupId ?? ""));
			if (!found) throw new Error("there is no such linked group of yours; list them first");
			setGroupEnabled(found.id, false);
			audit("signal.group.disable", found.groupId, record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`);
			return true;
		},
		async sendGroupMessage({ message, groupId } = {}) {
			requireSignal(record);
			const text = String(message ?? "").trim();
			if (!text) throw new Error("say what to send");
			const target = pickGroupTarget(record, groupId);
			await sendSignalGroupMessage(target.groupId, text);
			audit("signal.group.message.send", target.groupId, `${record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`} sent a message`);
			return { sent: true, groupId: target.groupId };
		},
		async sendGroupFile({ path, groupId, message } = {}) {
			requireSignal(record);
			const relPath = String(path ?? "").trim();
			if (!relPath) throw new Error("name a file from your workspace to send");
			const target = pickGroupTarget(record, groupId);
			const scopeId = record.agentId ? agentScope(record.keyId, record.agentId) : record.keyId;
			await sendSignalGroupFile(target.groupId, scopeId, relPath, message);
			audit("signal.group.file.send", target.groupId, `${record.agentId ? `agent ${callerName(record)}` : `key ${callerName(record)}`} sent ${relPath}`);
			return { sent: true, groupId: target.groupId };
		},
		resetGroup({ groupId } = {}) {
			requireSignal(record);
			const target = pickGroupTarget(record, groupId);
			const wasRunning = closeSignalSession(record.keyId, record.agentId ?? null, target.groupId);
			audit("signal.session.reset", target.groupId, wasRunning ? "ended on request; the next mention starts fresh" : "nothing was running");
			return { reset: true, wasRunning, groupId: target.groupId };
		},
	};
}
