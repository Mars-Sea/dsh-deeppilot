import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash, createPrivateKey, randomBytes, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { WebSocketServer } from "ws";
import { homedir, networkInterfaces } from "node:os";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { connect } from "node:http2";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { request } from "node:https";
//#region src/token.ts
/** Expand a leading ~ using the process home directory. */
function expandHome(p) {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return p;
}
function dshDataRoot() {
	const dshHome = process.env.DSH_HOME;
	if (dshHome && dshHome.trim().length > 0) return resolve(dshHome.trim());
	return resolve(homedir(), ".dsh");
}
/** DeepPilot data directory: under $DSH_HOME when set, else ~/.dsh. */
function bridgeDataDir() {
	return resolve(dshDataRoot(), "deeppilot");
}
/**
* Move the pre-DeepPilot data directory as one atomic directory rename.
* Existing canonical data always wins; secrets are never merged or replaced.
*/
async function migrateLegacyBridgeDataDir() {
	const target = bridgeDataDir();
	try {
		await access(target);
		return null;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const legacy = resolve(dshDataRoot(), "pocket-bridge");
	try {
		await rename(legacy, target);
		return legacy;
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}
/**
* Load the pairing token from disk or generate and persist a fresh one.
* The file is written 0600; the token never appears in logs.
*/
async function loadOrCreateToken(tokenPath) {
	const full = expandHome(tokenPath);
	try {
		const existing = (await readFile(full, "utf8")).trim();
		if (existing.length >= 32) return existing;
		await preserveCorruptSidecar(full);
		throw new Error(`pairing token is malformed at ${full} (length=${existing.length}); original preserved as ${full}.corrupt`);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const token = randomBytes(32).toString("base64url");
	await mkdir(dirname(full), { recursive: true });
	await writeFile(full, token + "\n", { mode: 384 });
	return token;
}
/**
* Copy a malformed auth-token file to `<path>.corrupt` so a future operator
* can inspect what was on disk at the moment of corruption. Best-effort:
* a copy failure (permissions, full disk, ...) must not block the loud
* throw that actually surfaces the issue.
*/
async function preserveCorruptSidecar(full) {
	try {
		const original = await readFile(full);
		const sidecar = `${full}.corrupt`;
		await writeFile(sidecar, original, { mode: 384 });
	} catch {}
}
/**
* Generate a fresh pairing token and replace the stored one, invalidating
* every copy of the old secret. The write goes to a same-directory temp file
* renamed over the target so a crash can never leave a truncated token file.
*/
async function writeNewToken(tokenPath) {
	const full = expandHome(tokenPath);
	const token = randomBytes(32).toString("base64url");
	await mkdir(dirname(full), { recursive: true });
	const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(temp, token + "\n", { mode: 384 });
	await rename(temp, full);
	return token;
}
/** Constant-time token comparison; both sides are high-entropy secrets. */
function tokenMatches(presented, expected) {
	if (!presented) return false;
	const b = Buffer.from(expected);
	if (Buffer.byteLength(presented, "utf8") !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	const a = Buffer.from(presented);
	return timingSafeEqual(a, b);
}
/** Hex shape of an APNs device token as delivered by iOS (usually 64 chars). */
const APNS_TOKEN_PATTERN = /^[0-9a-f]{32,512}$/;
function isValidApnsToken(token) {
	return typeof token === "string" && APNS_TOKEN_PATTERN.test(token);
}
/**
* Paired-device registry persisted as one JSON document. Whole-document
* writes (serialized, never interleaved); a corrupt file falls back to an
* empty registry rather than failing the plugin.
*/
var DeviceStore = class DeviceStore {
	filePath;
	devices = /* @__PURE__ */ new Map();
	flushTail = Promise.resolve();
	constructor(filePath) {
		this.filePath = filePath;
	}
	static async load(filePath) {
		const store = new DeviceStore(filePath);
		try {
			const raw = JSON.parse(await readFile(expandHome(filePath), "utf8"));
			for (const rec of raw.devices ?? []) if (typeof rec.deviceId === "string") store.devices.set(rec.deviceId, rec);
		} catch (error) {
			if (error?.code === "ENOENT") {} else console.log("[deeppilot] device registry unreadable, starting empty: " + String(error));
		}
		return store;
	}
	touch(record, now) {
		const existing = this.devices.get(record.deviceId);
		if (existing) {
			existing.lastSeenTs = now;
			existing.deviceName = record.deviceName || existing.deviceName;
			existing.appVersion = record.appVersion || existing.appVersion;
		} else {
			if (this.devices.size >= 64) {
				let oldestId;
				let oldestTs = Number.POSITIVE_INFINITY;
				for (const [id, value] of this.devices) if (value.lastSeenTs < oldestTs) {
					oldestTs = value.lastSeenTs;
					oldestId = id;
				}
				if (oldestId !== void 0) this.devices.delete(oldestId);
			}
			this.devices.set(record.deviceId, {
				...record,
				firstSeenTs: now,
				lastSeenTs: now
			});
		}
		this.flush();
	}
	list() {
		return [...this.devices.values()];
	}
	/**
	* Store (or refresh) the APNs registration of a paired device. Idempotent:
	* an unchanged registration does not rewrite the registry file, so the
	* app's re-register-on-every-handshake policy stays write-quiet.
	*/
	setPushToken(deviceId, token, environment, categories, now) {
		const normalized = token.toLowerCase();
		if (!isValidApnsToken(normalized)) return;
		let record = this.devices.get(deviceId);
		if (!record) {
			record = {
				deviceId,
				deviceName: "unknown",
				appVersion: "unknown",
				firstSeenTs: now,
				lastSeenTs: now
			};
			this.devices.set(deviceId, record);
		}
		const next = {
			token: normalized,
			environment,
			updatedAt: now
		};
		if (categories && typeof categories === "object") {
			const clean = {};
			for (const [key, value] of Object.entries(categories)) if (/^[a-z.]{1,64}$/.test(key) && typeof value === "boolean") clean[key] = value;
			if (Object.keys(clean).length > 0) next.categories = clean;
		}
		const current = record.apns;
		if (current && current.token === next.token && current.environment === next.environment && JSON.stringify(current.categories ?? {}) === JSON.stringify(next.categories ?? {})) return;
		record.apns = next;
		this.flush();
	}
	/** Drop a device's APNs registration (APNs reported the token unregistered). */
	clearPushToken(deviceId) {
		const record = this.devices.get(deviceId);
		if (!record?.apns) return;
		delete record.apns;
		this.flush();
	}
	/**
	* Drop every paired-device record. Used by token rotation: devices paired
	* under the old token can no longer authenticate, so keeping their rows
	* would paint a misleading "still paired" picture.
	*/
	clear() {
		this.devices.clear();
		this.flush();
	}
	/** Serialized so concurrent touches can never interleave half-written JSON. */
	flush() {
		const next = this.flushTail.then(() => this.writeFile());
		this.flushTail = next.catch(() => {});
		return next;
	}
	/** Resolves once every queued registry write has landed (test support). */
	async drain() {
		await this.flushTail;
	}
	async writeFile() {
		const full = expandHome(this.filePath);
		const body = JSON.stringify({
			version: 1,
			devices: this.list()
		}, null, 2);
		try {
			await mkdir(dirname(full), { recursive: true });
			const temp = `${full}.${randomBytes(6).toString("hex")}.tmp`;
			await writeFile(temp, body + "\n", { mode: 384 });
			await rename(temp, full);
		} catch {}
	}
};
//#endregion
//#region src/connection.ts
const AUTH_TIMEOUT_MS = 5e3;
const IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
const MAX_PROMPT_IMAGES = 4;
const MAX_BASE64_CHARS_PER_IMAGE = 8388608;
/** Bounds a single prompt's text; the frame itself is capped by ws maxPayload. */
const MAX_PROMPT_TEXT_CHARS = 262144;
const MAX_DEVICE_ID_CHARS = 128;
const MAX_DEVICE_NAME_CHARS = 64;
const MAX_APP_VERSION_CHARS = 32;
function sanitizeDeviceField(value, maxChars) {
	return (typeof value === "string" ? value : String(value ?? "")).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxChars);
}
function helloTokenAccepted(transportAuthenticated, presentedToken, expectedToken) {
	return transportAuthenticated === true || tokenMatches(presentedToken, expectedToken);
}
/**
* One connected phone. Implements BridgeSink so the HostBridge can push
* projected frames and replays. Bearer/query credentials may authenticate the
* HTTP upgrade; otherwise the first hello frame is verified here.
*/
var BridgeConnection = class {
	ws;
	deps;
	authenticated = false;
	closed = false;
	helloTimer;
	openSessions = /* @__PURE__ */ new Set();
	/** Sanitized device identity from hello; needed for push registration. */
	deviceId;
	constructor(ws, deps) {
		this.ws = ws;
		this.deps = deps;
		ws.on("message", (data) => {
			this.onMessage(String(data));
		});
		ws.on("close", () => {
			this.onClose();
			deps.onClosed?.(this);
		});
		ws.on("error", () => {});
		this.helloTimer = setTimeout(() => {
			if (!this.authenticated) this.close(4402, "auth timeout");
		}, AUTH_TIMEOUT_MS);
	}
	/** Hard-drop the socket (server-side stale sweep). */
	terminate() {
		this.ws.terminate();
	}
	/** Protocol-compliant idle timeout: let the peer observe a normal 1001 close. */
	closeIdle() {
		this.close(1001, "idle timeout");
	}
	/** Announce an orderly plugin/data-plane shutdown before closing the socket. */
	closeForServerStop() {
		this.fail(void 0, "E_INTERNAL", "server stopping");
		this.close(1001, "server stopping");
	}
	/** Used by dependency-lifecycle cleanup to avoid closing a replacement bridge. */
	isAttachedTo(bridge) {
		return this.deps.bridge === bridge;
	}
	/** Device identity once hello succeeded; undefined before that. */
	get connectedDeviceId() {
		return this.authenticated ? this.deviceId : void 0;
	}
	push(type, payload, seq) {
		if (this.deps.debug === true) this.deps.log("push " + type + " seq=" + String(seq));
		this.send(type, payload, void 0, seq);
	}
	replay(entries) {
		for (const entry of entries) this.push(entry.type, entry.payload, entry.seq);
	}
	replayDone() {
		this.push("s2c.resume.done", {});
	}
	resync() {
		this.push("s2c.resync", { reason: "gap" });
	}
	lastCursor() {
		return this.deps.bridge.currentCursor();
	}
	onClose() {
		if (this.closed) return;
		this.closed = true;
		if (this.helloTimer !== void 0) clearTimeout(this.helloTimer);
		for (const id of this.openSessions) this.deps.bridge.markSinkClosed(this, id);
		this.openSessions.clear();
		this.deps.bridge.dropSinkSessions(this);
		if (this.authenticated) this.deps.bridge.removeSink(this);
	}
	close(code, reason) {
		if (this.closed) return;
		try {
			this.ws.close(code, reason);
		} catch {
			this.ws.terminate();
		}
	}
	send(type, payload, id, seq) {
		const envelope = {
			v: 1,
			type,
			ts: Date.now(),
			...id !== void 0 ? { id } : {},
			...seq !== void 0 ? { seq } : {},
			payload
		};
		if (this.ws.readyState !== this.ws.OPEN) return;
		if (this.ws.bufferedAmount > 4194304) {
			this.close(1013, "client too slow");
			return;
		}
		this.ws.send(JSON.stringify(envelope));
	}
	fail(id, code, message) {
		this.send("s2c.error", {
			code,
			message
		}, id);
	}
	lastActivity = Date.now();
	/** True when no inbound frame arrived within maxIdleMs. */
	isStale(now, maxIdleMs) {
		return now - this.lastActivity > maxIdleMs;
	}
	async onMessage(raw) {
		this.lastActivity = Date.now();
		if (!this.authenticated && raw.length > 65536) {
			this.close(1009, "pre-auth frame too large");
			return;
		}
		let env;
		try {
			env = JSON.parse(raw);
		} catch {
			this.fail(void 0, "E_PROTOCOL", "frame is not valid JSON");
			return;
		}
		if (env.v !== 1) {
			this.fail(env.id, "E_UNSUPPORTED", "unsupported protocol version");
			this.close(4500, "protocol version mismatch");
			return;
		}
		if (!this.authenticated) {
			if (env.type === "c2s.ping") {
				this.send("s2c.pong", { serverTime: Date.now() }, env.id);
				return;
			}
			if (env.type === "c2s.hello.auth") {
				await this.hello(env);
				return;
			}
			this.fail(env.id, "E_PROTOCOL", "authenticate first");
			return;
		}
		switch (env.type) {
			case "c2s.ping":
				this.send("s2c.pong", { serverTime: Date.now() }, env.id);
				return;
			case "c2s.sessions.list":
				this.send("s2c.sessions.snapshot", {
					full: true,
					sessions: this.deps.bridge.listSessions()
				}, env.id);
				return;
			case "c2s.pending.list":
				this.send("s2c.pending.snapshot", this.deps.bridge.pendingSnapshot(), env.id);
				return;
			case "c2s.workspaces.list": {
				if (!this.deps.bridge.capabilities.projectSelection) return this.fail(env.id, "E_UNSUPPORTED", "project selection unavailable on this host version");
				const result = await this.deps.bridge.listWorkspaces();
				if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message);
				this.send("s2c.workspaces.snapshot", { workspaces: result.value }, env.id);
				return;
			}
			case "c2s.directory.list": {
				const p = env.payload;
				if (p?.path !== void 0 && typeof p.path !== "string") return this.fail(env.id, "E_PROTOCOL", "path must be a string");
				const result = await this.deps.bridge.listDirectory(p?.path);
				if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message);
				this.send("s2c.directory.listing", result.value, env.id);
				return;
			}
			case "c2s.directory.pick": {
				const result = await this.deps.bridge.pickDirectory();
				if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message);
				this.send("s2c.directory.picked", { path: result.value }, env.id);
				return;
			}
			case "c2s.workspace.create": {
				const p = env.payload;
				const path = typeof p?.path === "string" ? p.path.trim() : "";
				if (!path) return this.fail(env.id, "E_PROTOCOL", "non-empty path required");
				if (!this.deps.bridge.capabilities.projectSelection) return this.fail(env.id, "E_UNSUPPORTED", "project selection unavailable on this host version");
				const result = await this.deps.bridge.createWorkspace(path);
				if (!result.ok) return this.fail(env.id, managementErrorCode(result.kind), result.message);
				this.send("s2c.workspace.created", result.value, env.id);
				return;
			}
			case "c2s.session.open": {
				const p = env.payload;
				if (!p?.sessionId || typeof p.sessionId !== "string") return this.fail(env.id, "E_PROTOCOL", "sessionId required");
				const sessionId = p.sessionId;
				this.openSessions.add(sessionId);
				this.deps.bridge.markSinkOpen(this, sessionId);
				if (!await this.deps.bridge.openSession(this, sessionId, p.tailCount ?? 100)) {
					this.openSessions.delete(sessionId);
					this.deps.bridge.markSinkClosed(this, sessionId);
					return this.fail(env.id, "E_NOT_FOUND", "session history unavailable");
				}
				return;
			}
			case "c2s.session.close": {
				const p = env.payload;
				if (!p?.sessionId) return this.fail(env.id, "E_PROTOCOL", "sessionId required");
				this.openSessions.delete(p.sessionId);
				this.deps.bridge.markSinkClosed(this, p.sessionId);
				this.send("s2c.ack", {}, env.id);
				return;
			}
			case "c2s.session.create": {
				const p = env.payload;
				const workspaceId = typeof p?.workspaceId === "string" ? p.workspaceId.trim() : "";
				const cwd = typeof p?.cwd === "string" ? p.cwd.trim() : "";
				if (workspaceId && cwd) return this.fail(env.id, "E_PROTOCOL", "workspaceId and cwd are mutually exclusive");
				const newId = await this.deps.bridge.createSession({
					...workspaceId ? { workspaceId } : {},
					...cwd ? { cwd } : {}
				});
				if (!newId) return this.fail(env.id, "E_INTERNAL", "session create failed");
				this.send("s2c.ack", { sessionId: newId }, env.id);
				return;
			}
			case "c2s.session.rename": {
				const p = env.payload;
				const title = typeof p?.title === "string" ? p.title.trim() : "";
				if (!p?.sessionId || title.length === 0) return this.fail(env.id, "E_PROTOCOL", "sessionId and non-empty title required");
				if (!this.deps.bridge.capabilities.sessionManagement) return this.fail(env.id, "E_UNSUPPORTED", "session management unavailable on this host version");
				const result = await this.deps.bridge.renameSession(p.sessionId, title);
				if (!result.ok) {
					const code = result.kind === "not-found" ? "E_NOT_FOUND" : result.kind === "busy" ? "E_BUSY" : result.kind === "unsupported" ? "E_UNSUPPORTED" : result.kind === "invalid" ? "E_PROTOCOL" : "E_INTERNAL";
					return this.fail(env.id, code, result.message);
				}
				this.send("s2c.session.renamed", {
					sessionId: p.sessionId,
					title: result.value
				}, env.id);
				return;
			}
			case "c2s.session.archive": {
				const p = env.payload;
				if (!p?.sessionId) return this.fail(env.id, "E_PROTOCOL", "sessionId required");
				if (!this.deps.bridge.capabilities.sessionManagement) return this.fail(env.id, "E_UNSUPPORTED", "session management unavailable on this host version");
				const result = await this.deps.bridge.archiveSession(p.sessionId);
				if (!result.ok) {
					const code = result.kind === "not-found" ? "E_NOT_FOUND" : result.kind === "busy" ? "E_BUSY" : result.kind === "unsupported" ? "E_UNSUPPORTED" : result.kind === "invalid" ? "E_PROTOCOL" : "E_INTERNAL";
					return this.fail(env.id, code, result.message);
				}
				this.send("s2c.session.archived", { sessionId: p.sessionId }, env.id);
				return;
			}
			case "c2s.session.cancel": {
				const p = env.payload;
				if (!p?.sessionId) return this.fail(env.id, "E_PROTOCOL", "sessionId required");
				const result = await this.deps.bridge.cancelSession(p.sessionId);
				if (!result.ok) {
					const code = result.kind === "not-found" ? "E_NOT_FOUND" : result.kind === "busy" ? "E_BUSY" : result.kind === "unsupported" ? "E_UNSUPPORTED" : result.kind === "invalid" ? "E_PROTOCOL" : "E_INTERNAL";
					return this.fail(env.id, code, result.message);
				}
				this.send("s2c.ack", { sessionId: p.sessionId }, env.id);
				return;
			}
			case "c2s.session.history": {
				const p = env.payload;
				if (!p?.sessionId || typeof p.beforeSeq !== "number") return this.fail(env.id, "E_PROTOCOL", "sessionId and beforeSeq required");
				if (!await this.deps.bridge.historyPage(this, p.sessionId, p.beforeSeq, Math.min(p.limit ?? 100, 500))) this.fail(env.id, "E_NOT_FOUND", "history unavailable");
				return;
			}
			case "c2s.session.attachment": {
				const p = env.payload;
				if (!p?.sessionId || typeof p.attachmentId !== "string" || p.attachmentId.length === 0) return this.fail(env.id, "E_PROTOCOL", "sessionId and attachmentId required");
				const image = await this.deps.bridge.attachmentData(p.sessionId, p.attachmentId);
				if (!image) return this.fail(env.id, "E_NOT_FOUND", "attachment unavailable");
				this.send("s2c.ack", image, env.id);
				return;
			}
			case "c2s.session.models": {
				const p = env.payload;
				if (!p?.sessionId) return this.fail(env.id, "E_PROTOCOL", "sessionId required");
				if (!this.deps.bridge.capabilities.models) return this.fail(env.id, "E_UNSUPPORTED", "model selection unavailable on this host version");
				const result = await this.deps.bridge.sessionModels(p.sessionId);
				if (!result.ok) {
					const code = result.kind === "not-found" ? "E_NOT_FOUND" : result.kind === "busy" ? "E_BUSY" : result.kind === "unsupported" ? "E_UNSUPPORTED" : result.kind === "unavailable" ? "E_NOT_FOUND" : "E_INTERNAL";
					return this.fail(env.id, code, result.message);
				}
				this.send("s2c.session.models", {
					sessionId: p.sessionId,
					...result.value
				}, env.id);
				return;
			}
			case "c2s.session.selectModel": {
				const p = env.payload;
				if (!p?.sessionId || !p.provider?.trim() || !p.model?.trim()) return this.fail(env.id, "E_PROTOCOL", "sessionId, provider and model required");
				if (!this.deps.bridge.capabilities.models) return this.fail(env.id, "E_UNSUPPORTED", "model selection unavailable on this host version");
				const result = await this.deps.bridge.selectSessionModel(p.sessionId, {
					provider: p.provider.trim(),
					model: p.model.trim(),
					...p.reasoningEffort?.trim() ? { reasoningEffort: p.reasoningEffort.trim() } : {}
				});
				if (!result.ok) {
					const code = result.kind === "not-found" ? "E_NOT_FOUND" : result.kind === "busy" ? "E_BUSY" : result.kind === "unsupported" ? "E_UNSUPPORTED" : result.kind === "unavailable" ? "E_NOT_FOUND" : "E_INTERNAL";
					return this.fail(env.id, code, result.message);
				}
				this.send("s2c.session.modelSelected", {
					sessionId: p.sessionId,
					selected: result.value
				}, env.id);
				return;
			}
			case "c2s.session.sendPrompt": {
				const p = env.payload;
				const text = typeof p?.text === "string" ? p.text : "";
				const rawImages = Array.isArray(p?.images) ? p.images : [];
				if (!p?.sessionId || text.trim().length === 0 && rawImages.length === 0) return this.fail(env.id, "E_PROTOCOL", "sessionId and text or images required");
				if (text.length > MAX_PROMPT_TEXT_CHARS) return this.fail(env.id, "E_PROTOCOL", "prompt text too long");
				if (rawImages.length > MAX_PROMPT_IMAGES) return this.fail(env.id, "E_PROTOCOL", "too many images");
				const images = [];
				for (const image of rawImages) {
					if (!IMAGE_MEDIA_TYPES.has(String(image?.mediaType)) || typeof image?.data !== "string" || image.data.length === 0 || image.data.length > MAX_BASE64_CHARS_PER_IMAGE) return this.fail(env.id, "E_PROTOCOL", "invalid image attachment");
					images.push({
						mediaType: image.mediaType,
						data: image.data,
						...typeof image.name === "string" && sanitizeImageName(image.name).length > 0 ? { name: sanitizeImageName(image.name) } : {}
					});
				}
				const userSeq = await this.deps.bridge.sendPrompt(p.sessionId, text, images);
				if (!userSeq.ok) return this.fail(env.id, managementErrorCode(userSeq.kind), userSeq.message);
				this.send("s2c.ack", { userSeq: userSeq.value }, env.id);
				return;
			}
			case "c2s.approval.respond": {
				const p = env.payload;
				if (!p?.requestId || p.decision !== "allow" && p.decision !== "deny") return this.fail(env.id, "E_PROTOCOL", "requestId and decision required");
				const outcome = await this.deps.bridge.respondApproval(p.requestId, p.decision, typeof p.reason === "string" ? p.reason : void 0);
				if (!outcome.ok) return this.fail(env.id, pendingResponseErrorCode(outcome.reason), pendingResponseMessage("approval", outcome.reason));
				this.send("s2c.ack", {}, env.id);
				return;
			}
			case "c2s.question.respond": {
				const p = env.payload;
				if (!p?.requestId || !Array.isArray(p.answers)) return this.fail(env.id, "E_PROTOCOL", "requestId and answers required");
				const outcome = await this.deps.bridge.respondQuestion(p.requestId, p.answers);
				if (!outcome.ok) return this.fail(env.id, pendingResponseErrorCode(outcome.reason), pendingResponseMessage("question", outcome.reason));
				this.send("s2c.ack", {}, env.id);
				return;
			}
			case "c2s.push.register": {
				const p = env.payload;
				const token = typeof p?.deviceToken === "string" ? p.deviceToken.trim() : "";
				if (!isValidApnsToken(token)) return this.fail(env.id, "E_PROTOCOL", "hex deviceToken (32-512 chars) required");
				const environment = p?.environment === "production" ? "production" : "development";
				const categories = typeof p?.categories === "object" && p.categories !== null ? p.categories : void 0;
				if (!this.deviceId || !this.authenticated) return this.fail(env.id, "E_PROTOCOL", "authenticate first");
				if (typeof p?.enrollKey === "string") {
					const enrollKey = p.enrollKey.trim().replace(/[^\x20-\x7e]/g, "").slice(0, 128);
					if (enrollKey.length >= 8 && enrollKey.length <= 128) await this.deps.onPushEnrollKey?.(enrollKey);
				}
				this.deps.devices.setPushToken(this.deviceId, token, environment, categories, Date.now());
				if (!this.deps.bridge.capabilities.push) {
					if (this.deps.debug === true) this.deps.log("push register held: bridge not ready");
					return this.fail(env.id, "E_UNSUPPORTED", "push is not configured on this bridge");
				}
				if (this.deps.debug === true) this.deps.log("push token registered env=" + environment);
				this.send("s2c.ack", { enabled: true }, env.id);
				return;
			}
			default: this.fail(env.id, "E_PROTOCOL", "unknown type: " + env.type);
		}
	}
	async hello(env) {
		const p = env.payload ?? {};
		if (!helloTokenAccepted(this.deps.transportAuthenticated, p.token, this.deps.expectedToken)) {
			this.fail(env.id, "E_AUTH", "token missing or invalid");
			this.close(4401, "invalid token");
			return;
		}
		if (!p.deviceId) {
			this.fail(env.id, "E_PROTOCOL", "deviceId required");
			this.close(4403, "deviceId required");
			return;
		}
		const deviceId = sanitizeDeviceField(p.deviceId, MAX_DEVICE_ID_CHARS);
		if (!deviceId) {
			this.fail(env.id, "E_PROTOCOL", "deviceId required");
			this.close(4403, "deviceId required");
			return;
		}
		const deviceName = sanitizeDeviceField(p.deviceName, MAX_DEVICE_NAME_CHARS) || "unknown";
		const appVersion = sanitizeDeviceField(p.appVersion, MAX_APP_VERSION_CHARS) || "unknown";
		this.authenticated = true;
		this.deviceId = deviceId;
		if (this.helloTimer !== void 0) clearTimeout(this.helloTimer);
		this.deps.devices.touch({
			deviceId,
			deviceName,
			appVersion
		}, Date.now());
		this.deps.log("device paired: " + deviceName + " (" + deviceId + ")");
		const cursor = typeof p.resumeCursor === "number" && p.resumeCursor >= 0 ? p.resumeCursor : void 0;
		const canResume = cursor !== void 0 && this.deps.bridge.canResumeFrom(cursor);
		this.send("s2c.welcome", {
			protocolVersion: 1,
			serverVersion: this.deps.serverVersion,
			capabilities: this.deps.bridge.capabilities,
			cursor: this.deps.bridge.currentCursor(),
			resumed: canResume
		}, env.id);
		this.deps.bridge.addSink(this);
		if (cursor !== void 0) {
			if (canResume) this.deps.bridge.resumeFrom(cursor, this);
			else this.resync();
		}
	}
};
function sanitizeImageName(value) {
	return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 120);
}
/** Error code for a failed approval/question response outcome. */
function pendingResponseErrorCode(reason) {
	switch (reason) {
		case "not-pending": return "E_NOT_FOUND";
		case "bad-response": return "E_PROTOCOL";
		case "transport": return "E_INTERNAL";
	}
}
/** Human-readable failure detail; `question not pending` must only ever mean
* "nothing pending", never "the host rejected the answer". */
function pendingResponseMessage(kind, reason) {
	switch (reason) {
		case "not-pending": return kind + " not pending";
		case "bad-response": return kind + " answer rejected by host: answer does not match the asked questions";
		case "transport": return "host connection failed while answering " + kind;
	}
}
function managementErrorCode(kind) {
	switch (kind) {
		case "unsupported": return "E_UNSUPPORTED";
		case "not-found": return "E_NOT_FOUND";
		case "busy": return "E_BUSY";
		case "invalid": return "E_PROTOCOL";
		case "internal": return "E_INTERNAL";
	}
}
//#endregion
//#region src/host-bridge.ts
/**
* Subagent sessions are host-internal workers of a parent conversation.
* They must never surface on the phone: not in the project/session list,
* and not as turn-completion pushes for a session the device cannot open.
*/
function isSubagentRow(row) {
	return row.origin === "subagent" || typeof row.parentSessionId === "string" && row.parentSessionId.length > 0;
}
function unwrapStreamItem(item) {
	const nested = item.payload;
	if (nested && typeof nested === "object" && typeof nested.type === "string") return item.rpcId ? {
		...nested,
		rpcId: item.rpcId
	} : nested;
	return item;
}
const MAX_RING_DEFAULT = 2e3;
const MAX_MESSAGE_PROJECTION_BYTES = 262144;
/**
* Process-wide bridge state: session mirror, pending approvals/questions,
* and the per-device replay ring. Consumes the in-process mux/host streams
* and fans projected pushes out to every registered sink.
*/
let BRIDGE_SEQ = 0;
var HostBridge = class {
	apiProxy;
	historyBufferMax;
	id = ++BRIDGE_SEQ;
	summaries = /* @__PURE__ */ new Map();
	approvals = /* @__PURE__ */ new Map();
	questions = /* @__PURE__ */ new Map();
	archivedSessionIds = /* @__PURE__ */ new Set();
	subagentSessionIds = /* @__PURE__ */ new Set();
	sinks = /* @__PURE__ */ new Set();
	ring = [];
	cursor = 0;
	userReceiptSeq = 0;
	abort = new AbortController();
	started = false;
	disposed = false;
	constructor(apiProxy, historyBufferMax = MAX_RING_DEFAULT) {
		this.apiProxy = apiProxy;
		this.historyBufferMax = historyBufferMax;
	}
	pushOutlet;
	/**
	* Wire the offline-push fan-out. Present ⇒ welcome advertises the `push`
	* capability and notify-worthy events are mirrored to APNs.
	*/
	setPushOutlet(outlet) {
		this.pushOutlet = outlet;
	}
	get capabilities() {
		return {
			historyPaging: true,
			replay: true,
			approvals: true,
			questions: true,
			pendingSnapshot: true,
			models: typeof this.apiProxy.sessions.models === "function" && typeof this.apiProxy.sessions.selectModel === "function",
			sessionManagement: typeof this.apiProxy.sessions.rename === "function" && typeof this.apiProxy.workspace?.archiveSession === "function",
			projectSelection: typeof this.apiProxy.workspace?.list === "function" && typeof this.apiProxy.workspace?.create === "function",
			push: this.pushOutlet?.isAvailable() === true
		};
	}
	diagnostic(message) {
		console.log("[deeppilot] " + message);
	}
	currentCursor() {
		return this.cursor;
	}
	addSink(sink) {
		this.sinks.add(sink);
	}
	removeSink(sink) {
		this.sinks.delete(sink);
	}
	/** Whether the ring still holds everything after the cursor. */
	canResumeFrom(cursor) {
		const oldest = this.ring.length > 0 ? this.ring[0].seq : this.cursor + 1;
		return cursor <= this.cursor && cursor + 1 >= oldest;
	}
	sinkSessions = /* @__PURE__ */ new Map();
	lastAssistantText = /* @__PURE__ */ new Map();
	/** Mark a sink as actively viewing a session (suppresses its turn notifications). */
	markSinkOpen(sink, sessionId) {
		let set = this.sinkSessions.get(sink);
		if (!set) {
			set = /* @__PURE__ */ new Set();
			this.sinkSessions.set(sink, set);
		}
		set.add(sessionId);
	}
	markSinkClosed(sink, sessionId) {
		this.sinkSessions.get(sink)?.delete(sessionId);
	}
	dropSinkSessions(sink) {
		this.sinkSessions.delete(sink);
	}
	isViewedBy(sink, sessionId) {
		return this.sinkSessions.get(sink)?.has(sessionId) ?? false;
	}
	/** F-9: when a notification-worthy event fires, mirror it to every
	*  online device that is not currently viewing the session (the s2c.notify
	*  frame counts toward the seq cursor and joins the replay ring per
	*  PROTOCOL §6 + §7), then fan the same payload out to offline devices
	*  holding an APNs token. */
	emitNotify(args) {
		if (this.subagentSessionIds.has(args.sessionId)) return;
		const body = args.body.length > 120 ? args.body.slice(0, 119) + "…" : args.body;
		this.record("s2c.notify", {
			notificationId: args.notificationId,
			category: args.category,
			sessionId: args.sessionId,
			title: args.title,
			body,
			ts: Date.now()
		}, (sink) => this.isViewedBy(sink, args.sessionId));
		this.fanOutPush({
			notificationId: args.notificationId,
			category: args.category,
			sessionId: args.sessionId,
			title: args.title,
			body
		});
	}
	/** F-9: when a turn completes, notify every device not viewing the session. */
	emitTurnCompletedNotify(sessionId, ok) {
		if (this.subagentSessionIds.has(sessionId)) return;
		const row = this.summaries.get(sessionId);
		const title = ok ? "任务完成" : "任务异常结束";
		const body = this.lastAssistantText.get(sessionId) ?? row?.title ?? "";
		this.emitNotify({
			sessionId,
			category: ok ? "turn.completed" : "session.error",
			title,
			body,
			notificationId: "n-" + (this.cursor + 1)
		});
	}
	/**
	* Mirror one notification-worthy event to offline devices. Fire-and-forget:
	* push failures must never block or break the WS data plane.
	*/
	fanOutPush(notification) {
		try {
			this.pushOutlet?.fanOut(notification);
		} catch {}
	}
	/** Remember the latest assistant text so notifications can quote it. */
	captureAssistantText(sessionId, event) {
		if (event.type !== "assistant/message") return;
		const text = messageText(event.data).trim();
		if (text.length > 0) this.lastAssistantText.set(sessionId, text.slice(-160));
	}
	/**
	* Replay buffered pushes after the given cursor; false when the gap is
	* unrecoverable. Frames go to `target` only — replaying into every sink
	* duplicated the whole window onto devices that never asked for it.
	*/
	resumeFrom(cursor, target) {
		const oldest = this.ring.length > 0 ? this.ring[0].seq : this.cursor + 1;
		if (cursor + 1 < oldest) return false;
		const receivers = target !== void 0 ? [target] : [...this.sinks];
		for (const entry of this.ring) if (entry.seq > cursor) for (const sink of receivers) sink.replay([entry]);
		for (const sink of receivers) sink.replayDone();
		return true;
	}
	record(type, payload, except) {
		if (this.disposed) return;
		this.cursor += 1;
		const entry = {
			seq: this.cursor,
			type,
			payload
		};
		this.ring.push(entry);
		if (this.ring.length > this.historyBufferMax) this.ring.splice(0, this.ring.length - this.historyBufferMax);
		for (const sink of this.sinks) {
			if (except && except(sink)) continue;
			sink.push(type, payload, entry.seq);
		}
	}
	/** Start consuming host + mux streams. Idempotent; aborts on dispose(). */
	start() {
		if (this.started || this.disposed) return;
		this.started = true;
		this.runHostStream();
		this.runMuxStream();
		this.refreshSummaries();
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.abort.abort();
		this.sinks.clear();
		this.sinkSessions.clear();
		this.pushOutlet = void 0;
	}
	async runHostStream() {
		try {
			for await (const item of this.apiProxy.events.host({ rpcId: randomUUID() }, this.abort.signal)) {
				const frame = unwrapStreamItem(item);
				this.onHostFrame(frame);
			}
		} catch {}
	}
	async runMuxStream() {
		try {
			for await (const item of this.apiProxy.events.mux({ rpcId: randomUUID() }, this.abort.signal)) {
				const frame = unwrapStreamItem(item);
				this.onMuxFrame(frame);
			}
		} catch {}
	}
	onHostFrame(frame) {
		switch (frame.type) {
			case "host/session-added":
			case "host/session-removed":
			case "host/workspace-changed":
			case "host/workspace-removed":
			case "host/workspace-order-changed":
				this.refreshSummaries();
				break;
			case "host/archived-sessions-changed": {
				const archived = frame.archivedSessionIds;
				if (Array.isArray(archived)) this.archivedSessionIds = new Set(archived.map(String));
				this.refreshSummaries();
				break;
			}
			case "host/session-status": {
				const p = frame;
				const row = this.summaries.get(String(p.sessionId));
				if (row && typeof p?.running === "boolean") {
					row.status = p.running ? "running" : "idle";
					this.pushSummary(row);
				}
				break;
			}
		}
	}
	onMuxFrame(frame) {
		switch (frame.type) {
			case "session/event": {
				const event = frame.event;
				const sessionId = String(frame.sessionId ?? "");
				if (!event || !sessionId) break;
				this.noteActivity(sessionId, event);
				this.captureAssistantText(sessionId, event);
				const projection = projectEvent(sessionId, event);
				if (projection) this.record("s2c.session.event", {
					sessionId,
					kind: projection.kind,
					seq: event.seq,
					data: projection.data
				});
				if (projection?.kind === "turn.end") this.emitTurnCompletedNotify(sessionId, projection.data.ok === true);
				break;
			}
			case "session/projection": {
				const p = frame;
				if (!p.sessionId) break;
				this.applyProjection(p.sessionId, String(p.key ?? ""), p.value);
				break;
			}
			case "approval/requested": {
				const p = frame;
				if (!p.approvalId || !frame.rpcId) break;
				const toolName = String(p.toolName ?? "tool");
				const summary = String(p.reason ?? "");
				const sessionId = String(p.sessionId ?? "");
				this.approvals.set(p.approvalId, {
					rpcId: frame.rpcId,
					sessionId,
					toolName,
					reason: summary
				});
				this.record("s2c.pending.approval", {
					requestId: p.approvalId,
					sessionId,
					toolName,
					summary,
					riskLevel: riskOf(toolName)
				});
				this.emitNotify({
					sessionId,
					category: "approval.required",
					title: "需要批准",
					body: toolName + ": " + summary,
					notificationId: "apr-" + p.approvalId
				});
				this.bumpPendingFlags(sessionId);
				break;
			}
			case "approval/resolved": {
				const p = frame;
				if (!p.approvalId) break;
				const pending = this.approvals.get(p.approvalId);
				this.approvals.delete(p.approvalId);
				this.record("s2c.pending.cleared", { requestId: p.approvalId });
				if (pending) this.bumpPendingFlags(pending.sessionId);
				break;
			}
			case "question/requested": {
				const p = frame;
				if (!frame.rpcId) break;
				const requestId = "q-" + frame.rpcId;
				const sessionId = String(p?.sessionId ?? "");
				this.questions.set(requestId, {
					rpcId: frame.rpcId,
					sessionId,
					questions: p?.questions
				});
				this.record("s2c.pending.question", {
					requestId,
					sessionId,
					questions: p?.questions ?? []
				});
				this.emitNotify({
					sessionId,
					category: "question.asked",
					title: "有问题需要回答",
					body: firstQuestionText(p?.questions),
					notificationId: requestId
				});
				this.bumpPendingFlags(sessionId);
				break;
			}
			case "question/resolved": {
				const p = frame;
				if (!p.questionRpcId) break;
				const requestId = "q-" + p.questionRpcId;
				const pending = this.questions.get(requestId);
				this.questions.delete(requestId);
				this.record("s2c.pending.cleared", { requestId });
				if (pending) this.bumpPendingFlags(pending.sessionId);
				break;
			}
		}
	}
	async refreshSummaries() {
		try {
			const response = await this.apiProxy.sessions.list({
				rpcId: randomUUID(),
				payload: {}
			});
			if (!response.result || !response.result.ok) {
				this.diagnostic("sessions.list rejected: " + JSON.stringify(response.result ?? null).slice(0, 200));
				return;
			}
			let workspaces = [];
			const workspaceList = this.apiProxy.workspace?.list;
			if (typeof workspaceList === "function") {
				const workspaceResponse = await workspaceList.call(this.apiProxy.workspace, {
					rpcId: randomUUID(),
					payload: {}
				});
				if (workspaceResponse.result?.ok) {
					workspaces = workspaceResponse.result.value.items ?? [];
					this.archivedSessionIds = new Set((workspaceResponse.result.value.archivedSessionIds ?? []).map(String));
				}
			}
			const previousIds = new Set(this.summaries.keys());
			const workspaceBySession = /* @__PURE__ */ new Map();
			for (const workspace of workspaces) for (const sessionId of workspace.sessionIds ?? []) workspaceBySession.set(String(sessionId), workspace);
			const next = /* @__PURE__ */ new Map();
			const subagentIds = /* @__PURE__ */ new Set();
			for (const row of response.result.value.items ?? []) {
				if (this.archivedSessionIds.has(row.sessionId)) continue;
				if (isSubagentRow(row)) {
					subagentIds.add(row.sessionId);
					continue;
				}
				next.set(row.sessionId, toSummary(row, this.approvals, this.questions, workspaceBySession.get(row.sessionId)));
			}
			this.subagentSessionIds = subagentIds;
			this.summaries = next;
			const removedIds = [...previousIds].filter((id) => !next.has(id));
			for (const id of this.lastAssistantText.keys()) if (!next.has(id)) this.lastAssistantText.delete(id);
			this.record("s2c.sessions.delta", {
				upserted: [...next.values()],
				removedIds
			});
		} catch {}
	}
	/** Cold sessions may lack a title projection; fall back to first user text. */
	deriveTitleFallback(sessionId, messages) {
		const row = this.summaries.get(sessionId);
		if (!row || row.title.length > 0) return;
		const firstUser = messages.find((m) => m.role === "user" && (m.text ?? "").trim().length > 0);
		if (!firstUser) return;
		row.title = firstUser.text.replace(/\s+/g, " ").trim().slice(0, 60);
		this.pushSummary(row);
	}
	noteActivity(sessionId, event) {
		const row = this.summaries.get(sessionId);
		if (!row) return;
		switch (event?.type) {
			case "user/message":
			case "turn/start":
			case "turn/end": break;
			default: return;
		}
		row.lastActivityTs = Date.now();
		this.pushSummary(row);
	}
	applyProjection(sessionId, key, value) {
		const row = this.summaries.get(sessionId);
		if (!row) return;
		if (key === "title") row.title = typeof value === "string" ? value : "";
		else if (key === "todos") {
			const sanitized = sanitizeTodoItems(Array.isArray(value) ? value : null);
			row.todoItems = sanitized.length > 0 ? sanitized : null;
			row.todos = sanitized.length > 0 ? {
				done: sanitized.filter((i) => i.status === "completed").length,
				total: sanitized.length
			} : null;
		} else if (key === "sessionListMetadata") {
			const meta = value;
			if (meta?.lastPromptAt) row.lastActivityTs = Math.max(row.lastActivityTs, meta.lastPromptAt);
		} else return;
		this.pushSummary(row);
	}
	bumpPendingFlags(sessionId) {
		const row = this.summaries.get(sessionId);
		if (!row) return;
		let approval = false;
		for (const pending of this.approvals.values()) if (pending.sessionId === sessionId) approval = true;
		let question = false;
		for (const pending of this.questions.values()) if (pending.sessionId === sessionId) question = true;
		row.pendingApproval = approval;
		row.pendingQuestion = question;
		this.pushSummary(row);
	}
	pushSummary(row) {
		this.record("s2c.sessions.delta", {
			upserted: [row],
			removedIds: []
		});
	}
	listSessions() {
		return [...this.summaries.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
	}
	/**
	* Complete transient interaction state. Unlike the replay ring, this remains
	* authoritative after a long disconnect and is rehydrated by apiProxy's mux
	* stream when the bridge itself restarts.
	*/
	pendingSnapshot() {
		return {
			approvals: [...this.approvals.entries()].map(([requestId, pending]) => ({
				requestId,
				sessionId: pending.sessionId,
				toolName: pending.toolName,
				summary: pending.reason,
				riskLevel: riskOf(pending.toolName)
			})),
			questions: [...this.questions.entries()].map(([requestId, pending]) => ({
				requestId,
				sessionId: pending.sessionId,
				questions: Array.isArray(pending.questions) ? pending.questions : []
			}))
		};
	}
	/** Tail history for an opened session; pushes s2c.session.tail to the sink. */
	async openSession(sink, sessionId, tailCount) {
		try {
			const response = await this.apiProxy.sessions.history({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					maxMessages: clampTail(tailCount)
				}
			});
			if (!response.result || !response.result.ok) return false;
			const result = response.result.value;
			const messages = projectHistory(result.events ?? []);
			const oldestSeq = messages.length > 0 ? messages[0].seq : 0;
			sink.push("s2c.session.tail", {
				sessionId,
				messages,
				oldestSeq,
				hasMore: Boolean(result.hasMore)
			});
			this.deriveTitleFallback(sessionId, messages);
			return true;
		} catch {
			return false;
		}
	}
	async historyPage(sink, sessionId, beforeSeq, limit) {
		try {
			const response = await this.apiProxy.sessions.history({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					beforeSeq,
					maxMessages: clampTail(limit)
				}
			});
			if (!response.result || !response.result.ok) return false;
			const result = response.result.value;
			const messages = projectHistory(result.events ?? []);
			sink.push("s2c.history.page", {
				sessionId,
				messages,
				hasMore: Boolean(result.hasMore)
			});
			return true;
		} catch {
			return false;
		}
	}
	/** Result of one attachment read-back for the phone. */
	async attachmentData(sessionId, attachmentId) {
		const read = this.apiProxy.sessions.attachment;
		if (typeof read !== "function") return null;
		try {
			const response = await read.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: {
					sessionId,
					attachmentId
				}
			});
			if (!response.result || !response.result.ok) return null;
			const data = response.result.value.data;
			if (typeof data !== "string" || data.length === 0) return null;
			return {
				...typeof response.result.value.attachment?.mediaType === "string" ? { mediaType: response.result.value.attachment.mediaType } : {},
				data
			};
		} catch {
			return null;
		}
	}
	async sessionModels(sessionId) {
		const models = this.apiProxy.sessions.models;
		if (typeof models !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "model catalog unavailable on this host version"
		};
		try {
			const response = await models.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "model catalog returned no result"
			};
			if (!response.result.ok) return hostModelError(response.result.error);
			return {
				ok: true,
				value: projectSessionModels(response.result.value)
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async selectSessionModel(sessionId, selection) {
		const selectModel = this.apiProxy.sessions.selectModel;
		if (typeof selectModel !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "model selection unavailable on this host version"
		};
		try {
			const response = await selectModel.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: {
					sessionId,
					provider: selection.provider,
					model: selection.model,
					...selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}
				}
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "model selection returned no result"
			};
			if (!response.result.ok) return hostModelError(response.result.error);
			return {
				ok: true,
				value: { ...response.result.value.selected }
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async renameSession(sessionId, title) {
		const rename = this.apiProxy.sessions.rename;
		if (typeof rename !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "session rename unavailable on this host version"
		};
		try {
			const response = await rename.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: {
					sessionId,
					title
				}
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "session rename returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			const acceptedTitle = String(response.result.value.title);
			const row = this.summaries.get(sessionId);
			if (row) {
				row.title = acceptedTitle;
				this.pushSummary(row);
			}
			return {
				ok: true,
				value: acceptedTitle
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async archiveSession(sessionId) {
		const archive = this.apiProxy.workspace?.archiveSession;
		if (typeof archive !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "session archive unavailable on this host version"
		};
		try {
			const response = await archive.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "session archive returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			this.archivedSessionIds = new Set((response.result.value.archivedSessionIds ?? []).map(String));
			this.summaries.delete(sessionId);
			this.lastAssistantText.delete(sessionId);
			this.record("s2c.sessions.delta", {
				upserted: [],
				removedIds: [sessionId]
			});
			return {
				ok: true,
				value: true
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async cancelSession(sessionId) {
		const cancel = this.apiProxy.sessions.cancel;
		if (typeof cancel !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "session cancel unavailable on this host version"
		};
		try {
			const response = await cancel.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "session cancel returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			return {
				ok: true,
				value: true
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async listWorkspaces() {
		const list = this.apiProxy.workspace?.list;
		if (typeof list !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "workspace list unavailable on this host version"
		};
		try {
			const response = await list.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: {}
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "workspace list returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			return {
				ok: true,
				value: (response.result.value.items ?? []).map(projectWorkspace)
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async createWorkspace(path) {
		const create = this.apiProxy.workspace?.create;
		if (typeof create !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "workspace create unavailable on this host version"
		};
		try {
			const response = await create.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: { path }
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "workspace create returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			await this.refreshSummaries();
			return {
				ok: true,
				value: {
					workspace: projectWorkspace(response.result.value.workspace),
					created: response.result.value.created === true
				}
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async listDirectory(path) {
		const list = this.apiProxy.host?.listDirectory;
		if (typeof list !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "directory browsing unavailable on this host version"
		};
		try {
			const response = await list.call(this.apiProxy.host, {
				rpcId: randomUUID(),
				payload: path && path.trim().length > 0 ? { path } : {}
			}, this.abort.signal);
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "directory list returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			return {
				ok: true,
				value: response.result.value
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async pickDirectory() {
		const pick = this.apiProxy.host?.pickDirectory;
		if (typeof pick !== "function") return {
			ok: false,
			kind: "unsupported",
			message: "native directory picker unavailable on this host version"
		};
		try {
			const response = await pick.call(this.apiProxy.host, {
				rpcId: randomUUID(),
				payload: {}
			}, this.abort.signal);
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "directory picker returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			return {
				ok: true,
				value: response.result.value.path
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	/** Create a fresh blank session in an existing workspace or legacy cwd. */
	async createSession(destination = {}) {
		try {
			const response = await this.apiProxy.sessions.create({
				rpcId: randomUUID(),
				payload: {
					...destination.workspaceId?.trim() ? { workspaceId: destination.workspaceId.trim() } : {},
					...destination.cwd?.trim() ? { cwd: destination.cwd.trim() } : {}
				}
			});
			if (!response.result || !response.result.ok) return null;
			const sessionId = response.result.value.sessionId;
			await this.refreshSummaries();
			return sessionId;
		} catch {
			return null;
		}
	}
	async sendPrompt(sessionId, text, images = []) {
		try {
			const content = [];
			if (text.trim().length > 0) content.push({
				type: "text",
				text
			});
			for (const image of images) content.push({
				type: "image",
				...image
			});
			const response = await this.apiProxy.sessions.prompt({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					mode: "queue",
					content,
					clientTimeZone: localTimeZone()
				}
			});
			if (!response.result) return {
				ok: false,
				kind: "internal",
				message: "prompt returned no result"
			};
			if (!response.result.ok) return hostSessionManagementError(response.result.error);
			const row = this.summaries.get(sessionId);
			if (row) {
				row.lastActivityTs = Date.now();
				this.pushSummary(row);
			}
			this.userReceiptSeq += 1;
			return {
				ok: true,
				value: this.userReceiptSeq
			};
		} catch (error) {
			return {
				ok: false,
				kind: "internal",
				message: String(error)
			};
		}
	}
	async respondApproval(requestId, decision, reason) {
		const pending = this.approvals.get(requestId);
		if (!pending) return {
			ok: false,
			reason: "not-pending"
		};
		this.approvals.delete(requestId);
		const outcome = decision === "allow" ? "allowed-once" : "rejected";
		const denialReason = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
		try {
			const receipt = await this.apiProxy.respond({
				type: "client-response",
				rpcId: pending.rpcId,
				result: {
					ok: true,
					value: {
						sessionId: pending.sessionId,
						approvalId: requestId,
						outcome,
						...denialReason.length > 0 ? { reason: denialReason } : {}
					}
				}
			});
			if (!Boolean(receipt?.accepted)) {
				const failure = receiptFailureReason(receipt);
				if (failure !== "not-pending" && !this.approvals.has(requestId)) this.approvals.set(requestId, pending);
				return {
					ok: false,
					reason: failure
				};
			}
			this.bumpPendingFlags(pending.sessionId);
			return { ok: true };
		} catch {
			if (!this.approvals.has(requestId)) this.approvals.set(requestId, pending);
			return {
				ok: false,
				reason: "transport"
			};
		}
	}
	async respondQuestion(requestId, answers) {
		const pending = this.questions.get(requestId);
		if (!pending) return {
			ok: false,
			reason: "not-pending"
		};
		this.questions.delete(requestId);
		try {
			const receipt = await this.apiProxy.respond({
				type: "client-response",
				rpcId: pending.rpcId,
				result: {
					ok: true,
					value: {
						sessionId: pending.sessionId,
						answer: { answers: normalizeAnswerItems(answers, pending.questions) }
					}
				}
			});
			if (!Boolean(receipt?.accepted)) {
				const failure = receiptFailureReason(receipt);
				if (failure !== "not-pending" && !this.questions.has(requestId)) this.questions.set(requestId, pending);
				return {
					ok: false,
					reason: failure
				};
			}
			this.bumpPendingFlags(pending.sessionId);
			return { ok: true };
		} catch {
			if (!this.questions.has(requestId)) this.questions.set(requestId, pending);
			return {
				ok: false,
				reason: "transport"
			};
		}
	}
};
/**
* The host validates question answers strictly (core dsh-user-questions via
* apiProxy): a present-but-empty `custom` fails `matchesQuestions`, and a
* single-select question rejects `custom` combined with a selection. Clients
* may send lenient shapes (the phone historically always attached
* `"custom": ""`, which made EVERY option-only answer fail), so normalize to
* exactly what the host accepts before forwarding.
*/
function normalizeAnswerItems(raw, questions) {
	if (!Array.isArray(raw)) return [];
	const askedById = /* @__PURE__ */ new Map();
	if (Array.isArray(questions)) {
		for (const q of questions) if (typeof q === "object" && q !== null && typeof q.id === "string") askedById.set(q.id, q);
	}
	const items = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const r = entry;
		if (typeof r.id !== "string") continue;
		const selected = [...new Set(Array.isArray(r.selected) ? r.selected.filter((s) => typeof s === "string") : [])];
		const customText = typeof r.custom === "string" ? r.custom : "";
		let custom;
		if (customText.trim().length > 0) custom = customText;
		if (custom !== void 0 && selected.length > 0 && askedById.get(r.id)?.multiSelect !== true) custom = void 0;
		items.push({
			id: r.id,
			selected,
			...custom !== void 0 ? { custom } : {}
		});
	}
	return items;
}
/** Map an apiProxy respond receipt onto the failure vocabulary. */
function receiptFailureReason(receipt) {
	return receipt?.reason === "not-pending" ? "not-pending" : "bad-response";
}
function clampTail(n) {
	if (!Number.isFinite(n)) return 100;
	return Math.max(10, Math.min(500, Math.floor(n)));
}
function localTimeZone() {
	try {
		return new Intl.DateTimeFormat().resolvedOptions().timeZone || void 0;
	} catch {
		return;
	}
}
function riskOf(toolName) {
	if (/bash|pwsh|terminal/.test(toolName)) return "write";
	if (/edit|write|str_replace|create/.test(toolName)) return "write";
	if (/delete|remove|kill/.test(toolName)) return "destructive";
	return "read";
}
/** First question's text for the push banner; the questions payload shape is
* host-version dependent, so extract defensively. */
function firstQuestionText(questions) {
	if (!Array.isArray(questions) || questions.length === 0) return "Agent 等待你的输入";
	const first = questions[0];
	return String(first?.question ?? "").trim() || "Agent 等待你的输入";
}
const TODO_STATUSES = /* @__PURE__ */ new Set([
	"pending",
	"in_progress",
	"completed"
]);
/** Validate a host todo projection once; progress counts and the full
* checklist both derive from this sanitized list so they never disagree. */
function sanitizeTodoItems(items) {
	if (!items) return [];
	return items.map((i) => ({
		content: String(i.content ?? "").trim(),
		status: String(i.status ?? "")
	})).filter((i) => i.content.length > 0 && TODO_STATUSES.has(i.status)).slice(0, 100).map((i) => ({
		content: i.content,
		status: i.status
	}));
}
function toSummary(row, approvals, questions, workspace) {
	const values = row.projections?.values ?? {};
	const todos = Array.isArray(values.todos) ? values.todos : null;
	let pendingApproval = false;
	for (const pending of approvals.values()) if (pending.sessionId === row.sessionId) pendingApproval = true;
	let pendingQuestion = false;
	for (const pending of questions.values()) if (pending.sessionId === row.sessionId) pendingQuestion = true;
	const cwd = typeof row.cwd === "string" ? row.cwd : "";
	const label = workspace?.title ?? (cwd ? cwd.split("/").filter(Boolean).pop() : void 0);
	const todoItems = sanitizeTodoItems(todos);
	return {
		id: row.sessionId,
		title: typeof values.title === "string" ? values.title : "",
		status: row.running ? "running" : "idle",
		lastActivityTs: Number(row.updatedAt ?? Date.now()),
		todos: todoItems.length > 0 ? {
			done: todoItems.filter((i) => i.status === "completed").length,
			total: todoItems.length
		} : null,
		todoItems: todoItems.length > 0 ? todoItems : null,
		pendingApproval,
		pendingQuestion,
		workspaceLabel: label ?? null,
		workspaceId: workspace?.workspaceId ?? null,
		workspacePath: workspace?.path ?? (cwd || null)
	};
}
function projectWorkspace(workspace) {
	return {
		id: String(workspace.workspaceId),
		title: String(workspace.title),
		path: String(workspace.path),
		sessionIds: (workspace.sessionIds ?? []).map(String)
	};
}
/** Project one raw session event into a protocol push, when it maps to one. */
function projectEvent(sessionId, event) {
	switch (event.type) {
		case "turn/start": return {
			kind: "turn.start",
			data: {}
		};
		case "turn/end": return {
			kind: "turn.end",
			data: { ok: event.data?.reason?.kind === "completed" }
		};
		case "user/message": return {
			kind: "message.final",
			data: { ...limitMessageProjection({
				seq: event.seq,
				role: userRoleOf(event.data),
				text: messageText(event.data),
				...attachmentProjection(event.data),
				...contextProjectionOf(event.data),
				ts: tsOf(event)
			}) }
		};
		case "assistant/chunk":
			if (chunkTypeOf(event.data) === "reasoning-delta") return {
				kind: "thinking.delta",
				data: limitRealtimeText({
					text: chunkText(event.data),
					ts: tsOf(event)
				})
			};
			return {
				kind: "message.delta",
				data: limitRealtimeText({
					text: chunkText(event.data),
					ts: tsOf(event)
				})
			};
		case "assistant/message": {
			const text = messageText(event.data);
			const thinking = messageThinking(event.data);
			if (!text.trim() && !thinking.trim()) return null;
			return {
				kind: "message.final",
				data: { ...limitMessageProjection({
					seq: event.seq,
					role: "assistant",
					text,
					...thinking ? { thinking } : {},
					ts: tsOf(event)
				}) }
			};
		}
		case "tool/call": {
			const data = event.data;
			return {
				kind: "tool.start",
				data: {
					seq: event.seq,
					role: "tool",
					tool: {
						name: String(data?.name ?? "tool"),
						state: "running",
						summary: summarizeArgs(data?.arguments),
						...data?.callId ? { callId: String(data.callId) } : {}
					},
					ts: tsOf(event)
				}
			};
		}
		case "tool/result": {
			const data = event.data;
			return {
				kind: "tool.end",
				data: {
					seq: event.seq,
					role: "tool",
					ok: !event.data || data?.error === void 0,
					...data?.callId ? { callId: String(data.callId) } : {},
					ts: tsOf(event)
				}
			};
		}
		default: return null;
	}
}
function tsOf(event) {
	return typeof event.time === "number" ? event.time : Date.now();
}
/** Read the durable message source off one user/message payload. Handles both
* bare-message payloads and older `{message: {...}}` wrappers; undefined when
* the shape carries no readable source (legacy hosts). */
function userMessageSource(data) {
	if (!data || typeof data !== "object") return void 0;
	const obj = data;
	if (obj.source && typeof obj.source === "object") return obj.source;
	if (obj.message && typeof obj.message === "object" && obj.message.source && typeof obj.message.source === "object") return obj.message.source;
}
/** Wire role for one user/message payload. A payload without any readable
* source degrades to 'user' so history written by older hosts stays visible;
* a present source follows the host's own trajectory rule — anything whose
* `kind` is not 'user' is injected context and projects as 'system'. */
function userRoleOf(data) {
	const source = userMessageSource(data);
	if (!source) return "user";
	return source.kind === "user" ? "user" : "system";
}
/** Producer name of one injected-context source, mirroring how the DSH client
* runtime derives its trajectory label: plugin name, skill name, instruction
* paths, session-reference labels, or the raw kind as fallback. */
function contextLabelOf(source) {
	const kind = typeof source.kind === "string" ? source.kind : "";
	const joined = (member) => {
		const list = source[member];
		if (!Array.isArray(list)) return void 0;
		const names = list.flatMap((entry) => {
			if (!entry || typeof entry !== "object") return [];
			const record = entry;
			return [typeof record.label === "string" ? record.label : typeof record.path === "string" ? record.path : ""];
		}).filter((name) => name.length > 0);
		return names.length > 0 ? names.join(", ") : void 0;
	};
	switch (kind) {
		case "session-reference": return joined("references") ?? (kind || void 0);
		case "agent-instructions": return joined("changes") ?? (kind || void 0);
		case "plugin": return typeof source.plugin === "string" && source.plugin.length > 0 ? source.plugin : kind || void 0;
		case "skill-invocation": return typeof source.name === "string" && source.name.length > 0 ? source.name : kind || void 0;
		default: return kind || void 0;
	}
}
/** Semantic ContextForm declared by the producer ('snapshot', 'notice', …);
* anything unrecognized stays undefined so clients render it opaque. */
function contextFormOf(source) {
	if (typeof source.form !== "string" || source.form.length === 0) return void 0;
	return [
		"instructions",
		"catalog",
		"snapshot",
		"notice",
		"relay",
		"recall"
	].includes(source.form) ? source.form : void 0;
}
/** Optional `context` metadata for one system row; {} on user rows. */
function contextProjectionOf(data) {
	if (userRoleOf(data) !== "system") return {};
	const source = userMessageSource(data);
	if (!source) return {};
	const label = contextLabelOf(source);
	const form = contextFormOf(source);
	if (!label && !form) return {};
	return { context: {
		...label ? { label } : {},
		...form ? { form } : {}
	} };
}
/** Extract plain text from user/assistant message payloads across shapes. */
function messageText(data) {
	if (typeof data === "string") return data;
	if (!data || typeof data !== "object") return "";
	const obj = data;
	if (typeof obj.text === "string") return obj.text;
	if (obj.message && typeof obj.message === "object") return messageText(obj.message);
	return contentText(obj.content);
}
function contentText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => {
		if (typeof part === "string") return part;
		if (part && typeof part === "object") {
			const piece = part;
			if (piece.type === "text" && typeof piece.text === "string") return piece.text;
		}
		return "";
	}).join("");
	return "";
}
function messageAttachments(data) {
	if (!data || typeof data !== "object") return [];
	const obj = data;
	if (obj.message && typeof obj.message === "object") return messageAttachments(obj.message);
	if (!Array.isArray(obj.content)) return [];
	return obj.content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const block = part;
		if (block.type !== "image" || !block.attachment) return [];
		const attachmentId = typeof block.attachment.attachmentId === "string" && block.attachment.attachmentId.length > 0 ? block.attachment.attachmentId : void 0;
		const width = typeof block.attachment.width === "number" && Number.isFinite(block.attachment.width) ? block.attachment.width : void 0;
		const height = typeof block.attachment.height === "number" && Number.isFinite(block.attachment.height) ? block.attachment.height : void 0;
		return [{
			kind: "image",
			...typeof block.attachment.name === "string" ? { name: block.attachment.name } : {},
			...typeof block.attachment.mediaType === "string" ? { mediaType: block.attachment.mediaType } : {},
			...attachmentId ? { attachmentId } : {},
			...width !== void 0 ? { width } : {},
			...height !== void 0 ? { height } : {}
		}];
	});
}
function attachmentProjection(data) {
	const attachments = messageAttachments(data);
	return attachments.length > 0 ? { attachments } : {};
}
/** Extract reasoning ("thinking") text from assistant message payloads. */
function messageThinking(data) {
	if (!data || typeof data !== "object") return "";
	const obj = data;
	if (obj.message && typeof obj.message === "object") return messageThinking(obj.message);
	return reasoningContent(obj.content);
}
function reasoningContent(content) {
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (part && typeof part === "object") {
			const piece = part;
			if (piece.type === "reasoning" && typeof piece.text === "string") return piece.text;
		}
		return "";
	}).join("");
}
/** Stream chunk type of an assistant/chunk payload ('' when unwrapped). */
function chunkTypeOf(data) {
	if (!data || typeof data !== "object") return "";
	const obj = data;
	if (obj.chunk && typeof obj.chunk === "object") return String(obj.chunk.type ?? "");
	return "text-delta";
}
function chunkText(data) {
	if (!data || typeof data !== "object") return "";
	const obj = data;
	if (obj.chunk && typeof obj.chunk === "object") {
		const inner = obj.chunk;
		if ((inner.type === "text-delta" || inner.type === "reasoning-delta") && typeof inner.text === "string") return inner.text;
		return "";
	}
	const direct = data;
	return typeof direct.text === "string" ? direct.text : "";
}
function summarizeArgs(raw) {
	if (typeof raw !== "string" || raw.length === 0) return "";
	try {
		const parsed = JSON.parse(raw);
		const parts = [];
		for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") parts.push(key + "=" + truncate(value.replace(/\s+/g, " "), 60));
		return truncate(parts.join(" "), 90);
	} catch {
		return truncate(raw, 90);
	}
}
function truncate(text, max) {
	return text.length <= max ? text : text.slice(0, max - 1) + "…";
}
function hostModelError(error) {
	const message = error.message ?? error.code;
	switch (error.code) {
		case "session-not-found": return {
			ok: false,
			kind: "not-found",
			message
		};
		case "agent-busy":
		case "session-conflict": return {
			ok: false,
			kind: "busy",
			message
		};
		case "model-unavailable": return {
			ok: false,
			kind: "unavailable",
			message
		};
		default: return {
			ok: false,
			kind: "internal",
			message
		};
	}
}
function hostSessionManagementError(error) {
	const message = error.message ?? error.code;
	switch (error.code) {
		case "session-not-found": return {
			ok: false,
			kind: "not-found",
			message
		};
		case "agent-busy":
		case "session-conflict": return {
			ok: false,
			kind: "busy",
			message
		};
		case "title-invalid":
		case "workspace-invalid-path":
		case "workspace-name-conflict":
		case "directory-unreadable":
		case "directory-exists":
		case "directory-create-failed": return {
			ok: false,
			kind: "invalid",
			message
		};
		case "directory-picker-unavailable": return {
			ok: false,
			kind: "unsupported",
			message
		};
		case "workspace-not-found": return {
			ok: false,
			kind: "not-found",
			message
		};
		default: return {
			ok: false,
			kind: "internal",
			message
		};
	}
}
function projectSessionModels(value) {
	return {
		current: {
			provider: String(value.current.provider),
			model: String(value.current.model),
			...value.current.reasoningEffort ? { reasoningEffort: String(value.current.reasoningEffort) } : {}
		},
		routable: value.routable === true,
		groups: (value.groups ?? []).map((group) => ({
			id: String(group.id),
			name: String(group.name),
			models: (group.models ?? []).map((model) => ({
				id: String(model.id),
				name: String(model.name),
				...model.description ? { description: String(model.description) } : {},
				...model.reasoning ? { reasoning: {
					efforts: (model.reasoning.efforts ?? []).map((effort) => ({
						id: String(effort.id),
						name: String(effort.name),
						...effort.description ? { description: String(effort.description) } : {}
					})),
					...model.reasoning.defaultEffort ? { defaultEffort: String(model.reasoning.defaultEffort) } : {}
				} } : {}
			}))
		})),
		failures: (value.failures ?? []).map((failure) => ({
			id: String(failure.id),
			name: String(failure.name),
			message: String(failure.message)
		}))
	};
}
/** Project a history page (raw events) into MessageProjection rows. */
function projectHistory(events) {
	const messages = [];
	const toolByCall = /* @__PURE__ */ new Map();
	for (const entry of events) {
		const event = entry.event;
		const base = {
			seq: event.seq,
			ts: tsOf(event)
		};
		switch (event.type) {
			case "user/message":
				messages.push({
					...base,
					role: userRoleOf(event.data),
					text: messageText(event.data),
					...attachmentProjection(event.data),
					...contextProjectionOf(event.data)
				});
				break;
			case "assistant/message": {
				const text = messageText(event.data);
				const thinking = messageThinking(event.data);
				if (!text.trim() && !thinking.trim()) break;
				messages.push({
					...base,
					role: "assistant",
					text,
					...thinking ? { thinking } : {}
				});
				break;
			}
			case "tool/call": {
				const data = event.data;
				const row = {
					...base,
					role: "tool",
					tool: {
						name: String(data?.name ?? "tool"),
						state: "running",
						summary: summarizeArgs(data?.arguments)
					}
				};
				messages.push(row);
				if (data?.callId) toolByCall.set(String(data.callId), row);
				break;
			}
			case "tool/result": {
				const data = event.data;
				const callId = data?.callId ? String(data.callId) : void 0;
				const target = callId ? toolByCall.get(callId) : void 0;
				const failed = data?.error !== void 0;
				const summary = failed ? "失败" : summarizeResult(data?.message?.content);
				if (target?.tool) target.tool = {
					...target.tool,
					state: failed ? "error" : "ok",
					summary
				};
				else messages.push({
					...base,
					role: "tool",
					tool: {
						name: "result",
						state: failed ? "error" : "ok",
						summary
					}
				});
				break;
			}
		}
	}
	return messages.sort((a, b) => a.seq - b.seq).map(limitMessageProjection);
}
/**
* Enforce PROTOCOL.md's per-message 256 KB ceiling by UTF-8 JSON byte size.
* Keep structural identity and attachment references intact; progressively
* shorten human-readable fields until the serialized projection fits.
*/
function limitMessageProjection(message) {
	if (jsonBytes(message) <= 262144) return message;
	const next = {
		...message,
		...message.tool ? { tool: {
			...message.tool,
			name: truncateUtf8(message.tool.name, 4096),
			summary: truncateUtf8(message.tool.summary, 65536)
		} } : {},
		...message.attachments ? { attachments: message.attachments.slice(0, 16).map((attachment) => ({
			...attachment,
			...attachment.name ? { name: truncateUtf8(attachment.name, 4096) } : {},
			...attachment.mediaType ? { mediaType: truncateUtf8(attachment.mediaType, 256) } : {},
			...attachment.attachmentId ? { attachmentId: truncateUtf8(attachment.attachmentId, 4096) } : {}
		})) } : {},
		...message.context ? { context: {
			...message.context.label ? { label: truncateUtf8(message.context.label, 8192) } : {},
			...message.context.form ? { form: truncateUtf8(message.context.form, 256) } : {}
		} } : {},
		truncated: true
	};
	const textFields = [];
	if (typeof next.text === "string") textFields.push({
		get: () => next.text ?? "",
		set: (value) => {
			next.text = value;
		}
	});
	if (typeof next.thinking === "string") textFields.push({
		get: () => next.thinking ?? "",
		set: (value) => {
			next.thinking = value;
		}
	});
	if (next.tool) textFields.push({
		get: () => next.tool?.summary ?? "",
		set: (value) => {
			if (next.tool) next.tool.summary = value;
		}
	});
	if (next.context?.label) textFields.push({
		get: () => next.context?.label ?? "",
		set: (value) => {
			if (next.context) next.context.label = value;
		}
	});
	while (jsonBytes(next) > MAX_MESSAGE_PROJECTION_BYTES) {
		const largest = textFields.map((field) => ({
			field,
			bytes: Buffer.byteLength(field.get(), "utf8")
		})).sort((a, b) => b.bytes - a.bytes)[0];
		if (largest && largest.bytes > 0) {
			largest.field.set(truncateUtf8(largest.field.get(), Math.floor(largest.bytes / 2)));
			continue;
		}
		if (next.attachments && next.attachments.length > 0) {
			next.attachments = next.attachments.slice(0, -1);
			continue;
		}
		break;
	}
	return next;
}
function limitRealtimeText(data) {
	if (jsonBytes(data) <= 262144) return data;
	let text = data.text;
	const next = {
		...data,
		truncated: true
	};
	while (jsonBytes(next) > 262144 && text.length > 0) {
		text = truncateUtf8(text, Math.floor(Buffer.byteLength(text, "utf8") / 2));
		next.text = text;
	}
	return next;
}
function jsonBytes(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function truncateUtf8(value, maxBytes) {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const candidate = value.slice(0, mid);
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	let end = low;
	if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
	return value.slice(0, end);
}
function summarizeResult(content) {
	return truncate(contentText(content).replace(/\s+/g, " ").trim(), 90);
}
//#endregion
//#region src/report-service.ts
/**
* The Typert receiver the Gateway resolves for the DeepPilot Bridge report.
* Snapshot data stays non-secret; the token crosses the boundary only through
* the explicit, user-triggered revealToken/rotateToken invocations.
*/
var DeepPilotReportService = class extends TypertRemoteService {
	snapshot;
	pairingToken;
	rotatePairingToken;
	relayTester;
	pushTester;
	constructor(ctx, snapshot, pairingToken, rotatePairingToken, relayTester, pushTester) {
		super(ctx, "deeppilotReport", { namespace: "deeppilot" });
		this.snapshot = snapshot;
		this.pairingToken = pairingToken;
		this.rotatePairingToken = rotatePairingToken;
		this.relayTester = relayTester;
		this.pushTester = pushTester;
	}
	async report() {
		return this.snapshot();
	}
	async revealToken() {
		return this.pairingToken();
	}
	async rotateToken() {
		return this.rotatePairingToken();
	}
	async testRelay() {
		return this.relayTester();
	}
	async testPush() {
		return this.pushTester();
	}
};
//#endregion
//#region src/report-wire.ts
/** The npm package identity both contribution registrations claim. */
const REPORT_REMOTE_PACKAGE = "dsh-deeppilot";
/** Canonical `<namespace>/<method>` endpoint of the report Remote. */
const REPORT_ENDPOINT = "deeppilot/report";
/** Explicit, user-triggered endpoint for revealing the pairing secret. */
const REVEAL_TOKEN_ENDPOINT = "deeppilot/revealToken";
/**
* Explicit, user-triggered endpoint that replaces the pairing secret. The old
* token stops working immediately; the fresh one is returned so the page can
* show/QR it right away.
*/
const ROTATE_TOKEN_ENDPOINT = "deeppilot/rotateToken";
function reject(field) {
	throw new TypeError(`deeppilot/report result: invalid ${field}`);
}
function str(source, key, field) {
	const value = source[key];
	if (typeof value !== "string") reject(field);
	return value;
}
/**
* Non-negative integer: counters and timestamps (activeConnections,
* historyBufferMax, updatedAt, lastSeenTs, protocolVersion, etc.). A bare
* `typeof number` check accepts 1.5, -1, and 1e20 — all of which then
* surface verbatim on the settings page and break any sort or arithmetic
* the UI does.
*/
function int(source, key, field) {
	const value = source[key];
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) reject(field);
	return value;
}
function bool(source, key, field) {
	const value = source[key];
	if (typeof value !== "boolean") reject(field);
	return value;
}
function rec(value, field) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) reject(field);
	return value;
}
function parseDevice(value) {
	const s = rec(value, "device");
	let apns;
	if (s.apns !== void 0) {
		const a = rec(s.apns, "device.apns");
		const environment = str(a, "environment", "device.apns.environment");
		if (environment !== "development" && environment !== "production") reject("device.apns.environment");
		apns = {
			environment,
			updatedAt: int(a, "updatedAt", "device.apns.updatedAt")
		};
	}
	return {
		deviceId: str(s, "deviceId", "device.deviceId"),
		deviceName: str(s, "deviceName", "device.deviceName"),
		appVersion: str(s, "appVersion", "device.appVersion"),
		firstSeenTs: int(s, "firstSeenTs", "device.firstSeenTs"),
		lastSeenTs: int(s, "lastSeenTs", "device.lastSeenTs"),
		...apns ? { apns } : {}
	};
}
function parseRemote(value) {
	const s = rec(value, "remote");
	const provider = str(s, "provider", "remote.provider");
	const phase = str(s, "phase", "remote.phase");
	if (provider !== "tailscale-funnel") reject("remote.provider");
	if (![
		"disabled",
		"starting",
		"login_required",
		"online",
		"error",
		"unavailable",
		"stopped"
	].includes(phase)) reject("remote.phase");
	const publicURL = s.publicURL;
	const authURL = s.authURL;
	const message = s.message;
	if (publicURL !== void 0 && typeof publicURL !== "string") reject("remote.publicURL");
	if (authURL !== void 0 && typeof authURL !== "string") reject("remote.authURL");
	if (message !== void 0 && typeof message !== "string") reject("remote.message");
	return {
		provider,
		phase,
		...typeof publicURL === "string" ? { publicURL } : {},
		...typeof authURL === "string" ? { authURL } : {},
		...typeof message === "string" ? { message } : {},
		updatedAt: int(s, "updatedAt", "remote.updatedAt")
	};
}
function parseRelayTestStep(value) {
	const st = rec(value, "step");
	const id = str(st, "id", "step.id");
	if (id !== "health" && id !== "enroll") reject("step.id");
	const latencyMs = st.latencyMs;
	if (latencyMs !== void 0) {
		if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || !Number.isInteger(latencyMs) || latencyMs < 0) reject("step.latencyMs");
	}
	return {
		id,
		ok: bool(st, "ok", "step.ok"),
		message: str(st, "message", "step.message"),
		...typeof latencyMs === "number" ? { latencyMs } : {}
	};
}
function parseRelayTestResult(value) {
	const s = rec(value, "result");
	const overall = str(s, "overall", "overall");
	if (overall !== "ok" && overall !== "failed") reject("overall");
	const stepsRaw = s.steps;
	if (!Array.isArray(stepsRaw)) reject("steps");
	return {
		url: str(s, "url", "url"),
		overall,
		tokenIssued: bool(s, "tokenIssued", "tokenIssued"),
		steps: stepsRaw.map(parseRelayTestStep)
	};
}
function parsePushTestResult(value) {
	const s = rec(value, "result");
	const transport = str(s, "transport", "transport");
	if (transport !== "apns" && transport !== "relay" && transport !== "none") reject("transport");
	const overall = str(s, "overall", "overall");
	if (![
		"sent",
		"failed",
		"no-targets",
		"not-configured"
	].includes(overall)) reject("overall");
	const resultsRaw = s.results;
	if (!Array.isArray(resultsRaw)) reject("results");
	const results = resultsRaw.map((value) => {
		const r = rec(value, "device result");
		const reason = r.reason;
		const tokenFingerprint = r.tokenFingerprint;
		return {
			name: str(r, "name", "result.name"),
			environment: str(r, "environment", "result.environment"),
			outcome: str(r, "outcome", "result.outcome"),
			...typeof reason === "string" && reason.length > 0 ? { reason } : {},
			...typeof tokenFingerprint === "string" && /^[0-9a-f]{10}$/.test(tokenFingerprint) ? { tokenFingerprint } : {}
		};
	});
	const message = s.message;
	return {
		transport,
		overall,
		...typeof message === "string" && message.length > 0 ? { message } : {},
		results
	};
}
function parseReport(value) {
	const s = rec(value, "report");
	const devices = s.devices;
	const lanAddresses = s.lanAddresses;
	if (!Array.isArray(devices)) reject("devices");
	if (!Array.isArray(lanAddresses) || lanAddresses.some((value) => typeof value !== "string")) reject("lanAddresses");
	const releaseUrl = s.releaseUrl;
	return {
		protocolVersion: int(s, "protocolVersion", "protocolVersion"),
		serverVersion: str(s, "serverVersion", "serverVersion"),
		pluginVersion: str(s, "pluginVersion", "pluginVersion"),
		...s.updateAvailable === true ? { updateAvailable: true } : {},
		...typeof releaseUrl === "string" && releaseUrl.length > 0 ? { releaseUrl } : {},
		enabled: bool(s, "enabled", "enabled"),
		tokenPath: str(s, "tokenPath", "tokenPath"),
		tokenReady: bool(s, "tokenReady", "tokenReady"),
		activeConnections: int(s, "activeConnections", "activeConnections"),
		historyBufferMax: int(s, "historyBufferMax", "historyBufferMax"),
		debug: bool(s, "debug", "debug"),
		lanAddresses,
		remote: parseRemote(s.remote),
		devices: devices.map(parseDevice)
	};
}
const reportSchema = { parse: parseReport };
const relayTestSchema = { parse: parseRelayTestResult };
const pushTestSchema = { parse: parsePushTestResult };
const pairingTokenSchema = { parse(value) {
	if (typeof value !== "string" || value.length < 32) throw new TypeError("deeppilot/revealToken result: invalid token");
	return value;
} };
const REPORT_HOST_CONTRIBUTION = {
	package: REPORT_REMOTE_PACKAGE,
	face: "host",
	schemas: [],
	invocations: [
		{
			id: `${REPORT_REMOTE_PACKAGE}#${REPORT_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "report",
			invocation: { kind: "direct" },
			parameters: [],
			result: {
				mode: "strict",
				typeSymbol: `${REPORT_REMOTE_PACKAGE}#DeepPilotReport`,
				schema: reportSchema
			}
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#${REVEAL_TOKEN_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "revealToken",
			invocation: { kind: "direct" },
			parameters: [],
			result: {
				mode: "strict",
				typeSymbol: `${REPORT_REMOTE_PACKAGE}#PairingToken`,
				schema: pairingTokenSchema
			}
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#${ROTATE_TOKEN_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "rotateToken",
			invocation: { kind: "direct" },
			parameters: [],
			result: {
				mode: "strict",
				typeSymbol: `${REPORT_REMOTE_PACKAGE}#PairingToken`,
				schema: pairingTokenSchema
			}
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#deeppilot/testRelay`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "testRelay",
			invocation: { kind: "direct" },
			parameters: [],
			result: {
				mode: "strict",
				typeSymbol: `${REPORT_REMOTE_PACKAGE}#RelayTestResult`,
				schema: relayTestSchema
			}
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#deeppilot/testPush`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "testPush",
			invocation: { kind: "direct" },
			parameters: [],
			result: {
				mode: "strict",
				typeSymbol: `${REPORT_REMOTE_PACKAGE}#PushTestResult`,
				schema: pushTestSchema
			}
		}
	]
};
//#endregion
//#region src/report-remote.ts
/**
* Provide the report service and register its Remote descriptor. Rides an
* optional `typert` inject: profiles without the web stack never activate it.
*/
function applyReportRemote(ctx, snapshot, pairingToken, rotatePairingToken, relayTester, pushTester) {
	ctx.inject(["typert"], (remoteCtx) => {
		new DeepPilotReportService(remoteCtx, snapshot, pairingToken, rotatePairingToken, relayTester, pushTester);
		const unregister = remoteCtx.typert.register(REPORT_HOST_CONTRIBUTION);
		remoteCtx.effect(() => () => void unregister(), "dsh-deeppilot: report remote");
	});
}
//#endregion
//#region src/relay-test.ts
const DEFAULT_TIMEOUT_MS = 6e3;
async function requestJson(fetchImpl, url, init, timeoutMs) {
	const response = await fetchImpl(url, {
		...init,
		signal: AbortSignal.timeout(timeoutMs)
	});
	let body = null;
	try {
		body = await response.json();
	} catch {}
	return {
		status: response.status,
		body
	};
}
async function runRelayProbe(options) {
	const base = options.url.trim().replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const steps = [];
	let tokenIssued = false;
	try {
		const startedAt = Date.now();
		const { status, body } = await requestJson(fetchImpl, `${base}/healthz`, { method: "GET" }, timeoutMs);
		const latencyMs = Date.now() - startedAt;
		if (status === 200 && body?.ok === true) steps.push({
			id: "health",
			ok: true,
			message: "中继服务可达",
			latencyMs
		});
		else steps.push({
			id: "health",
			ok: false,
			message: `中继响应异常（HTTP ${status}）`,
			latencyMs
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		steps.push({
			id: "health",
			ok: false,
			message: "无法连接中继：" + reason
		});
	}
	if (options.manualToken ?? false) steps.push({
		id: "enroll",
		ok: true,
		message: "已手动配置 relayToken，跳过注册验证"
	});
	else if (!options.enrollKey) steps.push({
		id: "enroll",
		ok: false,
		message: "尚无注册密钥：等待分发版 App 首次注册后才能验证注册"
	});
	else {
		const clientId = options.clientId ?? "u_" + Math.random().toString(36).slice(2);
		try {
			const startedAt = Date.now();
			const { status, body } = await requestJson(fetchImpl, `${base}/v1/enroll`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					clientId,
					enrollKey: options.enrollKey
				})
			}, timeoutMs);
			const latencyMs = Date.now() - startedAt;
			const token = body?.token;
			if (status === 200 && typeof token === "string" && token.startsWith("rl_")) {
				tokenIssued = true;
				options.onEnrolled?.(token);
				steps.push({
					id: "enroll",
					ok: true,
					message: "注册成功，已取得推送凭证",
					latencyMs
				});
			} else if (status === 403) steps.push({
				id: "enroll",
				ok: false,
				message: "注册被拒：注册密钥不匹配（检查 App 内 DSPushEnrollKey 与服务器 RELAY_ENROLL_KEY）",
				latencyMs
			});
			else if (status === 429) steps.push({
				id: "enroll",
				ok: false,
				message: "尝试过于频繁，稍后再试",
				latencyMs
			});
			else steps.push({
				id: "enroll",
				ok: false,
				message: `注册失败（HTTP ${status}）`,
				latencyMs
			});
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			steps.push({
				id: "enroll",
				ok: false,
				message: "注册请求失败：" + reason
			});
		}
	}
	return {
		url: base,
		overall: steps.length > 0 && steps.some((step) => step.id === "health" && step.ok) && steps.every((step) => step.ok) ? "ok" : "failed",
		tokenIssued,
		steps
	};
}
//#endregion
//#region src/apns.ts
/**
* Minimal APNs provider client (HTTP/2) with zero npm dependencies.
*
* Implements exactly what the bridge needs:
*  - ES256 provider token (JWT) signed with an Apple .p8 key, refreshed under
*    the 1-hour freshness window Apple enforces;
*  - one long-lived HTTP/2 session per environment, recreated transparently
*    after GOAWAY/errors;
*  - alert pushes carrying the notify projection (category/thread/collapse),
*    with `interruption-level: time-sensitive` for approval/question events;
*  - outcome classification so callers can prune dead device tokens.
*
* Privacy: logs carry outcomes and masked token prefixes only — never message
* bodies or full tokens.
*/
/** Classify Apple's reason without losing recoverable configuration errors. */
function classifyApnsReason(reason) {
	return reason === "Unregistered" || reason === "ExpiredToken" ? "invalid-token" : "failed";
}
const PROVIDER_TOKEN_TTL_MS = 3e6;
const REQUEST_TIMEOUT_MS = 1e4;
/** base64url without padding. */
function b64url(input) {
	return Buffer.from(input).toString("base64url");
}
/** Sign one ES256 JWT for the given signing input with a P-256 private key. */
function es256Jwt(signingInput, key) {
	const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
		key,
		dsaEncoding: "ieee-p1363"
	});
	return signingInput + "." + b64url(signature);
}
/** Strip PEM armor from a .p8 file and decode to PKCS#8 DER. */
function p8ToDer(pem) {
	const body = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
	return Buffer.from(body, "base64");
}
/** Pure payload builder so tests can assert the wire format without sockets. */
function apnsPayload(notification) {
	const timeSensitive = notification.category === "approval.required" || notification.category === "question.asked";
	return {
		aps: {
			alert: {
				title: notification.title.slice(0, 120),
				body: notification.body.slice(0, 200)
			},
			sound: "default",
			category: notification.category,
			"thread-id": notification.sessionId.slice(0, 64),
			...timeSensitive ? { "interruption-level": "time-sensitive" } : {}
		},
		sessionId: notification.sessionId,
		notificationId: notification.notificationId,
		kind: notification.category
	};
}
/** collapse-id accepts ≤64 bytes of ASCII; keep it stable per session+event. */
function collapseIdFor(notification) {
	const raw = `${notification.category}:${notification.sessionId}`;
	const readable = raw.replace(/[^a-zA-Z0-9.:-]/g, "");
	const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
	return `${readable.slice(0, 51)}:${digest}`;
}
function authorityFor(environment) {
	return environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com";
}
var ApnsClient = class {
	log;
	debug;
	opts;
	providerToken = "";
	providerTokenIssuedAt = 0;
	key;
	constructor(opts) {
		this.opts = opts;
		this.log = opts.log;
		this.debug = opts.debug === true;
	}
	async dispose() {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.filter((session) => !session.destroyed).map((session) => new Promise((resolve) => session.close(() => resolve()))));
	}
	async ensureProviderToken() {
		if (this.providerToken && Date.now() - this.providerTokenIssuedAt < PROVIDER_TOKEN_TTL_MS) return this.providerToken;
		if (!this.key) {
			const pem = await readFile(this.opts.keyPath, "utf8");
			this.key = createPrivateKey({
				key: p8ToDer(pem),
				format: "der",
				type: "pkcs8"
			});
		}
		const issuedAt = Math.floor(Date.now() / 1e3);
		const header = b64url(JSON.stringify({
			alg: "ES256",
			kid: this.opts.keyId
		}));
		const claims = b64url(JSON.stringify({
			iss: this.opts.teamId,
			iat: issuedAt
		}));
		this.providerToken = es256Jwt(`${header}.${claims}`, this.key);
		this.providerTokenIssuedAt = Date.now();
		return this.providerToken;
	}
	/** One long-lived HTTP/2 session per Apple host (sandbox + production). */
	sessions = /* @__PURE__ */ new Map();
	ensureSession(authority) {
		const existing = this.sessions.get(authority);
		if (existing && !existing.destroyed && !existing.closed) return existing;
		const session = connect(`https://${authority}`);
		session.on("error", (error) => {
			if (this.debug) this.log("apns session error (" + authority + "): " + String(error));
			this.sessions.delete(authority);
		});
		this.sessions.set(authority, session);
		return session;
	}
	/**
	* Deliver one alert. Never throws — every failure path resolves to an
	* outcome so fan-out loops cannot crash the host on a flaky network.
	*/
	async send(request) {
		const { deviceToken, environment, ...notification } = request;
		let stream;
		try {
			const token = await this.ensureProviderToken();
			const body = JSON.stringify(apnsPayload(notification));
			const session = this.ensureSession(authorityFor(environment));
			return await new Promise((resolve) => {
				const req = session.request({
					[":method"]: "POST",
					[":path"]: "/3/device/" + deviceToken,
					authorization: "bearer " + token,
					"apns-topic": this.opts.bundleId,
					"apns-push-type": "alert",
					"apns-priority": "10",
					"apns-expiration": String(Math.floor(Date.now() / 1e3) + 3600),
					"apns-collapse-id": collapseIdFor(notification),
					"content-type": "application/json",
					"content-length": String(Buffer.byteLength(body))
				});
				stream = req;
				let status = 0;
				let responseBody = "";
				const settle = (outcome, reason) => {
					if (this.debug) this.log(`apns ${outcome}${reason ? " (" + reason + ")" : ""} (${this.maskToken(deviceToken)})`);
					resolve(reason !== void 0 && reason !== "" ? {
						outcome,
						reason
					} : { outcome });
				};
				const timer = setTimeout(() => {
					req.close();
					settle("failed");
				}, REQUEST_TIMEOUT_MS);
				timer.unref?.();
				req.on("response", (headers) => {
					status = Number(headers[":status"] ?? 0);
				});
				req.on("data", (chunk) => {
					responseBody += chunk.toString("utf8");
				});
				req.on("error", () => {
					clearTimeout(timer);
					settle("failed");
				});
				req.on("end", () => {
					clearTimeout(timer);
					if (status === 200) return settle("sent");
					let reason = "";
					try {
						reason = String(JSON.parse(responseBody).reason ?? "");
					} catch {}
					if (status !== 200 && !reason) reason = "HTTP " + String(status);
					const outcome = classifyApnsReason(reason);
					if (outcome === "invalid-token") return settle(outcome, reason);
					if (this.debug) this.log(`apns rejected status=${status} reason=${reason}`);
					settle("failed", reason);
				});
				req.end(body);
			});
		} catch (error) {
			this.key = void 0;
			this.providerToken = "";
			this.sessions.clear();
			if (this.debug) this.log("apns send failed: " + String(error));
			return {
				outcome: "failed",
				reason: String(error).slice(0, 120)
			};
		} finally {
			try {
				stream?.close();
			} catch {}
		}
	}
	maskToken(token) {
		return token.length <= 10 ? "…" : token.slice(0, 6) + "…" + token.slice(-4);
	}
};
//#endregion
//#region src/relay-client.ts
var RelayClient = class {
	base;
	token;
	timeoutMs;
	debug;
	log;
	constructor(opts) {
		this.base = opts.url.trim().replace(/\/+$/, "");
		this.token = (opts.token ?? "").trim();
		this.timeoutMs = opts.timeoutMs ?? 1e4;
		this.debug = opts.debug === true;
		this.log = opts.log;
	}
	/**
	* Zero-touch enrollment: exchange the distributor's shared key (baked into
	* the distributed app) for a stable per-bridge bearer token. Idempotent —
	* relays derive the same token for the same clientId. Returns null on any
	* failure; callers treat that as "not enrolled yet", not as an error.
	*/
	async enroll(clientId, enrollKey) {
		try {
			const response = await fetch(this.base + "/v1/enroll", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					clientId,
					enrollKey
				}),
				signal: AbortSignal.timeout(this.timeoutMs)
			});
			if (!response.ok) {
				if (this.debug) this.log(`enroll http ${response.status}`);
				return null;
			}
			const body = await response.json();
			if (typeof body.token === "string" && body.token.startsWith("rl_")) return body.token;
			if (this.debug) this.log("enroll returned no usable token");
			return null;
		} catch (error) {
			if (this.debug) this.log("enroll failed: " + String(error));
			return null;
		}
	}
	async send(request) {
		try {
			const response = await fetch(this.base + "/v1/push", {
				method: "POST",
				headers: {
					authorization: "Bearer " + this.token,
					"content-type": "application/json"
				},
				body: JSON.stringify({
					deviceToken: request.deviceToken,
					environment: request.environment,
					notification: request.notification
				}),
				signal: AbortSignal.timeout(this.timeoutMs)
			});
			if (response.status === 401 || response.status === 429) {
				if (this.debug) this.log(`relay rejected status=${response.status}`);
				return {
					outcome: "failed",
					reason: "HTTP " + String(response.status)
				};
			}
			if (!response.ok) {
				if (this.debug) this.log(`relay http ${response.status}`);
				return {
					outcome: "failed",
					reason: "HTTP " + String(response.status)
				};
			}
			const body = await response.json();
			if (body.outcome === "sent") return { outcome: "sent" };
			if (body.outcome === "invalid-token") return {
				outcome: "invalid-token",
				reason: body.reason
			};
			if (this.debug) this.log("relay outcome=" + String(body.outcome) + " reason=" + String(body.reason ?? ""));
			return {
				outcome: "failed",
				reason: body.reason
			};
		} catch (error) {
			if (this.debug) this.log("relay send failed: " + String(error));
			return {
				outcome: "failed",
				reason: error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)
			};
		}
	}
};
//#endregion
//#region src/remote-supervisor.ts
const RESTART_DELAYS_MS = [
	1e3,
	2e3,
	4e3,
	8e3,
	16e3,
	3e4
];
/**
* Throttle for configuration-level failures (helper binary missing, state dir
* unwritable). The environment will not self-heal between attempts, so the
* previous "1s..30s exponential" backoff was a CPU/for-loop on a misconfigured
* Host. 60s matches the APNs sender-failure throttle on the host plugin
* (index.ts SENDER_FAILURE_RETRY_MS) and the relay enrollment throttle.
*/
const UNAVAILABLE_RETRY_MS = 6e4;
const DEFAULT_REMOTE_HOSTNAME = "dsh-deeppilot";
/** Preserve custom node names while migrating every pre-DeepPilot default. */
function normalizeRemoteHostname(value) {
	const hostname = value?.trim() ?? "";
	if (hostname === "" || [
		"dsh-phone",
		"dsh-pocket",
		"harnesspocket"
	].includes(hostname.toLowerCase())) return DEFAULT_REMOTE_HOSTNAME;
	return hostname;
}
/** Parse one helper IPC line without ever evaluating or interpolating it. */
function parseHelperEvent(line) {
	try {
		const value = JSON.parse(line);
		if (typeof value.phase !== "string" || ![
			"starting",
			"login_required",
			"online",
			"error",
			"stopped"
		].includes(value.phase)) return null;
		return {
			phase: value.phase,
			...typeof value.publicURL === "string" ? { publicURL: value.publicURL } : {},
			...typeof value.authURL === "string" ? { authURL: value.authURL } : {},
			...typeof value.message === "string" ? { message: value.message.slice(0, 500) } : {}
		};
	} catch {
		return null;
	}
}
function isTailscaleAuthURL(value) {
	if (!value) return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && (url.hostname === "login.tailscale.com" || url.hostname.endsWith(".login.tailscale.com"));
	} catch {
		return false;
	}
}
/** Translate Node's platform/architecture names to the GOOS/GOARCH directory
*  names used by the committed helper matrix. */
function bundledHelperPlatformDir(platform = process.platform, arch = process.arch) {
	return `${platform === "win32" ? "windows" : platform}-${arch === "x64" ? "amd64" : arch}`;
}
/** Build the list of candidate locations for the embedded tunnel helper, in
*  priority order. The first existing executable wins at start() time. The
*  order matters: explicit config (handled by the caller) > npm install
*  layout > DSH-bundled layout > user data dir. */
function bundledHelperCandidates(platform = process.platform, arch = process.arch) {
	const here = dirname(fileURLToPath(import.meta.url));
	const pkgRoot = resolve(here, "..");
	const fileName = platform === "win32" ? "dsh-deeppilot-tunnel.exe" : "dsh-deeppilot-tunnel";
	const platformDir = bundledHelperPlatformDir(platform, arch);
	const candidates = [];
	candidates.push(resolve(pkgRoot, "bin", platformDir, fileName));
	candidates.push(resolve(pkgRoot, "..", "..", "..", "node_modules", "dsh-deeppilot", "bin", platformDir, fileName));
	candidates.push(resolve(pkgRoot, "..", "..", "dsh-deeppilot", "bin", platformDir, fileName));
	candidates.push(resolve(pkgRoot, "..", "..", "..", "..", "node_modules", "dsh-deeppilot", "bin", platformDir, fileName));
	try {
		const resolved = createRequire(import.meta.url).resolve(`dsh-deeppilot/bin/${platformDir}/${fileName}`);
		if (!candidates.includes(resolved)) candidates.push(resolved);
	} catch {}
	const home = process.env.DSH_HOME?.trim() || process.env.HOME || process.env.USERPROFILE;
	if (home && home.length > 0) {
		const dataDir = resolve(home, ".dsh");
		candidates.push(join(dataDir, "deeppilot", "bin", platformDir, fileName));
	}
	return candidates;
}
/** Owns exactly one embedded tunnel helper and restarts it after failures. */
var RemoteSupervisor = class {
	options;
	child;
	restartTimer;
	restartAttempt = 0;
	stopping = false;
	statusValue;
	constructor(options) {
		this.options = options;
		this.statusValue = {
			provider: "tailscale-funnel",
			phase: options.enabled ? "stopped" : "disabled",
			updatedAt: Date.now()
		};
	}
	status() {
		return { ...this.statusValue };
	}
	async start(originURL) {
		if (!this.options.enabled || this.child !== void 0 || this.stopping) return;
		const statePath = expandHome(this.options.statePath);
		const configured = this.options.helperPath?.trim() ?? "";
		const candidates = configured ? [expandHome(configured)] : bundledHelperCandidates();
		let helper;
		let lastError;
		for (const candidate of candidates) try {
			await access(candidate, constants.X_OK);
			helper = candidate;
			break;
		} catch (error) {
			lastError = error;
		}
		if (helper === void 0) {
			if (this.stopping) return;
			const platform = `${process.platform}-${process.arch}`;
			const message = configured ? `embedded tunnel helper unavailable: ${configured}: ${String(lastError ?? "not found")}` : `embedded tunnel helper not found for ${platform} (tried: ${candidates.join(", ")}); set remote.helperPath to override`;
			this.setStatus({
				phase: "unavailable",
				message
			});
			this.scheduleRestart(originURL, "unavailable");
			return;
		}
		try {
			await mkdir(statePath, {
				recursive: true,
				mode: 448
			});
		} catch (error) {
			if (this.stopping) return;
			this.setStatus({
				phase: "unavailable",
				message: `cannot create remote state dir: ${String(error)}`
			});
			this.scheduleRestart(originURL, "unavailable");
			return;
		}
		if (this.stopping) return;
		this.setStatus({
			phase: "starting",
			message: void 0
		});
		const child = spawn(helper, [
			"--origin",
			originURL,
			"--hostname",
			normalizeRemoteHostname(this.options.hostname),
			"--state-dir",
			statePath,
			"--port",
			String(this.options.funnelPort ?? 443)
		], {
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				TMPDIR: process.env.TMPDIR ?? "/tmp"
			}
		});
		this.child = child;
		if (child.stdout === null || child.stderr === null) {
			this.setStatus({
				phase: "error",
				message: "helper stdio unavailable"
			});
			child.kill("SIGTERM");
			return;
		}
		let stdoutBuffer = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk;
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) this.acceptLine(line);
		});
		let stderrBuffer = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderrBuffer = (stderrBuffer + chunk).slice(-2e3);
		});
		child.once("error", (error) => {
			this.setStatus({
				phase: "error",
				message: `helper launch failed: ${String(error)}`
			});
		});
		child.once("exit", (code, signal) => {
			if (this.child === child) this.child = void 0;
			if (this.stopping) {
				this.setStatus({
					phase: "stopped",
					message: void 0
				});
				return;
			}
			const detail = stderrBuffer.trim().split("\n").at(-1);
			this.setStatus({
				phase: "error",
				message: detail || `helper exited (${signal ?? String(code)})`
			});
			this.scheduleRestart(originURL, "crash");
		});
	}
	async dispose() {
		this.stopping = true;
		if (this.restartTimer !== void 0) clearTimeout(this.restartTimer);
		this.restartTimer = void 0;
		const child = this.child;
		this.child = void 0;
		if (child === void 0) {
			this.setStatus({
				phase: "stopped",
				message: void 0
			});
			return;
		}
		await new Promise((resolveDone) => {
			const force = setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 3e3);
			child.once("exit", () => {
				clearTimeout(force);
				resolveDone();
			});
			child.kill("SIGTERM");
		});
		this.setStatus({
			phase: "stopped",
			message: void 0
		});
	}
	acceptLine(line) {
		const event = parseHelperEvent(line);
		if (event === null || event.phase === void 0) return;
		if (event.phase === "login_required") {
			if (this.statusValue.phase === "online" || !isTailscaleAuthURL(event.authURL)) return;
		}
		if (event.phase === "online") this.restartAttempt = 0;
		this.setStatus({
			...event,
			phase: event.phase
		});
	}
	scheduleRestart(originURL, kind = "crash") {
		if (this.stopping || this.restartTimer !== void 0) return;
		const delay = kind === "unavailable" ? UNAVAILABLE_RETRY_MS : RESTART_DELAYS_MS[Math.min(this.restartAttempt, RESTART_DELAYS_MS.length - 1)];
		if (kind === "crash") this.restartAttempt += 1;
		this.restartTimer = setTimeout(() => {
			this.restartTimer = void 0;
			this.start(originURL);
		}, delay);
		this.restartTimer.unref?.();
	}
	setStatus(next) {
		const cleared = next.phase === "online" ? {
			authURL: void 0,
			message: void 0
		} : next.phase === "login_required" ? {
			publicURL: void 0,
			message: void 0
		} : next.phase === "starting" || next.phase === "stopped" || next.phase === "disabled" ? {
			publicURL: void 0,
			authURL: void 0,
			message: void 0
		} : {};
		this.statusValue = {
			...this.statusValue,
			...cleared,
			...next,
			updatedAt: Date.now()
		};
		if (next.phase === "online") this.options.log("remote Funnel online");
		else if (next.phase === "login_required") this.options.log("remote Funnel requires browser authorization");
		else if (next.phase === "error" || next.phase === "unavailable") this.options.log(`remote Funnel ${next.phase}: ${next.message ?? "unknown error"}`);
	}
};
//#endregion
//#region src/local-address.ts
function isPrivateIPv4(address) {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
	const [a, b] = octets;
	return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}
/** Private IPv4 candidates, preferring physical en* interfaces over tunnels. */
function localLANIPv4Addresses() {
	const candidates = [];
	for (const [name, entries] of Object.entries(networkInterfaces())) for (const entry of entries ?? []) if (entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address)) candidates.push({
		name,
		address: entry.address
	});
	const priority = (name) => name === "en0" ? 0 : name.startsWith("en") ? 1 : name.startsWith("bridge") ? 2 : 3;
	candidates.sort((left, right) => priority(left.name) - priority(right.name) || left.name.localeCompare(right.name));
	return [...new Set(candidates.map(({ address }) => address))];
}
//#endregion
//#region src/update-check.ts
/**
* Lightweight self-update check for dsh-deeppilot.
*
* On Host boot we ask the GitHub Releases API (REST) which is the latest
* stable tag, compare it to the installed plugin version, and surface a
* "newer release exists" flag plus the GitHub release URL through the
* report Remote. The settings page renders one small line at the bottom;
* a successful check is enough — no manual button, no persistent cache
* (the host process is the lifetime of the answer).
*
* Deliberately no third-party dependency: we use {@link https.request}
* directly to keep parity with the rest of the project (remote-supervisor
* uses node:http, host-bridge uses ws, etc).
*
* Failure policy: every network/parse error collapses to a single log
* line and the in-memory snapshot stays "unknown". The bridge must never
* crash because GitHub rate-limited us, returned a 5xx, or the user is
* offline.
*/
/** GitHub repo (no .git suffix). Public, unauthenticated, low rate limit. */
const RELEASES_PATH = "/repos/Mars-Sea/dsh-deeppilot/releases";
/** Hard ceiling on the network round-trip. The host must never hang. */
const FETCH_TIMEOUT_MS = 8e3;
/** Per-page limit. We only need the first stable release, but pre-releases
*  tend to be listed first; fetching 20 gives the comparator enough room. */
const PER_PAGE = 20;
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseStableEntry(value) {
	if (!isPlainObject(value)) return null;
	const tag = value.tag_name;
	if (typeof tag !== "string") return null;
	if (value.prerelease === true || value.draft === true) return null;
	if (parseStableTag(tag) === null) return null;
	const url = value.html_url;
	return {
		tag,
		url: typeof url === "string" ? url : null
	};
}
/** Parse one stable release from the `tag_name` shape `vX.Y.Z` (the v is
*  optional; `1.2.3` is also accepted). Pre-release tags like `0.3.0-rc.1`
*  return null — the policy is "stable channel only". */
function parseStableTag(tag) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag.trim());
	if (match === null) return null;
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3])
	};
}
/** Semver compare for X.Y.Z. Returns -1 / 0 / 1. */
function compareSemver(a, b) {
	const pa = parseStableTag(a);
	const pb = parseStableTag(b);
	if (pa === null && pb === null) return 0;
	if (pa === null) return -1;
	if (pb === null) return 1;
	if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
	if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
	if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
	return 0;
}
/** Hit the GitHub Releases API. Resolves with the first stable release
*  GitHub returned, or null if the list contains no stable entries.
*  Network / parse errors reject — the caller is responsible for
*  collapsing them to a log line. */
function fetchLatestStableRelease() {
	return new Promise((resolve, reject) => {
		const req = request({
			method: "GET",
			host: "api.github.com",
			path: `${RELEASES_PATH}?per_page=${PER_PAGE}`,
			headers: {
				"user-agent": "dsh-deeppilot-update-check",
				"accept": "application/vnd.github+json"
			}
		}, (res) => {
			const status = res.statusCode ?? 0;
			if (status < 200 || status >= 300) {
				res.resume();
				reject(/* @__PURE__ */ new Error(`github releases http ${status}`));
				return;
			}
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				try {
					const body = Buffer.concat(chunks).toString("utf8");
					const parsed = JSON.parse(body);
					if (!Array.isArray(parsed)) {
						reject(/* @__PURE__ */ new Error("github releases: response is not an array"));
						return;
					}
					for (const entry of parsed) {
						const stable = parseStableEntry(entry);
						if (stable !== null) {
							resolve(stable);
							return;
						}
					}
					resolve(null);
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			res.on("error", (error) => reject(error));
		});
		req.setTimeout(FETCH_TIMEOUT_MS, () => {
			req.destroy(/* @__PURE__ */ new Error("github releases: timeout after 8000ms"));
		});
		req.on("error", (error) => reject(error));
		req.end();
	});
}
/**
* Process-wide check state. Constructed once in `apply()`, queried
* synchronously by the report snapshot. The check itself fires once in
* the background shortly after boot; the answer lives for the lifetime
* of the host process — re-running the page in the Web UI does not
* trigger another network call.
*/
var UpdateChecker = class {
	log;
	currentVersion;
	fetchImpl;
	initialDelayMs;
	snapshot;
	inflight = null;
	constructor(options) {
		this.log = options.log;
		this.currentVersion = options.currentVersion;
		this.fetchImpl = options.fetchImpl ?? fetchLatestStableRelease;
		this.initialDelayMs = options.initialDelayMs ?? 2e3;
		this.snapshot = {
			currentVersion: this.currentVersion,
			available: false,
			releaseUrl: null,
			latestVersion: null
		};
	}
	/** Return the current in-memory snapshot — safe to call from any host
	*  thread. Never throws, never awaits. */
	get() {
		return this.snapshot;
	}
	/**
	* Schedule one background refresh after the configured initial delay.
	* Used by the plugin entry to do the first check without blocking boot.
	*/
	scheduleInitial() {
		if (this.initialDelayMs <= 0) {
			this.runOnce();
			return;
		}
		const timer = setTimeout(() => {
			this.runOnce();
		}, this.initialDelayMs);
		if (typeof timer.unref === "function") timer.unref();
	}
	async runOnce() {
		if (this.inflight !== null) {
			await this.inflight;
			return;
		}
		const task = (async () => {
			try {
				const stable = await this.fetchImpl();
				if (stable === null) return;
				if (compareSemver(stable.tag, this.currentVersion) > 0) this.snapshot = {
					currentVersion: this.currentVersion,
					available: true,
					releaseUrl: stable.url,
					latestVersion: stable.tag
				};
				else this.snapshot = {
					currentVersion: this.currentVersion,
					available: false,
					releaseUrl: null,
					latestVersion: null
				};
			} catch (error) {
				this.log("update check failed: " + (error instanceof Error ? error.message : String(error)));
			}
		})();
		this.inflight = task.finally(() => {
			this.inflight = null;
		});
		return this.inflight;
	}
	/** No-op kept for API symmetry with the host lifecycle wiring. */
	dispose() {}
};
//#endregion
//#region src/index.ts
/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
function shouldPrunePushToken(outcome, reason) {
	return outcome === "invalid-token" && (reason === "Unregistered" || reason === "ExpiredToken");
}
/**
* dsh-deeppilot — data bridge between the DSH host and DeepPilot
* clients. Registers exactly one WebSocket upgrade route (/phone) plus an
* optional health probe (/phone/health) on the existing web server. The web
* UI is never touched.
*
* Data plane: an in-process HostBridge consumes apiProxy.events.mux()/host()
* streams, mirrors session summaries, tracks pending approvals/questions,
* and fans projected protocol-v1 pushes out to every connected device.
*
* Protocol: src/protocol.ts, v1. The private app repository carries the
* matching normative document and Swift models.
*/
const name = "deeppilot";
/** No eager service requirement: profiles without a web stack simply skip. */
const inject = [];
/** Operator-run relay used by distributed builds; overridable via config. */
const DEFAULT_RELAY_URL = "https://pilot.hailab.dev";
const Config = z.object({
	enabled: z.boolean().default(true),
	authTokenPath: z.string().default(join(bridgeDataDir(), "auth-token")),
	devicesPath: z.string().default(join(bridgeDataDir(), "devices.json")),
	historyBufferMax: z.natural().min(100).default(2e3),
	debug: z.boolean().default(false),
	remote: z.object({
		enabled: z.boolean().default(false),
		provider: z.union(["tailscale-funnel"]).default("tailscale-funnel"),
		hostname: z.string().default(DEFAULT_REMOTE_HOSTNAME),
		statePath: z.string().default(join(bridgeDataDir(), "tailscale")),
		helperPath: z.string().default(""),
		funnelPort: z.union([
			443,
			8443,
			1e4
		]).default(443)
	}).default({
		enabled: false,
		provider: "tailscale-funnel",
		hostname: DEFAULT_REMOTE_HOSTNAME,
		statePath: join(bridgeDataDir(), "tailscale"),
		helperPath: "",
		funnelPort: 443
	}),
	push: z.object({
		provider: z.union([
			"none",
			"apns",
			"relay"
		]).default("none"),
		teamId: z.string().default(""),
		keyId: z.string().default(""),
		keyPath: z.string().default(join(bridgeDataDir(), "apns", "AuthKey.p8")),
		bundleId: z.string().default("dev.hailab.deeppilot"),
		relayUrl: z.string().default(DEFAULT_RELAY_URL),
		relayToken: z.string().default("")
	}).default({
		provider: "none",
		teamId: "",
		keyId: "",
		keyPath: join(bridgeDataDir(), "apns", "AuthKey.p8"),
		bundleId: "dev.hailab.deeppilot",
		relayUrl: DEFAULT_RELAY_URL,
		relayToken: ""
	})
});
const SERVER_VERSION = readOwnPackageVersion();
const MAX_CLIENT_CONNECTIONS = 16;
/**
* Single-frame bound. Covers the protocol maximum (4 × 8 MB base64 images
* plus prompt text) with headroom while keeping an unauthenticated client's
* pre-hello buffering far below ws's 100 MiB default.
*/
const MAX_FRAME_BYTES = 67108864;
/**
* Resolve the host plugin's own version from the installed package.json.
* Sourced at boot so the wire / UI always agrees with what npm published.
* `createRequire(import.meta.url)` is the tsdown-bundled ESM equivalent of
* CommonJS's `require`; the package.json sits next to lib/index.js after
* the build, so `../package.json` resolves to the published manifest.
*/
function readOwnPackageVersion() {
	try {
		const pkg = createRequire(import.meta.url)("../package.json");
		if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
	} catch {}
	const envVersion = process.env.npm_package_version;
	if (typeof envVersion === "string" && envVersion.length > 0) return envVersion;
	return "0.0.0+unknown";
}
function rejectUpgrade(socket, status, reason) {
	const body = JSON.stringify({ error: reason });
	const statusText = {
		401: "Unauthorized",
		429: "Too Many Requests",
		500: "Internal Server Error",
		503: "Service Unavailable"
	};
	const authenticate = status === 401 ? "WWW-Authenticate: Bearer realm=\"deeppilot\"\r\n" : "";
	socket.end("HTTP/1.1 " + status + " " + (statusText[status] ?? "Error") + "\r\n" + authenticate + "Content-Type: application/json\r\nContent-Length: " + Buffer.byteLength(body) + "\r\nConnection: close\r\n\r\n" + body);
}
/** Authorization is preferred; the query form remains for older app builds. */
function requestToken(req) {
	const authorization = req.headers.authorization;
	if (typeof authorization === "string") {
		const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
		if (match?.[1]) return match[1];
	}
	try {
		return new URL(req.url ?? "/", "http://phone.local").searchParams.get("token");
	} catch {
		return null;
	}
}
/**
* Cordis hands the second argument in different shapes depending on host
* composition: a reactive options getter, the resolved config value, or
* nothing when the patch row omits `config`. Normalize all of them.
*/
function normalizeOptions(options) {
	if (typeof options === "function") return options();
	if (options && typeof options === "object") return options;
	return Config(void 0) ?? {};
}
function apply(ctx, options) {
	const cfg = normalizeOptions(options);
	const log = (message) => {
		console.log("[deeppilot] " + message);
	};
	/**
	* Settings-section source: while a settings service is attached this holds
	* the user-edited section value; otherwise the composition defaults. Read
	* through currentConfig() everywhere (normalizeOptions prefers it).
	*/
	let liveSource;
	let scheduleRemoteReconcile;
	const currentConfig = () => {
		if (liveSource !== void 0) return normalizeOptions(liveSource());
		return normalizeOptions(options);
	};
	const enabledNow = () => currentConfig().enabled === true;
	installSettingsSection(ctx, settingsNamespace("deeppilot"), Config, normalizeOptions(void 0), {
		setSource: (source) => {
			liveSource = source;
			queueMicrotask(() => scheduleRemoteReconcile?.());
		},
		onChange: () => queueMicrotask(() => scheduleRemoteReconcile?.())
	});
	if (currentConfig().enabled !== true) log("disabled via settings; bridge stays inactive (rumors of /phone below are skipped)");
	const dataDir = bridgeDataDir();
	const pushRelayPath = join(dataDir, "push-relay.json");
	const enrollmentCell = {};
	let enrollmentWriteTail = Promise.resolve();
	function persistEnrollment() {
		const snapshot = JSON.stringify({
			version: 1,
			...enrollmentCell
		}, null, 2) + "\n";
		enrollmentWriteTail = enrollmentWriteTail.then(async () => {
			const tempPath = pushRelayPath + "." + randomBytes(6).toString("hex") + ".tmp";
			try {
				await mkdir(dataDir, { recursive: true });
				await writeFile(tempPath, snapshot, { mode: 384 });
				await rename(tempPath, pushRelayPath);
			} catch {
				await unlink(tempPath).catch(() => {});
			}
		});
	}
	/** Fired from BridgeConnection when an app presents its built-in key. */
	const handlePushEnrollKey = async (enrollKey) => {
		if (enrollmentCell.enrollKey !== enrollKey) enrollmentCell.enrollKey = enrollKey;
		const configuredProvider = currentConfig().push?.provider;
		if (!configuredProvider || configuredProvider === "none") {
			if (!enrollmentCell.autoRelay) {
				enrollmentCell.autoRelay = true;
				log("push relay mode auto-enabled by enrolled app");
			}
		}
		persistEnrollment();
		const url = (currentConfig().push?.relayUrl ?? "").trim() || DEFAULT_RELAY_URL;
		await ensureRelayEnrolled(url);
	};
	const auth = {
		token: null,
		tokenPath: cfg.authTokenPath ?? join(dataDir, "auth-token"),
		devices: null
	};
	const ready = (async () => {
		try {
			try {
				const migratedFrom = await migrateLegacyBridgeDataDir();
				if (migratedFrom !== null) log(`migrated legacy plugin state from ${migratedFrom} to ${dataDir}`);
			} catch (error) {
				log("legacy plugin-state migration skipped: " + String(error));
			}
			auth.tokenPath = cfg.authTokenPath ?? join(dataDir, "auth-token");
			auth.token = await loadOrCreateToken(auth.tokenPath);
			auth.devices = await DeviceStore.load(cfg.devicesPath ?? join(dataDir, "devices.json"));
			{
				const rows = auth.devices.list();
				const registered = rows.filter((row) => row.apns !== void 0).length;
				log(`device registry loaded from ${expandHome(cfg.devicesPath ?? join(dataDir, "devices.json"))}: ${rows.length} device(s), ${registered} push registration(s)`);
			}
			try {
				const raw = JSON.parse(await readFile(pushRelayPath, "utf8"));
				if (typeof raw.clientId === "string") enrollmentCell.clientId = raw.clientId;
				if (typeof raw.enrollKey === "string") enrollmentCell.enrollKey = raw.enrollKey;
				if (typeof raw.token === "string") enrollmentCell.token = raw.token;
				if (raw.autoRelay === true) enrollmentCell.autoRelay = true;
			} catch {}
		} catch (error) {
			const message = String(error);
			if (message.includes("pairing token is malformed at")) console.warn("[deeppilot] " + message);
			log("auth material unavailable, bridge degraded: " + message);
			return {
				token: null,
				devices: null
			};
		}
		return {
			token: auth.token,
			devices: auth.devices
		};
	})();
	/**
	* Replace the pairing secret: persist a fresh token, clear the paired-device
	* registry, and drop every live phone socket. Handshake-time auth means an
	* already-open socket would otherwise outlive its token; terminating forces
	* each device to re-pair with the new secret. The old token is invalid the
	* moment the file is rewritten.
	*
	* Serialized through rotateTail so two overlapping invocations can never
	* return a token that a later write already invalidated.
	*/
	const doRotate = async () => {
		const { devices } = await ready;
		if (auth.token === null || devices === null) throw new Error("pairing token unavailable");
		auth.token = await writeNewToken(auth.tokenPath);
		devices.clear();
		let dropped = 0;
		for (const connection of connections) {
			connection.terminate();
			dropped += 1;
		}
		connections.clear();
		log(`pairing token rotated; ${dropped} live phone connection(s) dropped`);
		return auth.token;
	};
	let rotateTail = Promise.resolve();
	const rotatePairingToken = () => {
		const next = rotateTail.then(doRotate);
		rotateTail = next.catch(() => {});
		return next;
	};
	/**
	* Settings-page push self-test: force one synthetic notification down the
	* active pathway to EVERY registered device, deliberately ignoring the
	* connected-skip and category-mute filters — an explicit user action must
	* always be able to prove delivery end to end.
	*/
	const runPushSelfTest = async () => {
		const resolved = resolvePushConfig(currentConfig());
		if (!resolved.ok) return {
			transport: "none",
			overall: "not-configured",
			message: "推送未启用（" + resolved.reason + "）。可先用「测试访问与注册」完成中继注册，或在配置中设置 push.provider",
			results: []
		};
		const tokenized = (auth.devices?.list() ?? []).filter((device) => device.apns !== void 0);
		if (!auth.devices || tokenized.length === 0) return {
			transport: resolved.value.kind,
			overall: "no-targets",
			message: "还没有设备注册离线推送——在手机上打开 DeepPilot 并允许系统通知，等状态变为「已就绪」后再试",
			results: []
		};
		const send = await senderFor(resolved.value);
		if (!send) return {
			transport: resolved.value.kind,
			overall: "failed",
			message: "发送通道不可用（检查 .p8 密钥文件或中继配置）",
			results: []
		};
		const notification = {
			notificationId: "test-" + Date.now(),
			category: "turn.completed",
			sessionId: "push-test",
			title: "DeepPilot 测试推送",
			body: "收到这条通知说明离线推送链路正常"
		};
		const results = await Promise.all(tokenized.map(async (device) => {
			const registration = device.apns;
			const { outcome, reason } = await send({
				deviceToken: registration.token,
				environment: registration.environment,
				notification
			});
			return {
				name: device.deviceName,
				environment: registration.environment,
				outcome,
				tokenFingerprint: registration.token.slice(0, 10),
				...reason !== void 0 ? { reason } : {}
			};
		}));
		const overall = results.some((r) => r.outcome === "sent") ? "sent" : "failed";
		log("push self-test: " + overall + " (" + results.map((r) => `"${r.name}"=${r.outcome}${r.reason ? "/" + r.reason : ""}`).join(", ") + ")");
		return {
			transport: resolved.value.kind,
			overall,
			results
		};
	};
	const connections = /* @__PURE__ */ new Set();
	const closeConnectionsForBridge = (bridge) => {
		for (const connection of connections) {
			if (!connection.isAttachedTo(bridge)) continue;
			connection.closeForServerStop();
			connections.delete(connection);
		}
	};
	const closeAllConnections = () => {
		for (const connection of connections) connection.closeForServerStop();
		connections.clear();
	};
	const resolvePushConfig = (config) => {
		const push = config.push ?? {};
		const configured = push.provider ?? "none";
		const effectiveProvider = configured === "none" && enrollmentCell.autoRelay === true ? "relay" : configured;
		if (effectiveProvider === "relay") {
			const url = (push.relayUrl ?? "").trim() || DEFAULT_RELAY_URL;
			const token = (push.relayToken ?? "").trim() || enrollmentCell.token || "";
			if (!/^https:\/\//i.test(url)) return {
				ok: false,
				reason: "relayUrl must be an https URL"
			};
			if (!token) return {
				ok: false,
				reason: "relay token not enrolled yet"
			};
			return {
				ok: true,
				value: {
					kind: "relay",
					url,
					token
				}
			};
		}
		if (effectiveProvider === "apns") {
			const teamId = (push.teamId ?? "").trim();
			const keyId = (push.keyId ?? "").trim();
			const keyPath = expandHome((push.keyPath ?? "").trim() || join(dataDir, "apns", "AuthKey.p8"));
			const bundleId = (push.bundleId ?? "").trim();
			if (!teamId || !keyId || !bundleId) return {
				ok: false,
				reason: "teamId/keyId/bundleId missing"
			};
			return {
				ok: true,
				value: {
					kind: "apns",
					teamId,
					keyId,
					keyPath,
					bundleId
				}
			};
		}
		return {
			ok: false,
			reason: "provider disabled"
		};
	};
	/**
	* Zero-touch enrollment against the operator's relay. Idempotent and
	* cached in the persistent cell; a failure disables push for this config
	* fingerprint with one log line until something changes.
	*/
	let enrollAttemptFor;
	let enrollLastAttemptAt = 0;
	const ensureRelayEnrolled = async (url) => {
		if (!/^https:\/\//i.test(url.trim())) {
			log("push relay enrollment refused: relayUrl must be an https URL");
			return;
		}
		if (enrollmentCell.token) return enrollmentCell.token;
		const fingerprint = url + ":" + String(enrollmentCell.enrollKey ?? "");
		if (fingerprint !== enrollAttemptFor) {
			enrollAttemptFor = fingerprint;
			enrollLastAttemptAt = 0;
		}
		if (Date.now() - enrollLastAttemptAt < 6e4) return void 0;
		enrollLastAttemptAt = Date.now();
		try {
			if (!enrollmentCell.clientId) {
				enrollmentCell.clientId = "u_" + randomBytes(16).toString("base64url");
				persistEnrollment();
			}
			const token = await new RelayClient({
				url,
				debug: currentConfig().debug === true,
				log
			}).enroll(enrollmentCell.clientId, enrollmentCell.enrollKey ?? "");
			if (!token) {
				log("push relay enrollment failed (" + url + "); will retry on next trigger");
				return;
			}
			enrollmentCell.token = token;
			persistEnrollment();
			log("push relay enrollment succeeded");
			return token;
		} catch (error) {
			log("push relay enrollment error: " + String(error));
			return;
		}
	};
	let cachedSender;
	/**
	* Last failed APNs-sender build. The config fingerprint cannot see the
	* filesystem, so remembering a failure forever meant "copy the .p8 into
	* place later" never recovered without an edit or restart; throttle the
	* retry by time instead — same pattern as relay enrollment below.
	*/
	let senderFailedFor;
	const SENDER_FAILURE_RETRY_MS = 6e4;
	/**
	* Lazily build the push sender for the current config. A broken config
	* (unreadable .p8) disables push for that fingerprint with exactly one log
	* line instead of failing on every event.
	*/
	const senderFor = async (resolved) => {
		const fingerprint = JSON.stringify(resolved);
		if (cachedSender?.fingerprint === fingerprint) return cachedSender.send;
		if (senderFailedFor?.fingerprint === fingerprint && Date.now() - senderFailedFor.at < SENDER_FAILURE_RETRY_MS) return;
		if (cachedSender) {
			await cachedSender.dispose?.().catch(() => {});
			cachedSender = void 0;
		}
		if (resolved.kind === "relay") {
			const client = new RelayClient({
				url: resolved.url,
				token: resolved.token,
				debug: currentConfig().debug === true,
				log
			});
			cachedSender = {
				fingerprint,
				send: (request) => client.send(request)
			};
			log("push relay enabled");
		} else {
			try {
				await readFile(expandHome(resolved.keyPath), "utf8");
			} catch (error) {
				senderFailedFor = {
					fingerprint,
					at: Date.now()
				};
				log("apns push unavailable (key unreadable at " + resolved.keyPath + "): " + String(error));
				return;
			}
			const client = new ApnsClient({
				teamId: resolved.teamId,
				keyId: resolved.keyId,
				keyPath: resolved.keyPath,
				bundleId: resolved.bundleId,
				debug: currentConfig().debug === true,
				log
			});
			cachedSender = {
				fingerprint,
				send: (request) => client.send({
					...request.notification,
					deviceToken: request.deviceToken,
					environment: request.environment
				}),
				dispose: () => client.dispose()
			};
			log("apns push enabled");
		}
		senderFailedFor = void 0;
		return cachedSender.send;
	};
	/**
	* Fan one notification-worthy event out to paired devices holding an APNs
	* token. Rules:
	*  - devices with a live WebSocket are skipped (they already got the WS
	*    frame and will raise the local notification themselves);
	*  - each device is delivered on ITS registered environment (the build
	*    kind it self-reported), so sandbox and production devices coexist;
	*  - the device's per-category switches suppress muted categories;
	*  - only APNs' terminal Unregistered/ExpiredToken verdicts prune storage;
	*    BadDeviceToken may be an environment mismatch and stays diagnosable.
	*/
	const makePushOutlet = () => ({
		isAvailable: () => {
			const resolved = resolvePushConfig(currentConfig());
			if (!resolved.ok) return false;
			if (resolved.value.kind === "relay" && !resolved.value.token) return false;
			return true;
		},
		fanOut: (notification) => {
			(async () => {
				let resolved = resolvePushConfig(currentConfig());
				if (!resolved.ok && resolved.reason === "relay token not enrolled yet") {
					const relayUrl = (currentConfig().push?.relayUrl ?? "").trim() || DEFAULT_RELAY_URL;
					await ensureRelayEnrolled(relayUrl);
					resolved = resolvePushConfig(currentConfig());
				}
				if (!resolved.ok) return;
				const devices = auth.devices;
				if (!devices) return;
				const send = await senderFor(resolved.value);
				if (!send) return;
				const transport = resolved.value.kind;
				const connectedIds = /* @__PURE__ */ new Set();
				for (const connection of connections) {
					const id = connection.connectedDeviceId;
					if (id) connectedIds.add(id);
				}
				const candidates = devices.list().filter((device) => {
					const registration = device.apns;
					if (!registration) return false;
					if (connectedIds.has(device.deviceId)) return false;
					if (registration.categories?.[notification.category] === false) {
						if (currentConfig().debug === true) log(`push skip "${device.deviceName}": category ${notification.category} muted`);
						return false;
					}
					return true;
				});
				if (candidates.length === 0) {
					const tokenized = devices.list().filter((device) => device.apns !== void 0).length;
					log(`push(${transport}) ${notification.category}: no offline targets (connected=${connectedIds.size}, tokenized=${tokenized})`);
					return;
				}
				for (const device of candidates) {
					const registration = device.apns;
					send({
						deviceToken: registration.token,
						environment: registration.environment,
						notification
					}).then(({ outcome, reason }) => {
						log(`push(${transport}) ${notification.category} → "${device.deviceName}" [${registration.environment}] = ${outcome}${reason ? " (" + reason + ")" : ""}`);
						if (shouldPrunePushToken(outcome, reason)) {
							devices.clearPushToken(device.deviceId);
							log(`push: pruned stale token of "${device.deviceName}" (${reason ?? "unknown"}) — app re-registers on next launch`);
						}
					}).catch(() => {});
				}
			})();
		}
	});
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_FRAME_BYTES
	});
	let remoteSupervisor;
	const remoteStatus = () => remoteSupervisor?.status() ?? {
		provider: "tailscale-funnel",
		phase: currentConfig().remote?.enabled === true ? "stopped" : "disabled",
		updatedAt: Date.now()
	};
	const updateChecker = new UpdateChecker({
		log,
		currentVersion: SERVER_VERSION
	});
	updateChecker.scheduleInitial();
	const updateInfo = () => updateChecker.get();
	applyReportRemote(ctx, async () => {
		let tokenReady = false;
		let devices = [];
		try {
			await ready;
			tokenReady = auth.token !== null;
			devices = (auth.devices?.list() ?? []).map(({ deviceId, deviceName, appVersion, firstSeenTs, lastSeenTs, apns }) => ({
				deviceId,
				deviceName,
				appVersion,
				firstSeenTs,
				lastSeenTs,
				...apns ? { apns: {
					environment: apns.environment,
					updatedAt: apns.updatedAt
				} } : {}
			}));
		} catch {}
		const update = updateInfo();
		return {
			protocolVersion: 1,
			serverVersion: SERVER_VERSION,
			pluginVersion: update.currentVersion,
			...update.available ? { updateAvailable: true } : {},
			...update.releaseUrl !== null ? { releaseUrl: update.releaseUrl } : {},
			enabled: currentConfig().enabled === true,
			tokenPath: expandHome(currentConfig().authTokenPath ?? join(bridgeDataDir(), "auth-token")),
			tokenReady,
			activeConnections: connections.size,
			historyBufferMax: currentConfig().historyBufferMax ?? 2e3,
			debug: currentConfig().debug === true,
			lanAddresses: localLANIPv4Addresses(),
			remote: remoteStatus(),
			devices
		};
	}, async () => {
		await ready;
		if (auth.token === null) throw new Error("pairing token unavailable");
		return auth.token;
	}, rotatePairingToken, async () => {
		const push = currentConfig().push ?? {};
		const configured = push.provider ?? "none";
		if ((configured === "none" && enrollmentCell.autoRelay === true ? "relay" : configured) !== "relay") return {
			url: "",
			overall: "failed",
			tokenIssued: false,
			steps: [{
				id: "health",
				ok: false,
				message: `当前推送模式不是中继（provider=${configured}）。启用方式二选一：① 零配置——在 ios/project.yml 填写 DSPushEnrollKey（与服务器 RELAY_ENROLL_KEY 一致）并重新安装 App，打开 App 即自动启用；② 手动——将 push.provider 设为 relay 并填入 relayToken`
			}]
		};
		const url = (push.relayUrl ?? "").trim() || DEFAULT_RELAY_URL;
		if (!/^https:\/\//i.test(url)) return {
			url,
			overall: "failed",
			tokenIssued: false,
			steps: [{
				id: "health",
				ok: false,
				message: "relayUrl 必须是 https 地址：注册请求携带共享密钥，明文 HTTP 会把它暴露给链路上的任何节点"
			}]
		};
		if (!enrollmentCell.clientId && enrollmentCell.enrollKey) {
			enrollmentCell.clientId = "u_" + randomBytes(16).toString("base64url");
			persistEnrollment();
		}
		return await runRelayProbe({
			url,
			clientId: enrollmentCell.clientId,
			enrollKey: enrollmentCell.enrollKey,
			manualToken: Boolean((push.relayToken ?? "").trim()),
			onEnrolled: (token) => {
				enrollmentCell.token = token;
				persistEnrollment();
				log("push relay enrollment succeeded (via settings self-test)");
			}
		});
	}, async () => {
		return await runPushSelfTest();
	});
	const state = {};
	let pendingUpgrades = 0;
	const handleUpgrade = (req, socket, head) => {
		(async () => {
			try {
				if (!enabledNow()) {
					rejectUpgrade(socket, 503, "bridge disabled");
					return;
				}
				if (connections.size + pendingUpgrades >= MAX_CLIENT_CONNECTIONS) {
					rejectUpgrade(socket, 429, "too many connections");
					return;
				}
				pendingUpgrades += 1;
				try {
					const { devices } = await ready;
					const token = auth.token;
					if (!token || !devices) {
						rejectUpgrade(socket, 503, "bridge degraded");
						return;
					}
					const presentedToken = requestToken(req);
					if (presentedToken !== null && !tokenMatches(presentedToken, token)) {
						rejectUpgrade(socket, 401, "invalid token");
						return;
					}
					const bridge = state.bridge;
					if (!bridge) {
						rejectUpgrade(socket, 503, "bridge not ready");
						return;
					}
					if (auth.token !== token) {
						rejectUpgrade(socket, 401, "invalid token");
						return;
					}
					wss.handleUpgrade(req, socket, head, (ws) => {
						if (auth.token !== token || state.bridge !== bridge) {
							ws.close(1012, "bridge changed");
							return;
						}
						const connection = new BridgeConnection(ws, {
							bridge,
							devices,
							serverVersion: SERVER_VERSION,
							expectedToken: token,
							transportAuthenticated: presentedToken !== null,
							log,
							debug: currentConfig().debug === true,
							onClosed: (closed) => connections.delete(closed),
							onPushEnrollKey: handlePushEnrollKey
						});
						connections.add(connection);
					});
				} finally {
					pendingUpgrades -= 1;
				}
			} catch (error) {
				log("upgrade failed: " + String(error));
				rejectUpgrade(socket, 500, "internal error");
			}
		})();
	};
	const handleHealth = async (req, res) => {
		try {
			await ready;
			const token = auth.token;
			res.setHeader("Content-Type", "application/json");
			if (!token) {
				res.statusCode = 503;
				res.end(JSON.stringify({
					ok: false,
					degraded: true
				}));
				return;
			}
			if (!tokenMatches(requestToken(req), token)) {
				res.statusCode = 401;
				res.end(JSON.stringify({ ok: false }));
				return;
			}
			res.statusCode = 200;
			res.end(JSON.stringify({
				ok: true,
				enabled: enabledNow(),
				protocolVersion: 1,
				serverVersion: SERVER_VERSION,
				dataPlane: Boolean(state.bridge)
			}));
		} catch {
			res.statusCode = 500;
			res.end(JSON.stringify({ ok: false }));
		}
	};
	ctx.inject(["apiProxy"], (sub) => {
		if (currentConfig().enabled !== true) {
			log("bridge disabled; data plane stays inactive");
			return;
		}
		const apiCtx = sub;
		const proxy = apiCtx.apiProxy;
		if (!proxy) {
			log("apiProxy service absent; data plane stays inactive");
			return;
		}
		const bridge = new HostBridge(proxy, cfg.historyBufferMax);
		bridge.setPushOutlet(makePushOutlet());
		state.bridge = bridge;
		bridge.start();
		log("data plane active (mux + host streams)");
		apiCtx.effect(() => () => {
			closeConnectionsForBridge(bridge);
			if (state.bridge === bridge) state.bridge = void 0;
			bridge.dispose();
		}, "deeppilot: host streams");
	});
	ctx.inject(["webServer"], (sub) => {
		const webCtx = sub;
		const web = webCtx.webServer;
		if (!web) {
			log("webServer service absent in this profile; bridge stays inactive");
			return;
		}
		webCtx.effect(() => web.registerUpgrade({
			path: "/phone",
			handler: handleUpgrade
		}), "deeppilot: /phone WebSocket");
		webCtx.effect(() => web.register({
			kind: "exact",
			path: "/phone/health",
			handler: handleHealth
		}), "deeppilot: /phone/health");
		const sweep = setInterval(() => {
			const now = Date.now();
			for (const connection of connections) if (connection.isStale(now, 6e4)) {
				log("dropping stale connection");
				connection.closeIdle();
				connections.delete(connection);
			}
		}, 3e4);
		webCtx.effect(() => () => clearInterval(sweep), "deeppilot: stale sweep");
		const originServer = createServer((req, res) => {
			let path = "/";
			try {
				path = new URL(req.url ?? "/", "http://phone.local").pathname;
			} catch {}
			if (path === "/phone/health") handleHealth(req, res);
			else {
				res.statusCode = 404;
				res.end("not found");
			}
		});
		originServer.on("upgrade", (req, socket, head) => {
			let path = "/";
			try {
				path = new URL(req.url ?? "/", "http://phone.local").pathname;
			} catch {}
			if (path !== "/phone") {
				socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
				return;
			}
			handleUpgrade(req, socket, head);
		});
		let originURL;
		let appliedRemoteKey;
		let remoteDisposed = false;
		let reconcileTail = Promise.resolve();
		const reconcileRemote = async () => {
			if (remoteDisposed || originURL === void 0) return;
			const config = currentConfig();
			const remoteConfig = config.remote ?? {};
			const remotePort = remoteConfig.funnelPort === 8443 || remoteConfig.funnelPort === 1e4 ? remoteConfig.funnelPort : 443;
			const helperPath = remoteConfig.helperPath?.trim() || void 0;
			const next = {
				enabled: config.enabled === true && remoteConfig.enabled === true && remoteConfig.provider === "tailscale-funnel",
				hostname: normalizeRemoteHostname(remoteConfig.hostname),
				statePath: remoteConfig.statePath?.trim() || join(dataDir, "tailscale"),
				helperPath,
				funnelPort: remotePort
			};
			const nextKey = JSON.stringify(next);
			if (nextKey === appliedRemoteKey) return;
			const previous = remoteSupervisor;
			remoteSupervisor = void 0;
			if (previous !== void 0) await previous.dispose();
			if (remoteDisposed) return;
			const supervisor = new RemoteSupervisor({
				enabled: next.enabled,
				hostname: next.hostname,
				statePath: next.statePath,
				...next.helperPath ? { helperPath: next.helperPath } : {},
				funnelPort: next.funnelPort,
				log
			});
			remoteSupervisor = supervisor;
			appliedRemoteKey = nextKey;
			await supervisor.start(originURL);
		};
		scheduleRemoteReconcile = () => {
			reconcileTail = reconcileTail.then(reconcileRemote).catch((error) => log("remote reconcile failed: " + String(error)));
		};
		originServer.listen(0, "127.0.0.1", () => {
			const address = originServer.address();
			if (address && typeof address === "object") {
				originURL = `http://127.0.0.1:${address.port}`;
				scheduleRemoteReconcile?.();
			}
		});
		originServer.on("error", (error) => log("remote origin failed: " + String(error)));
		webCtx.effect(() => () => {
			remoteDisposed = true;
			scheduleRemoteReconcile = void 0;
			originServer.close();
			reconcileTail = reconcileTail.then(async () => {
				const supervisor = remoteSupervisor;
				remoteSupervisor = void 0;
				if (supervisor !== void 0) await supervisor.dispose();
			});
		}, "deeppilot: embedded Funnel");
		if (enabledNow()) log("/phone WebSocket registered");
		else log("bridge disabled; /phone refuses connections until re-enabled and restarted");
	});
	ctx.effect(() => async () => {
		closeAllConnections();
		const bridge = state.bridge;
		state.bridge = void 0;
		bridge?.dispose();
		const sender = cachedSender;
		cachedSender = void 0;
		updateChecker.dispose();
		const wssClosed = new Promise((resolve) => wss.close(() => resolve()));
		await Promise.allSettled([
			enrollmentWriteTail,
			sender?.dispose?.() ?? Promise.resolve(),
			wssClosed
		]);
	}, "deeppilot: process resources");
}
//#endregion
export { Config, HostBridge, apply, inject, name, requestToken, shouldPrunePushToken };

//# sourceMappingURL=index.js.map