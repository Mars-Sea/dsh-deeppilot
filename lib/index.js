import { createRequire } from "node:module";
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { access, chmod, mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { homedir, networkInterfaces } from "node:os";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { connect } from "node:http2";
import { createServer } from "node:http";
import { createServer as createServer$1, request } from "node:https";
import * as Cordis from "@deepseek-ai/cordis";
import { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { isIP } from "node:net";
import { generate } from "selfsigned";
//#region src/wire-errors.ts
/**
* 错误词表（error vocabulary）的唯一属主。
*
* 一条失败信息在系统里要过三种词汇：Host 控制器返回的错误码（`session-not-found`、
* `schedule_conflict`……）、Bridge 结果里的状态、以及 wire 上的 `E_*` 码。
* 此前这三层各有映射函数（host-bridge 里 5 个、connection-policy 里 2 个、
* connection.ts 的 switch 里 5 处内联三元链），一处漂移就会让客户端对
* 「该不该重试」的判断失真。
*
* 本 module 只做一次翻译：每个域一张「Host code -> wire code」表，
* Bridge 的结果直接携带 wire 码。`E_BUSY` 与 `E_PROTOCOL` 决定客户端是否
* 重试，因此这张表是 wire 行为的一部分，逐码都有测试把守。
*
* 规范见 PROTOCOL.md 错误码表（`E_PROTOCOL` = 未知类型或非法 payload，
* `E_FORBIDDEN` = 权限不足，`E_UNSUPPORTED` = 能力缺失）。
*/
/** wire 错误码及其规范描述；PROTOCOL.md 错误码表的 TS 镜像。 */
const ERROR_CODES = {
	E_AUTH: "device proof missing or invalid",
	E_FORBIDDEN: "device scope does not allow this operation",
	E_PROTOCOL: "unknown type or malformed payload",
	E_NOT_FOUND: "session or request not found",
	E_BUSY: "session is busy",
	E_UNSUPPORTED: "protocol version or capability unsupported",
	E_INTERNAL: "internal error"
};
/** Bridge 未携带 code 的结果（内部守卫失败等）落到这一档。 */
const WIRE_ERROR_FALLBACK = "E_INTERNAL";
const DOMAIN_TABLES = {
	session: {
		"session-not-found": "E_NOT_FOUND",
		"workspace-not-found": "E_NOT_FOUND",
		"agent-busy": "E_BUSY",
		"session-conflict": "E_BUSY",
		"title-invalid": "E_PROTOCOL",
		"workspace-invalid-path": "E_PROTOCOL",
		"workspace-name-conflict": "E_PROTOCOL",
		"directory-unreadable": "E_PROTOCOL",
		"directory-exists": "E_PROTOCOL",
		"directory-create-failed": "E_PROTOCOL",
		"directory-picker-unavailable": "E_UNSUPPORTED"
	},
	model: {
		"session-not-found": "E_NOT_FOUND",
		"agent-busy": "E_BUSY",
		"session-conflict": "E_BUSY",
		"model-unavailable": "E_NOT_FOUND"
	},
	schedule: {
		"schedule_not_found": "E_NOT_FOUND",
		"delivery_cursor_not_found": "E_NOT_FOUND",
		"schedule_conflict": "E_BUSY",
		"invalid_prompt": "E_PROTOCOL",
		"invalid_selector": "E_PROTOCOL",
		"invalid_rule": "E_PROTOCOL",
		"invalid_time_zone": "E_PROTOCOL",
		"not_future": "E_PROTOCOL",
		"time_out_of_range": "E_PROTOCOL",
		"frequency_too_high": "E_PROTOCOL",
		"schedule_ended": "E_PROTOCOL"
	}
};
/** 一个 Host 失败翻译成 Bridge 的失败结果：直接携带 wire 错误码。 */
function wireErrorOf(domain, error) {
	return {
		ok: false,
		code: DOMAIN_TABLES[domain][error.code] ?? "E_INTERNAL",
		message: error.message ?? error.code
	};
}
/** 只有一个 Host code（没有附带 message）时取它的 wire 码。 */
function wireCodeFor(domain, hostCode) {
	if (hostCode === void 0) return WIRE_ERROR_FALLBACK;
	return DOMAIN_TABLES[domain][hostCode] ?? "E_INTERNAL";
}
function pendingResponseErrorCode(reason) {
	switch (reason) {
		case "not-pending": return "E_NOT_FOUND";
		case "bad-response": return "E_PROTOCOL";
		case "transport": return "E_INTERNAL";
	}
}
/** 与 pendingResponseErrorCode 配套的可读信息，同一处维护。 */
function pendingResponseMessage(kind, reason) {
	switch (reason) {
		case "not-pending": return kind + " not pending";
		case "bad-response": return kind + " answer rejected by host: answer does not match the asked questions";
		case "transport": return "host connection failed while answering " + kind;
	}
}
//#endregion
//#region src/connection-policy.ts
const AUTH_TIMEOUT_MS = 35e3;
const IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
/**
* clientSendId / clientRequestId 的形态：13 位纪元前缀 + UUID。
* wire 层据此校验载荷，journal 侧据此守卫（见 dispatch-journal.ts）。
*/
function validSendId(id) {
	return typeof id === "string" && /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
function sanitizeDeviceField(value, maxChars) {
	return (typeof value === "string" ? value : String(value ?? "")).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxChars);
}
/**
* Runtime shape guard for a frame after JSON.parse. The old `as Envelope`
* cast alone let JSON `null` reach `env.v` and let a missing or mistyped
* `type` reach the registry lookup's string operations — one anonymous frame
* could crash the host process. Reject anything that is not a plain object
* with a numeric version and a non-empty string type, so field access below
* is always safe. The payload is intentionally opaque here; each row
* validates its own payload shape (see the per-row `validate` in
* wire-registry.ts).
*/
function isEnvelope(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const frame = value;
	if (typeof frame.v !== "number") return false;
	if (typeof frame.type !== "string" || frame.type.length === 0) return false;
	if (frame.id !== void 0 && typeof frame.id !== "string") return false;
	if (frame.ts !== void 0 && typeof frame.ts !== "number") return false;
	if (frame.seq !== void 0 && typeof frame.seq !== "number") return false;
	return true;
}
/**
* 下行广播与重放授权。未知帧类型 fail-closed：不下发。
*
* `s2c.session.tail` 与 `s2c.history.page` 是 PROTOCOL.md 下行权限表里的类型，
* 但由连接点对点直推（不经 record()/重放环）。条目保留：将来任何把它们送进
* ring 的路径都会自动受到这里的 gate 约束，而不是静默全量广播。
*/
const PUSH_SCOPE_BY_TYPE = {
	"s2c.session.event": "sessions.read",
	"s2c.sessions.delta": "sessions.read",
	"s2c.session.tail": "sessions.read",
	"s2c.history.page": "sessions.read",
	"s2c.pending.approval": "interactions.respond",
	"s2c.pending.question": "interactions.respond",
	"s2c.pending.cleared": "interactions.respond",
	"s2c.schedule.changed": "schedule.manage"
};
function pushScopeFor(type, payload) {
	const fixed = PUSH_SCOPE_BY_TYPE[type];
	if (fixed !== void 0) return fixed;
	if (type === "s2c.notify") {
		const category = payload?.category;
		if (category === "approval.required" || category === "question.asked") return "interactions.respond";
		if (category === "turn.completed" || category === "session.error") return "sessions.read";
	}
}
function sanitizeImageName(value) {
	return value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 120);
}
function sanitizeDocumentField(value, maxChars) {
	return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, maxChars);
}
//#endregion
//#region src/auth-rate-limit.ts
const DEFAULT_AUTH_RATE_POLICY = {
	windowMs: 6e4,
	attemptsPerSource: 12,
	globalAttempts: 120,
	maxUnauthenticatedPerSource: 2,
	failureWindowMs: 6e5,
	failuresBeforeBlock: 5,
	blockMs: 9e5,
	maxSources: 4096
};
const noop = () => {};
/** Bounded in-memory protection for anonymous authentication attempts. */
var AuthRateLimiter = class {
	policy;
	sources = /* @__PURE__ */ new Map();
	globalAttempts = [];
	constructor(policy = DEFAULT_AUTH_RATE_POLICY) {
		this.policy = policy;
	}
	admit(source, now = Date.now()) {
		const state = this.source(source, now);
		if (state === null) return {
			ok: false,
			retryAfterMs: this.policy.windowMs,
			release: noop
		};
		this.prune(state, now);
		state.lastSeen = now;
		if (state.blockedUntil > now) return {
			ok: false,
			retryAfterMs: state.blockedUntil - now,
			release: noop
		};
		if (state.active >= this.policy.maxUnauthenticatedPerSource) return {
			ok: false,
			retryAfterMs: this.policy.windowMs,
			release: noop
		};
		if (state.attempts.length >= this.policy.attemptsPerSource) return {
			ok: false,
			retryAfterMs: state.attempts[0] + this.policy.windowMs - now,
			release: noop
		};
		this.globalAttempts = this.globalAttempts.filter((ts) => ts > now - this.policy.windowMs);
		if (this.globalAttempts.length >= this.policy.globalAttempts) return {
			ok: false,
			retryAfterMs: this.globalAttempts[0] + this.policy.windowMs - now,
			release: noop
		};
		state.attempts.push(now);
		this.globalAttempts.push(now);
		state.active += 1;
		let released = false;
		return {
			ok: true,
			retryAfterMs: 0,
			release: () => {
				if (released) return;
				released = true;
				state.active = Math.max(0, state.active - 1);
			}
		};
	}
	recordFailure(source, now = Date.now()) {
		const state = this.source(source, now);
		if (state === null) return {
			blocked: true,
			newlyBlocked: false,
			retryAfterMs: this.policy.blockMs
		};
		this.prune(state, now);
		state.lastSeen = now;
		const wasBlocked = state.blockedUntil > now;
		state.failures.push(now);
		if (state.failures.length >= this.policy.failuresBeforeBlock) state.blockedUntil = Math.max(state.blockedUntil, now + this.policy.blockMs);
		return {
			blocked: state.blockedUntil > now,
			newlyBlocked: !wasBlocked && state.blockedUntil > now,
			retryAfterMs: Math.max(0, state.blockedUntil - now)
		};
	}
	recordSuccess(source, now = Date.now()) {
		const state = this.sources.get(source);
		if (state === void 0) return;
		state.failures = [];
		state.blockedUntil = 0;
		state.lastSeen = now;
	}
	source(source, now) {
		const existing = this.sources.get(source);
		if (existing !== void 0) return existing;
		if (this.sources.size >= this.policy.maxSources) this.pruneSources(now);
		if (this.sources.size >= this.policy.maxSources) return null;
		const state = {
			attempts: [],
			failures: [],
			blockedUntil: 0,
			active: 0,
			lastSeen: now
		};
		this.sources.set(source, state);
		return state;
	}
	prune(state, now) {
		state.attempts = state.attempts.filter((ts) => ts > now - this.policy.windowMs);
		state.failures = state.failures.filter((ts) => ts > now - this.policy.failureWindowMs);
		if (state.blockedUntil <= now) state.blockedUntil = 0;
	}
	pruneSources(now) {
		const staleBefore = now - Math.max(this.policy.failureWindowMs, this.policy.blockMs);
		for (const [source, state] of this.sources) {
			this.prune(state, now);
			if (state.active === 0 && state.blockedUntil === 0 && state.lastSeen < staleBefore) this.sources.delete(source);
		}
	}
};
//#endregion
//#region src/device-auth.ts
function getPairingCodeTtlMs() {
	return Number(process.env.DEEPPILOT_PAIRING_TTL_MS) || 3e5;
}
const AUTH_CHALLENGE_TTL_MS = 3e4;
const DEVICE_SCOPES = [
	"sessions.read",
	"prompt.send",
	"sessions.manage",
	"interactions.respond",
	"notifications.register",
	"schedule.manage"
];
const DEFAULT_DEVICE_SCOPES = DEVICE_SCOPES;
async function loadOrCreateHostAudience(path) {
	try {
		const existing = (await readFile(path, "utf8")).trim();
		if (/^deeppilot:[A-Za-z0-9_-]{22}$/.test(existing)) return existing;
		throw new Error(`host audience is malformed at ${path}`);
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	const audience = "deeppilot:" + randomBytes(16).toString("base64url");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, audience + "\n", { mode: 384 });
	return audience;
}
function b64urlText(value) {
	return Buffer.from(value, "utf8").toString("base64url");
}
/**
* Cross-language signature input. Text fields are base64url encoded before
* joining so names cannot create ambiguous separators. Decimal timestamps
* and cursor values are finite integers, or `-` when the cursor is absent.
*/
function canonicalAuthChallenge(fields) {
	const cursor = fields.resumeCursor === void 0 ? "-" : String(fields.resumeCursor);
	return Buffer.from([
		"deeppilot-auth-v2",
		`device-id:${b64urlText(fields.deviceId)}`,
		`nonce:${fields.nonce}`,
		`audience:${b64urlText(fields.audience)}`,
		`issued-at:${fields.issuedAt}`,
		`expires-at:${fields.expiresAt}`,
		`device-name:${b64urlText(fields.deviceName)}`,
		`app-version:${b64urlText(fields.appVersion)}`,
		`resume-cursor:${cursor}`
	].join("\n"), "utf8");
}
/** Accept only an uncompressed ANSI X9.63 P-256 public key (65 bytes). */
function parseP256PublicKey(encoded) {
	const raw = Buffer.from(encoded, "base64url");
	if (raw.length !== 65 || raw[0] !== 4) throw new TypeError("publicKey must be an uncompressed P-256 X9.63 key");
	const spkiPrefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
	const key = createPublicKey({
		key: Buffer.concat([spkiPrefix, raw]),
		format: "der",
		type: "spki"
	});
	if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new TypeError("publicKey must use P-256");
	return {
		key,
		raw
	};
}
function deviceIdForPublicKey(publicKey) {
	const { raw } = parseP256PublicKey(publicKey);
	return createHash("sha256").update(raw).digest("base64url");
}
function fingerprintForPublicKey(publicKey) {
	const { raw } = parseP256PublicKey(publicKey);
	return createHash("sha256").update(raw).digest("hex");
}
function verifyAuthProof(publicKey, fields, signature) {
	try {
		const { key } = parseP256PublicKey(publicKey);
		const der = Buffer.from(signature, "base64url");
		if (der.length < 64 || der.length > 80) return false;
		return verify("sha256", canonicalAuthChallenge(fields), key, der);
	} catch {
		return false;
	}
}
function normalizeDeviceScopes(value) {
	if (!Array.isArray(value)) return [...DEFAULT_DEVICE_SCOPES];
	const allowed = new Set(DEVICE_SCOPES);
	return [...new Set(value.filter((scope) => typeof scope === "string" && allowed.has(scope)))];
}
/** One active, single-use pairing grant per plugin runtime. */
var PairingCodeManager = class {
	active = null;
	issue(now = Date.now()) {
		const grant = {
			code: randomBytes(24).toString("base64url"),
			expiresAt: now + getPairingCodeTtlMs()
		};
		this.active = grant;
		return { ...grant };
	}
	consume(presented, now = Date.now()) {
		const active = this.active;
		if (active === null || now > active.expiresAt) {
			this.active = null;
			return false;
		}
		const expected = Buffer.from(active.code);
		const actual = Buffer.from(presented);
		const matches = expected.length === actual.length && timingSafeEqual(expected, actual);
		if (matches) this.active = null;
		return matches;
	}
	invalidate() {
		this.active = null;
	}
};
function createAuthChallenge(audience, now = Date.now()) {
	return {
		nonce: randomBytes(24).toString("base64url"),
		audience,
		issuedAt: now,
		expiresAt: now + AUTH_CHALLENGE_TTL_MS
	};
}
//#endregion
//#region src/wire-interaction.ts
/**
* 交互特性的 wire 行：回答待决的 approval 与 question。
*
* 两帧共用 `interactions.respond`。失败的三种结局（没有这条待决 / Host 拒收
* 答案 / 传输失败）由 wire-errors 的词表翻译成 wire 错误码与可读信息——此前
* 这条映射住在 connection-policy，和 scope 表、常量混在一起。
*/
const RESPOND = ["interactions.respond"];
const interactionRows = [{
	type: "c2s.approval.respond",
	stage: "authenticated",
	scopes: RESPOND,
	doc: "PROTOCOL.md c2s.approval.respond",
	validate: (payload) => {
		const checked = payloadObject(payload);
		if (!checked.ok) return checked;
		const p = checked.value;
		if (!isText(p.requestId)) return reject$1("E_PROTOCOL", "invalid requestId");
		if (!["allow", "deny"].includes(p.decision) || !isOptionalField(p, "reason", (v) => isText(v, 65536, false))) return reject$1("E_PROTOCOL", "invalid approval response");
		return checked;
	},
	handle: async (ctx, payload) => {
		const decision = payload.decision;
		if (decision !== "allow" && decision !== "deny") return ctx.fail("E_PROTOCOL", "requestId and decision required");
		const outcome = await ctx.bridge.respondApproval(payload.requestId, decision, typeof payload.reason === "string" ? payload.reason : void 0);
		if (!outcome.ok) {
			const reason = outcome.reason;
			return ctx.fail(pendingResponseErrorCode(reason), pendingResponseMessage("approval", reason));
		}
		ctx.send("s2c.ack", {});
	}
}, {
	type: "c2s.question.respond",
	stage: "authenticated",
	scopes: RESPOND,
	doc: "PROTOCOL.md c2s.question.respond",
	validate: (payload) => {
		const checked = payloadObject(payload);
		if (!checked.ok) return checked;
		const p = checked.value;
		if (!isText(p.requestId)) return reject$1("E_PROTOCOL", "invalid requestId");
		if (!Array.isArray(p.answers) || p.answers.length > 100) return reject$1("E_PROTOCOL", "invalid answers");
		const ids = /* @__PURE__ */ new Set();
		for (const answer of p.answers) {
			if (!answer || typeof answer !== "object" || Array.isArray(answer) || !isText(answer.id) || ids.has(answer.id) || !Array.isArray(answer.selected) || answer.selected.length > 100 || !answer.selected.every((v) => isText(v, 4096)) || answer.custom !== void 0 && !isText(answer.custom, 65536)) return reject$1("E_PROTOCOL", "invalid answer");
			ids.add(answer.id);
		}
		return checked;
	},
	handle: async (ctx, payload) => {
		if (!Array.isArray(payload.answers)) return ctx.fail("E_PROTOCOL", "requestId and answers required");
		const outcome = await ctx.bridge.respondQuestion(payload.requestId, payload.answers);
		if (!outcome.ok) {
			const reason = outcome.reason;
			return ctx.fail(pendingResponseErrorCode(reason), pendingResponseMessage("question", reason));
		}
		ctx.send("s2c.ack", {});
	}
}];
//#endregion
//#region src/wire-device.ts
/**
* 设备生命周期特性的 wire 行：自撤销（解绑）。
*
* 该帧不要求任何 scope：设备生命周期操作不能因为 scope 被收窄而无法解绑，
* 否则它只会永远留在离线推送目标集合里（PROTOCOL.md c2s.device.revoke）。
* widget 策略取 `handler`：小组件的拒必须是「小组件不得解绑设备」这个具体
* 理由，通用只读门禁只会说 read-only。
*/
const deviceRows = [{
	type: "c2s.device.revoke",
	stage: "authenticated",
	scopes: [],
	widgetPolicy: "handler",
	doc: "PROTOCOL.md c2s.device.revoke",
	validate: (payload) => {
		const checked = payloadObject(payload);
		if (!checked.ok) return checked;
		if (!isOptionalField(checked.value, "deviceId", (v) => isText(v))) return reject$1("E_PROTOCOL", "invalid deviceId");
		if (checked.value.deviceId !== void 0 && typeof checked.value.deviceId !== "string") return reject$1("E_PROTOCOL", "deviceId must be a string");
		return checked;
	},
	handle: async (ctx, payload) => {
		const deviceId = ctx.deviceId;
		if (deviceId === void 0) return ctx.fail("E_INTERNAL", "device identity unavailable");
		if (typeof payload.deviceId === "string" && payload.deviceId !== deviceId) return ctx.fail("E_FORBIDDEN", "deviceId does not match the authenticated device");
		if (ctx.widgetClient) return ctx.fail("E_FORBIDDEN", "widget connection cannot revoke its device");
		ctx.devices.revoke(deviceId, Date.now());
		ctx.markRevoked();
		try {
			await ctx.revokeSiblings(deviceId);
		} catch (error) {
			if (ctx.debug) ctx.log("device revoke hook failed: " + String(error));
		}
		ctx.send("s2c.ack", { revoked: true });
		ctx.close(4401, "device revoked");
	}
}];
//#endregion
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
/** Create or repair the canonical secret-bearing directory as owner-only. */
async function ensurePrivateBridgeDataDir() {
	const target = bridgeDataDir();
	await mkdir(target, {
		recursive: true,
		mode: 448
	});
	await chmod(target, 448);
	return target;
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
/** Name shown to the operator: a user label when present, otherwise the app-reported model name. */
function deviceDisplayName(record) {
	return record.customName?.trim() ? record.customName : record.deviceName;
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
	/** Register one public key after a valid, single-use pairing grant. */
	register(record, now) {
		const deviceId = deviceIdForPublicKey(record.publicKey);
		const existing = this.devices.get(deviceId);
		if (!existing && this.devices.size >= 64) throw new Error("device registry is full");
		const next = {
			deviceId,
			deviceName: record.deviceName,
			...existing?.customName ? { customName: existing.customName } : {},
			appVersion: record.appVersion,
			publicKey: record.publicKey,
			fingerprint: fingerprintForPublicKey(record.publicKey),
			scopes: normalizeDeviceScopes(record.scopes),
			firstSeenTs: existing?.firstSeenTs ?? now,
			lastSeenTs: now,
			...existing?.apns ? { apns: existing.apns } : {},
			...existing?.widgetApns ? { widgetApns: existing.widgetApns } : {},
			...existing?.liveActivity ? { liveActivity: existing.liveActivity } : {}
		};
		this.devices.set(deviceId, next);
		this.flush();
		return structuredClone(next);
	}
	/** Return an active cryptographic identity. */
	authorized(deviceId) {
		const record = this.devices.get(deviceId);
		if (!record?.publicKey || record.revokedAt !== void 0) return void 0;
		return record;
	}
	markAuthenticated(deviceId, deviceName, appVersion, now) {
		const record = this.authorized(deviceId);
		if (!record) return;
		record.deviceName = deviceName || record.deviceName;
		record.appVersion = appVersion || record.appVersion;
		record.lastSeenTs = now;
		this.flush();
	}
	/**
	* Set or clear the operator-facing device label. The phone-reported name is
	* intentionally left untouched so a reconnect cannot erase this value.
	* Returns the effective display name, or null when the device is not active.
	*/
	async setCustomName(deviceId, customName) {
		const record = this.authorized(deviceId);
		if (!record) return null;
		const normalized = customName === null ? "" : sanitizeDeviceField(customName, 64);
		if (normalized === (record.customName ?? "")) return deviceDisplayName(record);
		const previous = record.customName;
		if (normalized === "") delete record.customName;
		else record.customName = normalized;
		try {
			await this.flush();
		} catch (error) {
			if (previous === void 0) delete record.customName;
			else record.customName = previous;
			throw error;
		}
		return deviceDisplayName(record);
	}
	revoke(deviceId, now) {
		const record = this.devices.get(deviceId);
		if (!record || record.revokedAt !== void 0) return false;
		record.revokedAt = now;
		delete record.apns;
		delete record.widgetApns;
		delete record.liveActivity;
		this.flush();
		return true;
	}
	setScopes(deviceId, scopes) {
		const record = this.authorized(deviceId);
		if (!record) return null;
		record.scopes = normalizeDeviceScopes(scopes);
		this.flush();
		return [...record.scopes];
	}
	list() {
		return [...this.devices.values()].map((record) => structuredClone(record));
	}
	/**
	* Store (or refresh) the APNs registration of a paired device. Idempotent:
	* an unchanged registration does not rewrite the registry file, so the
	* app's re-register-on-every-handshake policy stays write-quiet.
	*/
	setPushToken(deviceId, token, environment, categories, now) {
		const normalized = token.toLowerCase();
		if (!isValidApnsToken(normalized)) return;
		const record = this.authorized(deviceId);
		if (!record) return;
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
		this.detachDuplicateToken("apns", normalized, deviceId);
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
	setLiveActivity(deviceId, registration) {
		const record = this.authorized(deviceId);
		if (!record || !isValidApnsToken(registration.token)) return;
		const old = record.liveActivity;
		record.liveActivity = old?.activityId === registration.activityId ? {
			...registration,
			expiresAt: old.expiresAt,
			endedState: old.endedState
		} : registration;
		this.flush();
	}
	endLiveActivity(deviceId, token, state) {
		const registration = this.devices.get(deviceId)?.liveActivity;
		if (!registration || registration.token !== token || registration.endedState) return;
		registration.endedState = state;
		this.flush();
	}
	clearLiveActivity(deviceId, activityId, token) {
		const record = this.devices.get(deviceId);
		if (record?.liveActivity?.activityId !== activityId || token !== void 0 && record.liveActivity.token !== token) return;
		delete record.liveActivity;
		this.flush();
	}
	setWidgetPushToken(deviceId, token, environment, now) {
		const record = this.authorized(deviceId);
		if (!record || !isValidApnsToken(token)) return;
		const normalized = token.toLowerCase();
		const previous = record.widgetApns;
		if (previous?.token === normalized && previous.environment === environment && now - previous.updatedAt < 36e5) return;
		this.detachDuplicateToken("widgetApns", normalized, deviceId);
		record.widgetApns = {
			token: normalized,
			environment,
			updatedAt: now
		};
		this.flush();
	}
	/** Compare-and-clear protects a rotated token from a delayed APNs rejection. */
	clearWidgetPushToken(deviceId, token) {
		const record = this.devices.get(deviceId);
		if (record?.widgetApns?.token !== token) return;
		delete record.widgetApns;
		this.flush();
	}
	/**
	* One physical device owns one APNs token, but a re-pair or a botched unbind
	* can leave the same token attached to a second deviceId. Registering it
	* under `keepDeviceId` detaches it from every other record — only that one
	* token field, never the other record's pairing key or scopes. No flush of
	* its own: the caller batches it with the write that follows, so a single
	* registry write covers both changes.
	*/
	detachDuplicateToken(field, token, keepDeviceId) {
		for (const record of this.devices.values()) {
			if (record.deviceId === keepDeviceId) continue;
			if (field === "apns") {
				if (record.apns?.token === token) delete record.apns;
			} else if (record.widgetApns?.token === token) delete record.widgetApns;
		}
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
			version: 2,
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
//#region src/wire-push.ts
/** Live Activity 需要的三个 scope：通知注册 + 会话读取 + 交互应答。 */
const LIVE_ACTIVITY_SCOPES = [
	"notifications.register",
	"sessions.read",
	"interactions.respond"
];
/** 小组件总览需要的三个 scope：与 Live Activity 同组（PROTOCOL.md 下行权限一节）。 */
const WIDGET_PUSH_SCOPES = [
	"notifications.register",
	"sessions.read",
	"interactions.respond"
];
/** enrollKey 的清洗：只保留可打印 ASCII，截到 128（与迁移前逐字一致）。 */
function cleanEnrollKey(value) {
	return typeof value === "string" ? value.trim().replace(/[^\x20-\x7e]/g, "").slice(0, 128) : "";
}
const pushRows = [
	{
		type: "c2s.push.register",
		stage: "authenticated",
		scopes: ["notifications.register"],
		doc: "PROTOCOL.md c2s.push.register",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const p = checked.value;
			if (!isValidApnsToken(typeof p.deviceToken === "string" ? p.deviceToken.trim() : "")) return reject$1("E_PROTOCOL", "hex deviceToken (32-512 chars) required");
			if (p.environment !== void 0 && p.environment !== "production" && p.environment !== "development") return reject$1("E_PROTOCOL", "invalid APNs environment");
			if (!isOptionalField(p, "enrollKey", (v) => isText(v, 128))) return reject$1("E_PROTOCOL", "invalid enrollKey");
			if (p.categories !== void 0 && (typeof p.categories !== "object" || p.categories === null || Array.isArray(p.categories) || Object.values(p.categories).some((v) => typeof v !== "boolean"))) return reject$1("E_PROTOCOL", "invalid categories");
			return checked;
		},
		handle: async (ctx, payload) => {
			const deviceId = ctx.deviceId;
			if (deviceId === void 0) return ctx.fail("E_INTERNAL", "device identity unavailable");
			const token = String(payload.deviceToken).trim();
			const environment = payload.environment === "production" ? "production" : "development";
			const categories = typeof payload.categories === "object" && payload.categories !== null ? payload.categories : void 0;
			if (typeof payload.enrollKey === "string") {
				const enrollKey = cleanEnrollKey(payload.enrollKey);
				if (enrollKey.length >= 8 && enrollKey.length <= 128) await ctx.enrollPushKey(enrollKey);
			}
			if (!ctx.devices.authorized(deviceId)?.scopes?.includes("notifications.register")) return ctx.fail("E_FORBIDDEN", "device authorization changed");
			ctx.devices.setPushToken(deviceId, token, environment, categories, Date.now());
			if (ctx.bridge.capabilities.push !== true) {
				if (ctx.debug) ctx.log("push register held: bridge not ready");
				return ctx.fail("E_UNSUPPORTED", "push is not configured on this bridge");
			}
			if (ctx.debug) ctx.log("push token registered env=" + environment);
			ctx.send("s2c.ack", { enabled: true });
		}
	},
	{
		type: "c2s.widget.push.register",
		stage: "authenticated",
		scopes: WIDGET_PUSH_SCOPES,
		widgetPolicy: "allowed",
		doc: "PROTOCOL.md c2s.widget.push.register",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const p = checked.value;
			if (!isValidApnsToken(typeof p.deviceToken === "string" ? p.deviceToken.trim() : "")) return reject$1("E_PROTOCOL", "hex deviceToken (32-512 chars) required");
			if (p.environment !== void 0 && p.environment !== "production" && p.environment !== "development") return reject$1("E_PROTOCOL", "invalid APNs environment");
			if (!isOptionalField(p, "enrollKey", (v) => isText(v, 128))) return reject$1("E_PROTOCOL", "invalid enrollKey");
			return checked;
		},
		handle: async (ctx, payload) => {
			const deviceId = ctx.deviceId;
			if (deviceId === void 0) return ctx.fail("E_INTERNAL", "device identity unavailable");
			const token = String(payload.deviceToken).trim();
			const environment = payload.environment === "production" ? "production" : "development";
			if (typeof payload.enrollKey === "string") {
				const enrollKey = cleanEnrollKey(payload.enrollKey);
				if (enrollKey.length >= 8 && enrollKey.length <= 128) await ctx.enrollPushKey(enrollKey);
			}
			const record = ctx.devices.authorized(deviceId);
			if (!record?.scopes?.includes("notifications.register") || !record.scopes.includes("sessions.read") || !record.scopes.includes("interactions.respond")) return ctx.fail("E_FORBIDDEN", "device authorization changed");
			ctx.devices.setWidgetPushToken(deviceId, token, environment, Date.now());
			if (ctx.bridge.capabilities.push !== true) {
				if (ctx.debug) ctx.log("push register held: bridge not ready");
				return ctx.fail("E_UNSUPPORTED", "push is not configured on this bridge");
			}
			ctx.send("s2c.ack", { enabled: true });
		}
	},
	{
		type: "c2s.liveActivity.unregister",
		stage: "authenticated",
		scopes: ["notifications.register"],
		doc: "PROTOCOL.md c2s.liveActivity.unregister",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!isText(checked.value.activityId, 128)) return reject$1("E_PROTOCOL", "invalid activityId");
			return checked;
		},
		handle: (ctx, payload) => {
			const activityId = payload.activityId;
			if (ctx.pendingLiveActivityId === activityId) {
				ctx.nextLiveActivityGeneration();
				ctx.setPendingLiveActivityId(void 0);
			}
			ctx.devices.clearLiveActivity(ctx.deviceId, activityId);
			ctx.send("s2c.ack", {});
		}
	},
	{
		type: "c2s.liveActivity.register",
		stage: "authenticated",
		scopes: LIVE_ACTIVITY_SCOPES,
		doc: "PROTOCOL.md c2s.liveActivity.register",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const p = checked.value;
			if (!isText(p.activityId, 128)) return reject$1("E_PROTOCOL", "invalid activityId");
			if (!isText(p.sessionId) || typeof p.deviceToken !== "string" || !/^[0-9a-fA-F]{32,512}$/.test(p.deviceToken) || !["development", "production"].includes(p.environment) || !isOptionalField(p, "enrollKey", (v) => isText(v, 128))) return reject$1("E_PROTOCOL", "invalid live activity registration");
			return checked;
		},
		handle: async (ctx, payload) => {
			const deviceId = ctx.deviceId;
			if (deviceId === void 0) return ctx.fail("E_INTERNAL", "device identity unavailable");
			const activityId = payload.activityId;
			const generation = ctx.nextLiveActivityGeneration();
			ctx.setPendingLiveActivityId(activityId);
			if (typeof payload.enrollKey === "string" && payload.enrollKey) await ctx.enrollPushKey(payload.enrollKey);
			if (generation !== ctx.liveActivityGeneration) return ctx.fail("E_BUSY", "live activity registration superseded");
			const record = ctx.devices.authorized(deviceId);
			if (!record || !LIVE_ACTIVITY_SCOPES.every((scope) => record.scopes?.includes(scope))) return ctx.fail("E_FORBIDDEN", "live activity permissions required");
			if (!ctx.bridge.listSessions().some((row) => row.id === payload.sessionId)) return ctx.fail("E_NOT_FOUND", "session not found");
			const previous = record.liveActivity;
			if (previous?.activityId === activityId && previous.sessionId !== payload.sessionId) return ctx.fail("E_PROTOCOL", "activity is bound to another session");
			ctx.devices.setLiveActivity(record.deviceId, {
				activityId,
				sessionId: payload.sessionId,
				token: String(payload.deviceToken).toLowerCase(),
				environment: payload.environment,
				updatedAt: Date.now(),
				expiresAt: Date.now() + 288e5
			});
			ctx.bridge.refreshLiveActivities();
			ctx.send("s2c.ack", { enabled: ctx.bridge.capabilities.push });
		}
	}
];
//#endregion
//#region src/wire-schedule.ts
/**
* 定时任务特性的 wire 行：列表、历史、创建、修改、删除。
*
* scope 取 `schedule.manage` + `sessions.read`：PROTOCOL.md scope 映射表写明
* 「`schedule.manage` 定时任务/提醒的列表、历史、创建、修改和删除；同时需要
* `sessions.read` 才能读取任务内容」。迁移前这条组合一半住在 requiredScope、
* 一半住在 connection.ts 调用点的一行补充规则里（334-336），现在是一行声明。
*
* 五个帧共享一个能力位 `schedules`；该位现在只要求 Schedule 服务存在
* （见 host-capabilities.ts 的 G4 修正）。
*/
/** PROTOCOL.md scope 映射表：schedule.manage 需搭配 sessions.read。 */
const SCHEDULE_SCOPES = ["schedule.manage", "sessions.read"];
const scheduleRows = [
	{
		type: "c2s.schedule.list",
		stage: "authenticated",
		scopes: SCHEDULE_SCOPES,
		capability: "schedules",
		doc: "PROTOCOL.md c2s.schedule.list",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!isText(checked.value.sessionId)) return reject$1("E_PROTOCOL", "invalid sessionId");
			return checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.listSchedules(payload.sessionId);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.schedule.snapshot", {
				sessionId: payload.sessionId,
				tasks: result.value
			});
		}
	},
	{
		type: "c2s.schedule.history",
		stage: "authenticated",
		scopes: SCHEDULE_SCOPES,
		capability: "schedules",
		doc: "PROTOCOL.md c2s.schedule.history",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!isText(checked.value.sessionId) || !isText(checked.value.id) || !isInteger(checked.value.limit, 1, 100) || !isOptionalField(checked.value, "before", (v) => isText(v))) return reject$1("E_PROTOCOL", "invalid schedule history");
			return checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.scheduleHistory(payload.sessionId, payload.id, payload.limit, payload.before);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.schedule.history", {
				sessionId: payload.sessionId,
				history: result.value
			});
		}
	},
	{
		type: "c2s.schedule.create",
		stage: "authenticated",
		scopes: SCHEDULE_SCOPES,
		capability: "schedules",
		doc: "PROTOCOL.md c2s.schedule.create",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const p = checked.value;
			if (!validSendId(p.clientRequestId) || !isText(p.sessionId) || !isText(p.title, 120) || !isText(p.prompt, 262144)) return reject$1("E_PROTOCOL", "invalid schedule create fields");
			if ([
				"after_seconds",
				"at",
				"every_seconds",
				"daily",
				"weekly",
				"cron"
			].filter((key) => p[key] !== void 0).length !== 1) return reject$1("E_PROTOCOL", "schedule requires exactly one selector");
			if (p.after_seconds !== void 0 && !isInteger(p.after_seconds, 1, Number.MAX_SAFE_INTEGER)) return reject$1("E_PROTOCOL", "invalid after_seconds");
			if (p.every_seconds !== void 0 && !isInteger(p.every_seconds, 60, Number.MAX_SAFE_INTEGER)) return reject$1("E_PROTOCOL", "invalid every_seconds");
			if (p.at !== void 0 && typeof p.at !== "string" && (typeof p.at !== "object" || p.at === null || Array.isArray(p.at))) return reject$1("E_PROTOCOL", "invalid at selector");
			return accept(p);
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.createSchedule(ctx.deviceId, payload);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.schedule.updated", {
				clientRequestId: payload.clientRequestId,
				sessionId: payload.sessionId,
				task: result.value,
				...result.replayed ? { replayed: true } : {}
			});
		}
	},
	{
		type: "c2s.schedule.update",
		stage: "authenticated",
		scopes: SCHEDULE_SCOPES,
		capability: "schedules",
		doc: "PROTOCOL.md c2s.schedule.update",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const p = checked.value;
			if (!validSendId(p.clientRequestId) || !isText(p.sessionId) || !isText(p.id) || p.expected === void 0 || typeof p.expected !== "object" || Array.isArray(p.expected)) return reject$1("E_PROTOCOL", "invalid schedule update fields");
			if (!isOptionalField(p, "title", (v) => isText(v, 120)) || !isOptionalField(p, "prompt", (v) => isText(v, 262144))) return reject$1("E_PROTOCOL", "invalid schedule update content");
			if (p.change !== void 0 && (typeof p.change !== "object" || p.change === null || Array.isArray(p.change))) return reject$1("E_PROTOCOL", "invalid schedule timing change");
			return accept(p);
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.updateSchedule(ctx.deviceId, payload);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.schedule.updated", {
				clientRequestId: payload.clientRequestId,
				sessionId: payload.sessionId,
				task: result.value,
				...result.replayed ? { replayed: true } : {}
			});
		}
	},
	{
		type: "c2s.schedule.delete",
		stage: "authenticated",
		scopes: SCHEDULE_SCOPES,
		capability: "schedules",
		doc: "PROTOCOL.md c2s.schedule.delete",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!validSendId(checked.value.clientRequestId) || !isText(checked.value.sessionId) || !isText(checked.value.id)) return reject$1("E_PROTOCOL", "invalid schedule delete fields");
			return checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.deleteSchedule(ctx.deviceId, {
				sessionId: payload.sessionId,
				id: payload.id,
				clientRequestId: payload.clientRequestId
			});
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.schedule.updated", {
				clientRequestId: payload.clientRequestId,
				sessionId: payload.sessionId,
				deleted: true,
				...result.replayed ? { replayed: true } : {}
			});
		}
	}
];
//#endregion
//#region src/wire-session.ts
/**
* 会话特性的 wire 行：列表/归档、打开与关闭、创建/分支/重命名/取消、历史与
* 附件、模型目录与切换、prompt 投递。
*
* handler 体从 connection.ts 的 switch 原样迁来，`this.` 换成 `ctx.`；
* 该校验的判定与顺序和迁移前一致——先是原 request-validation 的形状检查，
* 后是原 case 体内的形状检查——因此同一载荷在新旧路径上得到同一个错误码与
* 同一条信息（tests/wire-parity.test.ts 在迁移期逐条对等，之后由
* tests/wire-rows.test.ts 固定为显式期望）。
*/
/** 会话读取域的帧共同要求 sessions.read（PROTOCOL.md scope 映射表）。 */
const READ = ["sessions.read"];
const MANAGE = ["sessions.manage"];
/** 原 request-validation 的 sessionId 检查：所有 c2s.session.* 共用的第一道。 */
function requireSessionId(payload) {
	if (!isText(payload.sessionId)) return reject$1("E_PROTOCOL", "invalid sessionId");
}
const sessionRows = [
	{
		type: "c2s.ping",
		stage: "pre-auth",
		scopes: [],
		widgetPolicy: "allowed",
		doc: "PROTOCOL.md 连接与鉴权",
		handle: (ctx) => {
			ctx.send("s2c.pong", { serverTime: Date.now() });
		}
	},
	{
		type: "c2s.auth.prove",
		stage: "pre-auth",
		scopes: [],
		widgetPolicy: "allowed",
		doc: "PROTOCOL.md 连接与鉴权",
		handle: (ctx) => ctx.prove()
	},
	{
		type: "c2s.sessions.list",
		stage: "authenticated",
		scopes: READ,
		widgetPolicy: "allowed",
		doc: "PROTOCOL.md c2s.sessions.list",
		validate: (payload) => payloadObject(payload),
		handle: (ctx) => {
			ctx.send("s2c.sessions.snapshot", {
				full: true,
				sessions: ctx.bridge.listSessions()
			});
		}
	},
	{
		type: "c2s.sessions.archived",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.sessions.archived",
		validate: (payload) => payloadObject(payload),
		handle: (ctx) => {
			ctx.send("s2c.sessions.archived.snapshot", { sessions: ctx.bridge.listArchivedSessions() });
		}
	},
	{
		type: "c2s.pending.list",
		stage: "authenticated",
		scopes: ["interactions.respond"],
		widgetPolicy: "allowed",
		capability: "pendingSnapshot",
		doc: "PROTOCOL.md c2s.pending.list",
		validate: (payload) => payloadObject(payload),
		handle: (ctx) => {
			ctx.send("s2c.pending.snapshot", ctx.bridge.pendingSnapshot());
		}
	},
	{
		type: "c2s.workspaces.list",
		stage: "authenticated",
		scopes: READ,
		capability: "projectSelection",
		doc: "PROTOCOL.md c2s.workspaces.list",
		validate: (payload) => payloadObject(payload),
		handle: async (ctx) => {
			const result = await ctx.bridge.listWorkspaces();
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.workspaces.snapshot", { workspaces: result.value });
		}
	},
	{
		type: "c2s.workspace.create",
		stage: "authenticated",
		scopes: MANAGE,
		capability: "projectSelection",
		doc: "PROTOCOL.md c2s.workspace.create",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!isText(checked.value.path, 32768)) return reject$1("E_PROTOCOL", "invalid path");
			return checked;
		},
		handle: async (ctx, payload) => {
			const path = String(payload.path).trim();
			if (!path) return ctx.fail("E_PROTOCOL", "non-empty path required");
			const result = await ctx.bridge.createWorkspace(path);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.workspace.created", result.value);
		}
	},
	{
		type: "c2s.directory.list",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.directory.list",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!isOptionalField(checked.value, "path", (v) => isText(v, 32768, false))) return reject$1("E_PROTOCOL", "invalid path");
			if (checked.value.path !== void 0 && typeof checked.value.path !== "string") return reject$1("E_PROTOCOL", "path must be a string");
			return checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.listDirectory(payload.path);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.directory.listing", result.value);
		}
	},
	{
		type: "c2s.directory.pick",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.directory.pick",
		validate: (payload) => payloadObject(payload),
		handle: async (ctx) => {
			const result = await ctx.bridge.pickDirectory();
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.directory.picked", { path: result.value });
		}
	},
	{
		type: "c2s.session.open",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.session.open",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!isOptionalField(checked.value, "tailCount", (v) => isInteger(v, 1, 1e4))) return reject$1("E_PROTOCOL", "invalid tailCount");
			return checked;
		},
		handle: async (ctx, payload) => {
			const sessionId = payload.sessionId;
			const buffered = ctx.bufferOpenEvents(sessionId);
			if (!await ctx.bridge.openSession(ctx, sessionId, payload.tailCount ?? 100)) {
				ctx.discardOpenBuffer(sessionId, buffered);
				return ctx.fail("E_NOT_FOUND", "session history unavailable");
			}
			if (!ctx.flushOpenBuffer(sessionId, buffered)) return;
		}
	},
	{
		type: "c2s.session.close",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.session.close",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			return requireSessionId(checked.value) ?? checked;
		},
		handle: (ctx, payload) => {
			ctx.closeOpenSession(payload.sessionId);
			ctx.send("s2c.ack", {});
		}
	},
	{
		type: "c2s.session.create",
		stage: "authenticated",
		scopes: MANAGE,
		doc: "PROTOCOL.md c2s.session.create",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			if (!isOptionalField(checked.value, "workspaceId", (v) => isText(v)) || !isOptionalField(checked.value, "cwd", (v) => isText(v, 32768)) || checked.value.workspaceId !== void 0 && checked.value.cwd !== void 0) return reject$1("E_PROTOCOL", "invalid workspace selection");
			return checked;
		},
		handle: async (ctx, payload) => {
			const workspaceId = typeof payload.workspaceId === "string" ? String(payload.workspaceId).trim() : "";
			const cwd = typeof payload.cwd === "string" ? String(payload.cwd).trim() : "";
			if (workspaceId && cwd) return ctx.fail("E_PROTOCOL", "workspaceId and cwd are mutually exclusive");
			const newId = await ctx.bridge.createSession({
				...workspaceId ? { workspaceId } : {},
				...cwd ? { cwd } : {}
			});
			if (!newId) return ctx.fail("E_INTERNAL", "session create failed");
			ctx.send("s2c.ack", { sessionId: newId });
		}
	},
	{
		type: "c2s.session.fork",
		stage: "authenticated",
		scopes: [...MANAGE, ...READ],
		capability: "sessionFork",
		doc: "PROTOCOL.md Session 分支扩展",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!validSendId(checked.value.clientRequestId) || !isOptionalField(checked.value, "atSeq", (v) => isInteger(v, 0, Number.MAX_SAFE_INTEGER))) return reject$1("E_PROTOCOL", "invalid session fork fields");
			return checked;
		},
		handle: async (ctx, payload) => {
			const deviceId = ctx.deviceId;
			const result = await ctx.bridge.forkSession(deviceId, {
				sessionId: payload.sessionId,
				clientRequestId: payload.clientRequestId,
				...payload.atSeq !== void 0 ? { atSeq: payload.atSeq } : {}
			});
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.session.forked", {
				clientRequestId: payload.clientRequestId,
				sourceSessionId: payload.sessionId,
				sessionId: result.value.sessionId,
				...payload.atSeq !== void 0 ? { atSeq: payload.atSeq } : {},
				...result.replayed ? { replayed: true } : {}
			});
		}
	},
	{
		type: "c2s.session.rename",
		stage: "authenticated",
		scopes: MANAGE,
		capability: "sessionManagement",
		doc: "PROTOCOL.md c2s.session.rename",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!isText(checked.value.title, 4096)) return reject$1("E_PROTOCOL", "invalid title");
			return checked;
		},
		handle: async (ctx, payload) => {
			const title = String(payload.title).trim();
			if (title.length === 0) return ctx.fail("E_PROTOCOL", "sessionId and non-empty title required");
			const result = await ctx.bridge.renameSession(payload.sessionId, title);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.session.renamed", {
				sessionId: payload.sessionId,
				title: result.value
			});
		}
	},
	{
		type: "c2s.session.archive",
		stage: "authenticated",
		scopes: MANAGE,
		capability: "sessionManagement",
		doc: "PROTOCOL.md c2s.session.archive",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			return requireSessionId(checked.value) ?? checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.archiveSession(payload.sessionId);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.session.archived", { sessionId: payload.sessionId });
		}
	},
	{
		type: "c2s.session.unarchive",
		stage: "authenticated",
		scopes: MANAGE,
		capability: "sessionRestore",
		doc: "PROTOCOL.md c2s.session.unarchive",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			return requireSessionId(checked.value) ?? checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.unarchiveSession(payload.sessionId);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.session.unarchived", { sessionId: payload.sessionId });
		}
	},
	{
		type: "c2s.session.cancel",
		stage: "authenticated",
		scopes: MANAGE,
		doc: "PROTOCOL.md c2s.session.cancel",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			return requireSessionId(checked.value) ?? checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.cancelSession(payload.sessionId);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.ack", { sessionId: payload.sessionId });
		}
	},
	{
		type: "c2s.session.history",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.session.history",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!isInteger(checked.value.beforeSeq, 0, Number.MAX_SAFE_INTEGER) || !isOptionalField(checked.value, "limit", (v) => isInteger(v, 1, 500))) return reject$1("E_PROTOCOL", "invalid history range");
			return checked;
		},
		handle: async (ctx, payload) => {
			if (typeof payload.beforeSeq !== "number") return ctx.fail("E_PROTOCOL", "sessionId and beforeSeq required");
			const page = await ctx.bridge.historyPage(payload.sessionId, payload.beforeSeq, Math.min(payload.limit ?? 100, 500));
			if (!page) return ctx.fail("E_NOT_FOUND", "history unavailable");
			ctx.send("s2c.history.page", page);
		}
	},
	{
		type: "c2s.session.attachment",
		stage: "authenticated",
		scopes: READ,
		doc: "PROTOCOL.md c2s.session.attachment",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!isText(checked.value.attachmentId)) return reject$1("E_PROTOCOL", "invalid attachmentId");
			return checked;
		},
		handle: async (ctx, payload) => {
			const attachmentId = payload.attachmentId;
			if (attachmentId.length === 0) return ctx.fail("E_PROTOCOL", "sessionId and attachmentId required");
			const image = await ctx.bridge.attachmentData(payload.sessionId, attachmentId);
			if (!image) return ctx.fail("E_NOT_FOUND", "attachment unavailable");
			ctx.send("s2c.ack", image);
		}
	},
	{
		type: "c2s.session.models",
		stage: "authenticated",
		scopes: READ,
		capability: "models",
		doc: "PROTOCOL.md c2s.session.models",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			return requireSessionId(checked.value) ?? checked;
		},
		handle: async (ctx, payload) => {
			const result = await ctx.bridge.sessionModels(payload.sessionId);
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.session.models", {
				sessionId: payload.sessionId,
				...result.value
			});
		}
	},
	{
		type: "c2s.session.selectModel",
		stage: "authenticated",
		scopes: MANAGE,
		capability: "models",
		doc: "PROTOCOL.md c2s.session.selectModel",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!isText(checked.value.provider, 256) || !isText(checked.value.model, 1024) || !isOptionalField(checked.value, "reasoningEffort", (v) => isText(v, 128, false))) return reject$1("E_PROTOCOL", "invalid model selection");
			return checked;
		},
		handle: async (ctx, payload) => {
			if (!String(payload.provider).trim() || !String(payload.model).trim()) return ctx.fail("E_PROTOCOL", "sessionId, provider and model required");
			const result = await ctx.bridge.selectSessionModel(payload.sessionId, {
				provider: String(payload.provider).trim(),
				model: String(payload.model).trim(),
				...String(payload.reasoningEffort ?? "").trim() ? { reasoningEffort: String(payload.reasoningEffort).trim() } : {}
			});
			if (!result.ok) return ctx.fail(result.code, result.message);
			ctx.send("s2c.session.modelSelected", {
				sessionId: payload.sessionId,
				selected: result.value
			});
		}
	},
	{
		type: "c2s.session.delivery",
		stage: "authenticated",
		scopes: ["prompt.send"],
		capability: "promptDelivery",
		doc: "PROTOCOL.md c2s.session.delivery",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			if (!validSendId(checked.value.clientSendId)) return reject$1("E_PROTOCOL", "invalid clientSendId");
			return checked;
		},
		handle: (ctx, payload) => {
			ctx.send("s2c.ack", ctx.bridge.promptDeliveries.lookup(ctx.deviceId, payload.clientSendId, payload.sessionId));
		}
	},
	{
		type: "c2s.session.sendPrompt",
		stage: "authenticated",
		scopes: ["prompt.send"],
		doc: "PROTOCOL.md c2s.session.sendPrompt",
		validate: (payload) => {
			const checked = payloadObject(payload);
			if (!checked.ok) return checked;
			const invalid = requireSessionId(checked.value);
			if (invalid) return invalid;
			const p = checked.value;
			if (p.clientSendId !== void 0 && !validSendId(p.clientSendId)) return reject$1("E_PROTOCOL", "invalid clientSendId");
			if (!isOptionalField(p, "text", (v) => isText(v, 262144, false)) || !isOptionalField(p, "images", Array.isArray) || !isOptionalField(p, "documents", Array.isArray)) return reject$1("E_PROTOCOL", "invalid prompt fields");
			for (const key of ["images", "documents"]) {
				const items = p[key];
				if (items && items.some((v) => v === null || typeof v !== "object" || Array.isArray(v))) return reject$1("E_PROTOCOL", "invalid attachment");
				for (const item of items ?? []) {
					if (item.name !== void 0 && !isText(item.name, 4096, false)) return reject$1("E_PROTOCOL", "invalid attachment name");
					if (item.truncated !== void 0 && typeof item.truncated !== "boolean") return reject$1("E_PROTOCOL", "invalid truncated flag");
				}
			}
			const text = typeof p.text === "string" ? p.text : "";
			const rawImages = Array.isArray(p.images) ? p.images : [];
			const rawDocuments = Array.isArray(p.documents) ? p.documents : [];
			if (text.trim().length === 0 && rawImages.length === 0 && rawDocuments.length === 0) return reject$1("E_PROTOCOL", "sessionId and prompt content required");
			if (rawImages.length > 4) return reject$1("E_PROTOCOL", "too many images");
			if (rawDocuments.length > 4 || rawImages.length + rawDocuments.length > 4) return reject$1("E_PROTOCOL", "too many prompt attachments");
			const images = [];
			for (const image of rawImages) {
				const mediaType = String(image?.mediaType);
				const data = image?.data;
				if (!IMAGE_MEDIA_TYPES.has(mediaType) || typeof data !== "string" || data.length === 0 || data.length > 8388608) return reject$1("E_PROTOCOL", "invalid image attachment");
				images.push({
					mediaType,
					data,
					...typeof image.name === "string" && sanitizeImageName(image.name).length > 0 ? { name: sanitizeImageName(image.name) } : {}
				});
			}
			const documents = [];
			for (const document of rawDocuments) {
				const name = document?.name;
				const mediaType = document?.mediaType;
				const documentText = document?.text;
				if (typeof name !== "string" || typeof mediaType !== "string" || typeof documentText !== "string" || documentText.length === 0 || documentText.length > 262144) return reject$1("E_PROTOCOL", "invalid document attachment");
				const cleanName = sanitizeDocumentField(name, 180);
				const cleanMediaType = sanitizeDocumentField(mediaType, 120).toLowerCase();
				if (!cleanName || !cleanMediaType || cleanMediaType.startsWith("image/")) return reject$1("E_PROTOCOL", "invalid document attachment");
				documents.push({
					name: cleanName,
					mediaType: cleanMediaType,
					text: documentText,
					...document.truncated === true ? { truncated: true } : {}
				});
			}
			return accept({
				sessionId: p.sessionId,
				text,
				images,
				documents,
				...p.clientSendId !== void 0 ? { clientSendId: p.clientSendId } : {}
			});
		},
		handle: async (ctx, payload) => {
			const sessionId = payload.sessionId;
			const text = payload.text;
			const images = payload.images;
			const documents = payload.documents;
			const clientSendId = payload.clientSendId;
			if (clientSendId !== void 0) {
				const receipt = await ctx.bridge.promptDeliveries.dispatch(ctx.deviceId, clientSendId, {
					sessionId,
					content: {
						text,
						images,
						documents
					}
				}, () => ctx.bridge.sendPrompt(sessionId, text, images, documents));
				ctx.send("s2c.ack", receipt);
				return;
			}
			const userSeq = await ctx.bridge.sendPrompt(sessionId, text, images, documents);
			if (!userSeq.ok) return ctx.fail(userSeq.code, userSeq.message);
			ctx.send("s2c.ack", { userSeq: userSeq.value });
		}
	}
];
/** 第一个缺失的 scope；消息与迁移前一致（`scope <name> required`）。 */
function scopeRejection(row, scopes) {
	for (const scope of row.scopes) if (!scopes.has(scope)) return {
		code: "E_FORBIDDEN",
		message: `scope ${scope} required`
	};
}
/** 能力位关闭时拒绝。校验先于本检查，与迁移前的次序一致。 */
function capabilityRejection(row, capabilities) {
	if (row.capability === void 0) return void 0;
	if (capabilities[row.capability] === true) return void 0;
	return {
		code: "E_UNSUPPORTED",
		message: "capability unavailable on this host version"
	};
}
function widgetPolicyOf(row) {
	return row.widgetPolicy ?? "deny";
}
/** 校验一帧载荷；未登记 validate 的行原样通过。 */
function validatePayload(row, payload) {
	if (row.validate === void 0) return {
		ok: true,
		value: payload ?? {}
	};
	return row.validate(payload);
}
/** 执行一帧。检查（阶段/scope/能力/校验）由 connection 按序先行完成。 */
async function dispatchFrame(row, ctx, payload) {
	await row.handle(ctx, payload);
}
/**
* 载荷必须是普通对象。此前这条判定住在 request-validation 里，对
* `c2s.sessions.list` 等无参帧豁免、对 `c2s.sessions.archived` 却不通融
* （同语义两种待遇，见 G2）；现在豁免由各行的 validate 自己声明。
*/
function payloadObject(value) {
	if (value === void 0 || value === null) return {
		ok: true,
		value: {}
	};
	if (typeof value !== "object" || Array.isArray(value)) return {
		ok: false,
		code: "E_PROTOCOL",
		message: "payload must be an object"
	};
	return {
		ok: true,
		value
	};
}
/** 字符串字段：类型正确、不超长、非空（可放宽）。 */
function isText(value, max = 4096, nonempty = true) {
	return typeof value === "string" && value.length <= max && (!nonempty || value.trim().length > 0);
}
/** 可选字段：缺省合法，给出时必须满足 check。 */
function isOptionalField(payload, key, check) {
	return payload[key] === void 0 || check(payload[key]);
}
function isInteger(value, min, max) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
function reject$1(code, message) {
	return {
		ok: false,
		code,
		message
	};
}
function accept(value) {
	return {
		ok: true,
		value
	};
}
/** 全部入站行。装配是静态的：新增特性 module 必须在这里显式出现。 */
const WIRE_FRAME_ROWS = [
	...sessionRows,
	...scheduleRows,
	...interactionRows,
	...pushRows,
	...deviceRows
];
const ROWS_BY_TYPE = new Map(WIRE_FRAME_ROWS.map((row) => [row.type, row]));
function registryRowFor(type) {
	return ROWS_BY_TYPE.get(type);
}
//#endregion
//#region src/connection-gate.ts
/**
* 连接门（ConnectionGate）——「一个匿名 socket 被允许做什么」的唯一属主。
*
* 迁移前，这些规则散在五个地方：connection.ts 的 onMessage（长度上限、信封
* 卫生、pre-auth 白名单、scope/widget 门）、connection.ts 的 prove()（认证）、
* index.ts 的 handleUpgrade（连接数、名额、失败记账、6 个手工 release 点）、
* auth-rate-limit.ts（策略）、token.ts（注册表语义）。理解一次 4401 关闭要跨
* 400 行来回跳。
*
* 现在：门拥有 ①认证状态机的全部迁移 ②认证名额的获取与释放（单一释放点）
* ③「此刻这一帧是否被允许进入」的判定。连接只剩传输、welcome 发射、sink 台账
* 与连接自有缓冲；注册表行仍住在 wire-registry 及其特性 module 里，门只负责
* 在正确的时机调用它们。
*
* 名额的生命周期分两段，各有保证：
* - 接入段：门在 handleUpgrade 里构造（admit 发生于此）。若 upgrade 回调根本
*   不执行（upgrade 期间 socket 被销毁），5 秒兜底会释放名额并判门死刑；
* - 认证段：attach 之后由 35 秒 hello 计时器兜底，任何一条落定路径
*   （成功/证明无效/超时/关闭）都经 settleAuthentication 的 exactly-once
*   守卫释放一次。
*/
/** upgrade 正常是毫秒级；5 秒已极宽，只为「回调根本不执行」兜底。 */
const DEFAULT_ATTACH_TIMEOUT_MS = 5e3;
var ConnectionGate = class {
	options;
	authenticated = false;
	settled = false;
	revoked = false;
	deviceId;
	scopes = /* @__PURE__ */ new Set();
	widgetClient = false;
	challenge;
	helloTimer;
	attachTimer;
	attached = false;
	host;
	admission;
	dead = false;
	constructor(options) {
		this.options = options;
		this.challenge = createAuthChallenge(options.audience);
		const admission = options.limiter.admit(options.source);
		this.admission = admission.ok ? admission : void 0;
		if (!admission.ok) {
			this.dead = true;
			return;
		}
		this.attachTimer = setTimeout(() => {
			this.attachTimer = void 0;
			if (!this.attached && !this.settled) {
				this.dead = true;
				this.releaseAdmission();
			}
		}, options.attachTimeoutMs ?? DEFAULT_ATTACH_TIMEOUT_MS);
		this.attachTimer.unref();
	}
	/** 名额是否拿到；false 时 handleUpgrade 应直接拒掉这个源。 */
	get admitted() {
		return !this.dead;
	}
	/** 客户端身份：限流与审计日志共用同一个值。 */
	get source() {
		return this.options.source;
	}
	/**
	* ws 就绪：接线宿主、下发挑战并启动 hello 计时器。只应被调用一次——
	* 由连接在构造时调用（那一刻 ws 才真正存在）。
	*/
	attach(host) {
		if (this.dead || this.attached) return;
		this.attached = true;
		this.host = host;
		if (this.attachTimer !== void 0) {
			clearTimeout(this.attachTimer);
			this.attachTimer = void 0;
		}
		host.send("s2c.auth.challenge", this.challenge);
		this.helloTimer = setTimeout(() => {
			this.helloTimer = void 0;
			if (this.authenticated) return;
			this.settle(false, "timeout");
			this.host?.close(4402, "auth timeout");
		}, AUTH_TIMEOUT_MS);
		this.helloTimer.unref();
	}
	/**
	* 接入窗口结束：若始终没有 socket 接上（upgrade 回调没执行），立刻归还名额，
	* 不必等 5 秒兜底。已 attach 的门不在此释放——它的名额由落定路径或 hello
	* 计时器负责。
	*/
	releaseIfNeverAttached() {
		if (!this.attached && !this.settled) {
			this.dead = true;
			this.releaseAdmission();
		}
	}
	/** 拒绝一个已创建但最终不会接线的门（bridge 变更、构造失败）。 */
	markDead() {
		this.dead = true;
		this.releaseAdmission();
	}
	/** socket 关闭：未落定则按 closed 收尾（并释放名额）。 */
	onClose() {
		if (!this.settled) this.settle(false, "closed");
		if (this.helloTimer !== void 0) clearTimeout(this.helloTimer);
		if (this.attachTimer !== void 0) clearTimeout(this.attachTimer);
	}
	/**
	* 处理一条原始帧。内部完成全部 pre-auth 规则（长度上限、信封卫生、版本、
	* pre-auth 白名单、撤销吞帧），再进入认证、授权与分发。
	*/
	async handleFrame(raw) {
		const host = this.host;
		if (this.dead || host === void 0) return;
		if (this.revoked) return;
		if (!this.authenticated && raw.length > 65536) {
			host.close(1009, "pre-auth frame too large");
			return;
		}
		let env;
		try {
			const parsed = JSON.parse(raw);
			if (!isEnvelope(parsed)) {
				host.fail(void 0, "E_PROTOCOL", "malformed frame");
				return;
			}
			env = parsed;
		} catch {
			host.fail(void 0, "E_PROTOCOL", "frame is not valid JSON");
			return;
		}
		if (env.v !== 2) {
			host.fail(env.id, "E_UNSUPPORTED", "unsupported protocol version");
			host.close(4500, "protocol version mismatch");
			return;
		}
		if (!this.authenticated) {
			const control = registryRowFor(env.type);
			if (control === void 0 || control.stage !== "pre-auth") {
				host.fail(env.id, "E_PROTOCOL", "authenticate first");
				return;
			}
			await dispatchFrame(control, this.context(env), {});
			return;
		}
		const row = registryRowFor(env.type);
		if (this.widgetClient && (row === void 0 || widgetPolicyOf(row) === "deny")) return host.fail(env.id, "E_FORBIDDEN", "widget connection is read-only");
		if (row === void 0) {
			host.fail(env.id, "E_PROTOCOL", "unknown type: " + env.type);
			return;
		}
		const scope = scopeRejection(row, this.scopes);
		if (scope !== void 0) return host.fail(env.id, scope.code, scope.message);
		const validated = validatePayload(row, env.payload);
		if (!validated.ok) return host.fail(env.id, validated.code, validated.message);
		const capability = capabilityRejection(row, host.bridge.capabilities);
		if (capability !== void 0) return host.fail(env.id, capability.code, capability.message);
		await dispatchFrame(row, this.context(env), validated.value);
	}
	/** 门持有的撤销标记由 device.revoke 行置位。 */
	markRevoked() {
		this.revoked = true;
	}
	/** c2s.auth.prove 的行 handler 调用这里：验签、载入 scope、记账、落定。 */
	async authenticate(env) {
		const host = this.host;
		if (this.revoked || host === void 0) return;
		const p = env.payload ?? {};
		if (!p.deviceId) {
			host.fail(env.id, "E_PROTOCOL", "deviceId required");
			host.close(4403, "deviceId required");
			return;
		}
		const deviceId = sanitizeDeviceField(p.deviceId, 128);
		if (!deviceId) {
			host.fail(env.id, "E_PROTOCOL", "deviceId required");
			host.close(4403, "deviceId required");
			return;
		}
		const deviceName = sanitizeDeviceField(p.deviceName, 64) || "unknown";
		const appVersion = sanitizeDeviceField(p.appVersion, 32) || "unknown";
		const record = this.options.devices.authorized(deviceId);
		const resumeCursor = typeof p.resumeCursor === "number" && Number.isInteger(p.resumeCursor) && p.resumeCursor >= 0 ? p.resumeCursor : void 0;
		const challengeMatches = p.nonce === this.challenge.nonce && p.audience === this.challenge.audience && p.issuedAt === this.challenge.issuedAt && p.expiresAt === this.challenge.expiresAt && Date.now() <= this.challenge.expiresAt;
		if (!(record?.publicKey !== void 0 && typeof p.signature === "string" && challengeMatches && verifyAuthProof(record.publicKey, {
			deviceId,
			deviceName,
			appVersion,
			resumeCursor,
			...this.challenge
		}, p.signature)) || record === void 0) {
			host.fail(env.id, "E_AUTH", "device proof missing or invalid");
			this.settle(false, "invalid-proof");
			host.close(4401, "invalid device proof");
			return;
		}
		this.settle(true, "success");
		this.authenticated = true;
		this.deviceId = deviceId;
		this.widgetClient = p.clientRole === "widget";
		this.scopes = new Set(record.scopes ?? []);
		if (this.helloTimer !== void 0) clearTimeout(this.helloTimer);
		if (!this.widgetClient) this.options.devices.markAuthenticated(deviceId, deviceName, appVersion, Date.now());
		host.deviceAuthenticated(deviceId);
		host.onAuthenticated({
			deviceId,
			scopes: this.scopes,
			widgetClient: this.widgetClient,
			resumeCursor: this.widgetClient ? void 0 : resumeCursor,
			deviceName,
			appVersion
		});
	}
	/** 限流记账与名额释放只此一处；exactly-once 由 settled 守卫保证。 */
	settle(ok, reason) {
		if (this.settled) return;
		this.settled = true;
		this.releaseAdmission();
		this.host?.settled(ok, reason);
		if (ok) {
			this.options.limiter.recordSuccess(this.options.source);
			return;
		}
		if (this.options.limiter.recordFailure(this.options.source).newlyBlocked) {
			const label = this.options.auditLabel?.(this.options.source) ?? this.options.source;
			this.options.log(`authentication source blocked source=${label}`);
		}
	}
	releaseAdmission() {
		this.admission?.release();
		this.admission = void 0;
	}
	/** 把宿主投影成行看到的每帧上下文：id 绑进 send/fail，身份来自门。 */
	context(env) {
		const host = this.host;
		return {
			frame: env,
			deviceId: this.deviceId,
			widgetClient: this.widgetClient,
			bridge: host.bridge,
			devices: host.devices,
			debug: host.debug,
			log: (message) => host.log(message),
			send: (type, payload) => host.send(type, payload, env.id),
			fail: (code, message) => host.fail(env.id, code, message),
			close: (code, reason) => host.close(code, reason),
			canReceive: (scope) => host.canReceive(scope),
			push: (type, payload, seq) => host.push(type, payload, seq),
			lastCursor: () => host.lastCursor(),
			replay: (entries) => host.replay(entries),
			replayDone: () => host.replayDone(),
			resync: () => host.resync(),
			bufferOpenEvents: (sessionId) => host.bufferOpenEvents(sessionId),
			discardOpenBuffer: (sessionId, buffer) => host.discardOpenBuffer(sessionId, buffer),
			flushOpenBuffer: (sessionId, buffer) => host.flushOpenBuffer(sessionId, buffer),
			closeOpenSession: (sessionId) => host.closeOpenSession(sessionId),
			nextLiveActivityGeneration: () => host.nextLiveActivityGeneration(),
			get liveActivityGeneration() {
				return host.liveActivityGeneration;
			},
			get pendingLiveActivityId() {
				return host.pendingLiveActivityId;
			},
			setPendingLiveActivityId: (activityId) => host.setPendingLiveActivityId(activityId),
			markRevoked: () => this.markRevoked(),
			prove: () => this.authenticate(env),
			enrollPushKey: (enrollKey) => host.enrollPushKey(enrollKey),
			revokeSiblings: (deviceId) => host.revokeSiblings(deviceId)
		};
	}
};
//#endregion
//#region src/connection.ts
/**
* One connected phone. Implements BridgeSink so the HostBridge can push
* projected frames and replays.
*
* 本模块现在只剩传输与连接自有状态：socket、send/fail/close、背压、idle 计时、
* welcome 发射、sink 台账、打开中的会话缓冲、Live Activity 代次。帧的规则
* （pre-auth、认证、授权、分发）全部属于 ConnectionGate；帧的事实属于
* wire-registry。连接通过实现 GateHost 把这两者接起来。
*/
var BridgeConnection = class {
	ws;
	deps;
	closed = false;
	/**
	* Realtime events that arrive while a session's history snapshot is in
	* flight. The wire contract requires tail first; sending these immediately
	* lets the later tail roll the client back over messages it just rendered.
	*/
	openingSessionEvents = /* @__PURE__ */ new Map();
	openSessions = /* @__PURE__ */ new Set();
	liveActivityRegistrationGeneration = 0;
	pendingLiveActivityId;
	lastActivity = Date.now();
	/** True when no inbound frame arrived within maxIdleMs. */
	isStale(now, maxIdleMs) {
		return now - this.lastActivity > maxIdleMs;
	}
	/** 认证成功后由门回填，供 welcome 与 sink 注册使用。 */
	identity;
	/** 帧规则（pre-auth、认证、授权、分发）的属主；由接入方创建并交进来。 */
	gate;
	constructor(ws, deps, gate = new ConnectionGate({
		source: deps.source ?? "local",
		devices: deps.devices,
		audience: deps.audience,
		limiter: deps.rateLimiter ?? new AuthRateLimiter(),
		log: (message) => deps.log(message),
		...deps.auditLabel ? { auditLabel: deps.auditLabel } : {}
	})) {
		this.ws = ws;
		this.deps = deps;
		const connection = this;
		const host = {
			get bridge() {
				return connection.deps.bridge;
			},
			get devices() {
				return connection.deps.devices;
			},
			get debug() {
				return deps.debug === true;
			},
			log: (message) => deps.log(message),
			send: (type, payload, id) => connection.send(type, payload, id),
			fail: (id, code, message) => connection.fail(id, code, message),
			close: (code, reason) => connection.close(code, reason),
			canReceive: (scope) => connection.canReceive(scope),
			push: (type, payload, seq) => connection.push(type, payload, seq),
			lastCursor: () => connection.lastCursor(),
			replay: (entries) => connection.replay(entries),
			replayDone: () => connection.replayDone(),
			resync: () => connection.resync(),
			bufferOpenEvents: (sessionId) => connection.bufferOpenEvents(sessionId),
			discardOpenBuffer: (sessionId, buffer) => connection.discardOpenBuffer(sessionId, buffer),
			flushOpenBuffer: (sessionId, buffer) => connection.flushOpenBuffer(sessionId, buffer),
			closeOpenSession: (sessionId) => connection.closeOpenSession(sessionId),
			nextLiveActivityGeneration: () => {
				connection.liveActivityRegistrationGeneration += 1;
				return connection.liveActivityRegistrationGeneration;
			},
			get liveActivityGeneration() {
				return connection.liveActivityRegistrationGeneration;
			},
			get pendingLiveActivityId() {
				return connection.pendingLiveActivityId;
			},
			setPendingLiveActivityId: (activityId) => {
				connection.pendingLiveActivityId = activityId;
			},
			markRevoked: () => connection.gate.markRevoked(),
			enrollPushKey: (enrollKey) => deps.onPushEnrollKey?.(enrollKey),
			revokeSiblings: (deviceId) => deps.onDeviceRevoke?.(deviceId, connection),
			onAuthenticated: (identity) => connection.onAuthenticated(identity),
			deviceAuthenticated: (deviceId) => deps.onDeviceAuthenticated?.(deviceId),
			settled: (ok, reason) => deps.onAuthenticationSettled?.(ok, reason)
		};
		this.gate = gate;
		ws.on("message", (data) => {
			this.lastActivity = Date.now();
			gate.handleFrame(String(data)).catch((error) => {
				if (this.deps.debug === true) this.deps.log("frame handler failed: " + String(error));
				if (this.closed) return;
				this.terminate();
			});
		});
		ws.on("close", () => {
			this.onClose();
			deps.onClosed?.(this);
		});
		ws.on("error", () => {});
		gate.attach(host);
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
		return this.identity?.deviceId;
	}
	get suppressesAlertPush() {
		return this.identity?.widgetClient !== true;
	}
	/** S→C permission gate consulted by the bridge for every broadcast/replay
	*  frame: a device only receives what its scopes grant (R1/P2). */
	canReceive(scope) {
		return this.identity?.scopes.has(scope) ?? false;
	}
	push(type, payload, seq) {
		if (type === "s2c.notify") payload = {
			...payload,
			hostAudience: this.deps.audience
		};
		if (type === "s2c.session.event") {
			const sessionId = payload?.sessionId;
			if (typeof sessionId === "string") {
				const buffered = this.openingSessionEvents.get(sessionId);
				if (buffered) {
					buffered.push({
						type,
						payload,
						...seq !== void 0 ? { seq } : {}
					});
					return;
				}
			}
		}
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
	/** 认证成功：门只做安全判定，欢迎与重放归连接（数据面）。 */
	onAuthenticated(identity) {
		this.identity = identity;
		const cursor = identity.resumeCursor;
		const canResume = cursor !== void 0 && this.deps.bridge.canResumeFrom(cursor);
		this.send("s2c.welcome", {
			protocolVersion: 2,
			serverVersion: this.deps.serverVersion,
			deviceId: identity.deviceId,
			scopes: [...identity.scopes],
			capabilities: this.deps.bridge.capabilities,
			cursor: this.deps.bridge.currentCursor(),
			resumed: canResume
		});
		if (!identity.widgetClient) this.deps.bridge.addSink(this);
		if (cursor !== void 0) {
			if (canResume) this.deps.bridge.resumeFrom(cursor, this);
			else this.resync();
		}
	}
	onClose() {
		if (this.closed) return;
		this.closed = true;
		this.gate.onClose();
		for (const id of this.openSessions) this.deps.bridge.markSinkClosed(this, id);
		this.openSessions.clear();
		this.openingSessionEvents.clear();
		this.deps.bridge.dropSinkSessions(this);
		if (this.identity !== void 0) this.deps.bridge.removeSink(this);
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
			v: 2,
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
	bufferOpenEvents(sessionId) {
		const frames = [];
		const buffer = { frames };
		this.openingSessionEvents.set(sessionId, frames);
		return buffer;
	}
	discardOpenBuffer(sessionId, buffer) {
		if (this.openingSessionEvents.get(sessionId) === buffer.frames) this.openingSessionEvents.delete(sessionId);
	}
	flushOpenBuffer(sessionId, buffer) {
		if (this.openingSessionEvents.get(sessionId) !== buffer.frames) return false;
		this.openSessions.add(sessionId);
		this.deps.bridge.markSinkOpen(this, sessionId);
		this.openingSessionEvents.delete(sessionId);
		for (const frame of buffer.frames) this.push(frame.type, frame.payload, frame.seq);
		return true;
	}
	closeOpenSession(sessionId) {
		this.openingSessionEvents.delete(sessionId);
		this.openSessions.delete(sessionId);
		this.deps.bridge.markSinkClosed(this, sessionId);
	}
};
function normalizeFunnelConnectionLimit(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 16 ? value : 8;
}
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
function tunnelHelperArguments(originURL, statePath, options) {
	return [
		"--origin",
		originURL,
		"--hostname",
		normalizeRemoteHostname(options.hostname),
		"--state-dir",
		statePath,
		"--port",
		String(options.funnelPort ?? 443),
		"--max-connections-per-source",
		String(normalizeFunnelConnectionLimit(options.maxConnectionsPerSource))
	];
}
/**
* Summarize a fatal helper crash from its stderr tail. Go panics dump the
* actual reason on the `panic:` line while the trailing stack frames are
* `file.go:NN +0xOFF` noise — the old behavior of reporting only the final
* line surfaced exactly that noise (e.g. `.../singleflight.go:194 +0x45c`)
* and hid the real panic message. Keep the crash header line (a raw
* `panic:`, a runtime `fatal error:`, or net/http's `http: panic serving`),
* plus an optional `[signal ...]` continuation and the first non-runtime
* stack frame's symbol + `file.go:NN` as a location hint. Pointer offsets
* are not architecture stable, so they are deliberately dropped.
*
* The frame symbol sits on the line just above the indented source line in a
* Go dump, e.g.:
*   tailscale.com/net/dnscache.(*Resolver).lookupIP(0x1400012c000, {...})
*       tailscale.com@v1.102.3/net/dnscache/dnscache.go:604 +0x25c
* The first symbol (shortened) is used because a bare `file.go:NN` is not
* unique across tailscale (singleflight.go is one example).
*/
function helperCrashSummary(stderr) {
	const lines = stderr.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		const logTimestamp = /^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} )/.exec(line)?.[1] ?? "";
		if (!/^(panic:|fatal error:|http: panic serving)/.test(logTimestamp.length > 0 ? line.slice(logTimestamp.length) : line)) continue;
		let summary = logTimestamp.length > 0 ? line.slice(logTimestamp.length) : line;
		const next = lines[i + 1]?.trim();
		if (next?.startsWith("[signal")) summary += " " + next;
		let lastSymbol;
		for (let j = i + 1; j < lines.length; j++) {
			const frame = lines[j];
			const trimmed = frame.trim();
			if (trimmed === "") continue;
			const sourceMatch = /^\s+(\S+\.go:\d+)/.exec(frame);
			if (sourceMatch !== null) {
				const source = sourceMatch[1];
				if (source.startsWith("runtime/") || source.startsWith("runtime\\")) {
					lastSymbol = void 0;
					continue;
				}
				const slash = Math.max(source.lastIndexOf("/"), source.lastIndexOf("\\"));
				const file = slash >= 0 ? source.slice(slash + 1) : source;
				const symbol = lastSymbol !== void 0 ? shortenSymbol(lastSymbol) : void 0;
				summary += " @ " + (symbol !== void 0 ? `${symbol} (${file})` : file);
				break;
			}
			if (trimmed.includes("(") || trimmed.endsWith(")")) lastSymbol = trimmed;
		}
		return summary.replace(/\s+/g, " ").trim();
	}
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line !== "") return line;
	}
	return "";
}
/** Shrink a Go frame symbol to `pkg.Receiver.method` form (drop module-root
*  path, generic type arguments and the trailing call arguments), so the
*  summary hint stays readable. Keeps a `.funcN` closure suffix when present
*  (e.g. `doCall.func2`), since it identifies the exact closure.
*
*  A symbol looks like:
*    tailscale.com/util/singleflight.(*Group[...]).doCall.func2(0x…, …)
*  The trailing call arguments form a balanced paren group that starts at
*  the function name — that group is stripped first; generics appear only
*  inside `(*Group[...])` receiver brackets before the final method dot, so
*  they are removed by trimming from the first `[` to the matching `]`.
*/
function shortenSymbol(symbol) {
	const trimmed = symbol.trim();
	let end = trimmed.length;
	if (trimmed.endsWith(")")) {
		let depth = 0;
		for (let i = trimmed.length - 1; i >= 0; i--) {
			const ch = trimmed[i];
			if (ch === ")") depth++;
			else if (ch === "(") {
				depth--;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
	}
	let name = trimmed.slice(0, end).trim();
	const bracketOpen = name.indexOf("[");
	if (bracketOpen >= 0) {
		const bracketClose = name.indexOf("]", bracketOpen);
		if (bracketClose > bracketOpen) name = name.slice(0, bracketOpen) + name.slice(bracketClose + 1);
	}
	const slash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
	return slash >= 0 ? name.slice(slash + 1) : name;
}
/** Shared by crash summary and dump: whether the stderr looks like a Go
*  panic/fatal-error crash (vs. an ordinary exit). */
function looksLikeCrash(stderr) {
	return /(?:^|\n)\s*(?:\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} )?(?:panic:|fatal error:|http: panic serving)/.test(stderr);
}
/** Turn a crash stderr tail into a status message and optionally persist the
*  full dump under the state dir. Keeps at most MAX_CRASH_DUMPS dump files. */
async function analyzeCrashExit(stderr, statePath) {
	const summary = helperCrashSummary(stderr) || "helper exited";
	if (!looksLikeCrash(stderr) || stderr.trim() === "") return { summary };
	const target = statePath.trim();
	if (target === "") return { summary };
	try {
		const file = join(target, `crash-${Date.now()}.log`);
		await writeFile(file, stderr, { mode: 384 });
		await trimCrashDumps(target);
		return {
			summary,
			dumpPath: file
		};
	} catch {
		return { summary };
	}
}
/** Remove oldest crash-*.log files beyond MAX_CRASH_DUMPS. */
async function trimCrashDumps(dir) {
	let names;
	try {
		names = (await readdir(dir)).filter((name) => name.startsWith("crash-") && name.endsWith(".log"));
	} catch {
		return;
	}
	if (names.length <= 6) return;
	names.sort();
	const excess = names.length - 6;
	await Promise.all(names.slice(0, excess).map((name) => rm(join(dir, name), { force: true }).catch(() => {})));
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
		const child = spawn(helper, tunnelHelperArguments(originURL, statePath, this.options), {
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
			stderrBuffer = (stderrBuffer + chunk).slice(-16e3);
		});
		child.once("error", (error) => {
			this.setStatus({
				phase: "error",
				message: `helper launch failed: ${String(error)}`
			});
		});
		child.once("exit", () => {
			if (this.child === child) this.child = void 0;
			if (this.stopping) {
				this.setStatus({
					phase: "stopped",
					message: void 0
				});
				return;
			}
			analyzeCrashExit(stderrBuffer, this.options.statePath).then((analysis) => {
				if (this.stopping) return;
				const message = analysis.summary + (analysis.dumpPath !== void 0 ? ` (full dump: ${analysis.dumpPath})` : "");
				this.setStatus({
					phase: "error",
					message
				});
				this.scheduleRestart(originURL, "crash");
			});
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
//#region src/local-policy.ts
const DEFAULT_LOCAL_PORT = 3098;
const MIN_LOCAL_PORT = 1024;
const MAX_LOCAL_PORT = 65535;
function normalizeLocalPort(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_LOCAL_PORT;
}
/** The LAN listener is TLS-only, so every advertised endpoint is `https://`. */
function localEndpointURLs(addresses, port) {
	const normalizedPort = normalizeLocalPort(port);
	return [...new Set(addresses)].map((address) => `https://${address}:${normalizedPort}`);
}
function localListenError(error, port) {
	const code = error?.code;
	if (code === "EADDRINUSE") return `local port ${port} is already in use`;
	if (code === "EACCES") return `permission denied while opening local port ${port}`;
	return error instanceof Error ? error.message : String(error);
}
//#endregion
//#region src/config.ts
/** Operator-run relay used by distributed builds; overridable via config. */
const DEFAULT_RELAY_URL = "https://pilot.hailab.dev";
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	devicesPath: z.string().default(join(bridgeDataDir(), "devices-v2.json")),
	historyBufferMax: z.natural().min(100).default(2e3),
	diagnostics: z.object({ debug: z.boolean().default(false).description("打印握手、推送等诊断日志；不会打印配对令牌、APNs token 或消息内容") }).default({ debug: false }).volatile(),
	local: z.object({
		enabled: z.boolean().default(true),
		port: z.natural().min(MIN_LOCAL_PORT).max(MAX_LOCAL_PORT).default(DEFAULT_LOCAL_PORT).description("DeepPilot 局域网独立端口（仅 TLS；默认 3098，修改后本地连接会短暂重连）")
	}).default({
		enabled: true,
		port: DEFAULT_LOCAL_PORT
	}).volatile(),
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
		]).default(443),
		maxConnectionsPerSource: z.natural().min(1).max(16).default(8).description("Funnel 每个来源允许的并发连接数（1–16，修改后远程连接会短暂重连）")
	}).default({
		enabled: false,
		provider: "tailscale-funnel",
		hostname: DEFAULT_REMOTE_HOSTNAME,
		statePath: join(bridgeDataDir(), "tailscale"),
		helperPath: "",
		funnelPort: 443,
		maxConnectionsPerSource: 8
	}).volatile(),
	push: z.object({
		provider: z.union([
			"none",
			"apns",
			"relay"
		]).default("none"),
		contentMode: z.union(["preview", "generic"]).default("preview"),
		teamId: z.string().default(""),
		keyId: z.string().default(""),
		keyPath: z.string().default(join(bridgeDataDir(), "apns", "AuthKey.p8")),
		bundleId: z.string().default("dev.hailab.deeppilot"),
		relayUrl: z.string().default(DEFAULT_RELAY_URL),
		relayToken: z.string().default("")
	}).default({
		provider: "none",
		contentMode: "preview",
		teamId: "",
		keyId: "",
		keyPath: join(bridgeDataDir(), "apns", "AuthKey.p8"),
		bundleId: "dev.hailab.deeppilot",
		relayUrl: DEFAULT_RELAY_URL,
		relayToken: ""
	})
});
/**
* Deep-unwrap live-update (volatile) references to plain values.
*
* On a 0.1.7 host, `apply()`'s options — and even a direct `Config(raw)` call
* — carry `{ get() }` reference objects for volatile fields. Every consumer of
* `currentConfig()` compares plain values (`=== true`, numeric bounds, object
* fields), and schemastery refuses to re-parse a reference, so normalization
* unwraps on the way in and on the way out. A JSON-shaped config value cannot
* carry a function, so the `get` check cannot false-positive.
*/
function plainConfig(value) {
	if (value === null || typeof value !== "object") return value;
	if (typeof value.get === "function") return plainConfig(value.get());
	if (Array.isArray(value)) return value.map(plainConfig);
	const plain = {};
	for (const [key, item] of Object.entries(value)) plain[key] = plainConfig(item);
	return plain;
}
/**
* Cordis hands the second argument in different shapes depending on host
* composition: a reactive options getter, the resolved config value, or
* nothing when the patch row omits `config`. Normalize all of them — and
* unwrap volatile references so the returned Config is plain data.
*/
function normalizeOptions(options) {
	if (typeof options === "function") return plainConfig(options());
	if (options && typeof options === "object") return plainConfig(options);
	return plainConfig(Config(void 0) ?? {});
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
	if ("kind" in notification && notification.kind === "liveactivity") return { aps: {
		timestamp: notification.timestamp,
		event: notification.event,
		"content-state": notification.contentState,
		...notification.event === "end" ? { "dismissal-date": notification.timestamp + 300 } : { "stale-date": notification.timestamp + 180 }
	} };
	if ("kind" in notification && notification.kind === "widget") return { aps: { "content-changed": true } };
	return alertPayload(notification);
}
function alertPayload(notification) {
	const timeSensitive = notification.category === "approval.required" || notification.category === "question.asked";
	return {
		aps: {
			alert: {
				title: notification.title.slice(0, 120),
				body: notification.body.slice(0, 200)
			},
			sound: "default",
			category: notification.category,
			"thread-id": notification.hostAudience ? createHash("sha256").update(`${notification.hostAudience}:${notification.sessionId}`).digest("hex") : notification.sessionId.slice(0, 64),
			...timeSensitive ? { "interruption-level": "time-sensitive" } : {}
		},
		...notification.hostAudience ? { hostAudience: notification.hostAudience } : {},
		sessionId: notification.sessionId,
		notificationId: notification.notificationId,
		kind: notification.category
	};
}
function pushHeaders(bundleId, notification) {
	if ("kind" in notification && notification.kind === "liveactivity") return {
		"apns-topic": bundleId + ".push-type.liveactivity",
		"apns-push-type": "liveactivity",
		"apns-priority": notification.event === "end" ? "10" : "5",
		"apns-expiration": String(notification.timestamp + 180)
	};
	if ("kind" in notification && notification.kind === "widget") return {
		"apns-topic": bundleId + ".push-type.widgets",
		"apns-push-type": "widgets",
		"apns-priority": "5",
		"apns-collapse-id": "widget-overview"
	};
	return {
		"apns-topic": bundleId,
		"apns-push-type": "alert",
		"apns-priority": "10",
		"apns-collapse-id": collapseIdFor(notification)
	};
}
/** collapse-id accepts ≤64 bytes of ASCII; keep it stable per session+event. */
function collapseIdFor(notification) {
	const raw = `${notification.hostAudience ? notification.hostAudience + ":" : ""}${notification.category}:${notification.sessionId}`;
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
					...pushHeaders(this.opts.bundleId, notification),
					"apns-expiration": String(Math.floor(Date.now() / 1e3) + 3600),
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
//#region src/relay-url.ts
/**
* Normalize an operator-configured relay URL without a backtracking regular
* expression. Scanning from the end keeps even pathological inputs linear.
*/
function normalizeRelayBaseUrl(value) {
	const trimmed = value.trim();
	let end = trimmed.length;
	while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end -= 1;
	return end === trimmed.length ? trimmed : trimmed.slice(0, end);
}
//#endregion
//#region src/relay-client.ts
var RelayClient = class {
	base;
	token;
	timeoutMs;
	debug;
	log;
	constructor(opts) {
		this.base = normalizeRelayBaseUrl(opts.url);
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
//#region src/widget-push.ts
/** Coalesce bursts and bound continuous updates, without starving the trailing
* state. One scheduler per host, not per token or per streaming text frame. */
var WidgetPushScheduler = class {
	send;
	intervalMs;
	timer;
	lastSent = 0;
	disposed = false;
	sending = false;
	dirty = false;
	constructor(send, intervalMs = 3e4) {
		this.send = send;
		this.intervalMs = intervalMs;
	}
	changed() {
		if (this.disposed) return;
		this.dirty = true;
		if (this.timer || this.sending) return;
		this.timer = setTimeout(() => {
			this.timer = void 0;
			this.dirty = false;
			this.sending = true;
			this.lastSent = Date.now();
			this.send().catch(() => {}).finally(() => {
				this.sending = false;
				if (this.dirty) this.changed();
			});
		}, Math.max(Math.min(1e3, this.intervalMs), this.intervalMs - (Date.now() - this.lastSent)));
		this.timer.unref();
	}
	dispose() {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = void 0;
	}
};
//#endregion
//#region src/live-activity.ts
function liveActivityState(session) {
	const total = Math.max(0, session?.todos?.total ?? session?.todoItems?.length ?? 0);
	const done = Math.min(total, Math.max(0, session?.todos?.done ?? 0));
	const task = session?.todoItems?.find((item) => item.status === "in_progress") ?? session?.todoItems?.find((item) => item.status === "pending");
	return {
		title: Array.from(session?.title ?? "").slice(0, 100).join(""),
		task: Array.from(session?.activity?.trim() || task?.content || "").slice(0, 160).join(""),
		done,
		total,
		phase: !session || total === 0 ? "unavailable" : session.pendingApproval ? "approval" : session.pendingQuestion ? "question" : session.status === "running" ? "running" : session.status === "idle" ? "ended" : "unavailable"
	};
}
/** Persist terminal state before coalescing so a rapid next round cannot revive an activity. */
var LiveActivityPushManager = class {
	devices;
	send;
	latest = /* @__PURE__ */ new Map();
	sent = /* @__PURE__ */ new Map();
	scheduler;
	constructor(devices, send, intervalMs = 15e3) {
		this.devices = devices;
		this.send = send;
		this.scheduler = new WidgetPushScheduler(() => this.flush(), intervalMs);
	}
	changed(sessions) {
		this.latest = new Map(sessions.map((session) => [session.id, session]));
		for (const device of this.devices()?.list() ?? []) {
			const r = device.liveActivity;
			if (!r) continue;
			const state = liveActivityState(this.latest.get(r.sessionId));
			if (state.phase === "ended" || state.phase === "unavailable") this.devices()?.endLiveActivity(device.deviceId, r.token, state);
		}
		this.scheduler.changed();
	}
	async flush() {
		const devices = this.devices();
		if (!devices) return;
		const valid = /* @__PURE__ */ new Set();
		for (const device of devices.list()) {
			const r = device.liveActivity;
			if (!r) continue;
			const key = device.deviceId + ":" + r.token;
			valid.add(key);
			if (device.revokedAt !== void 0 || ![
				"notifications.register",
				"sessions.read",
				"interactions.respond"
			].every((scope) => device.scopes?.some((value) => value === scope)) || r.expiresAt <= Date.now()) {
				devices.clearLiveActivity(device.deviceId, r.activityId, r.token);
				continue;
			}
			const state = r.endedState ?? liveActivityState(this.latest.get(r.sessionId));
			const fingerprint = JSON.stringify(state);
			if (this.sent.get(key) === fingerprint) continue;
			if (devices.authorized(device.deviceId)?.liveActivity?.token !== r.token) continue;
			const result = await this.send(r.token, r.environment, {
				kind: "liveactivity",
				event: r.endedState ? "end" : "update",
				timestamp: Math.floor(Date.now() / 1e3),
				contentState: state
			}).catch(() => ({ outcome: "failed" }));
			if (result.outcome === "sent") this.sent.set(key, fingerprint);
			else if (result.outcome === "invalid-token") devices.clearLiveActivity(device.deviceId, r.activityId, r.token);
			else this.scheduler.changed();
		}
		for (const key of this.sent.keys()) if (!valid.has(key)) this.sent.delete(key);
	}
	dispose() {
		this.scheduler.dispose();
	}
};
//#endregion
//#region src/push-policy.ts
/** Prune only when the provider supplies an authoritative token-lifecycle verdict. */
function shouldPrunePushToken(outcome, reason) {
	return outcome === "invalid-token" && (reason === "Unregistered" || reason === "ExpiredToken");
}
/** APNs requires both registration and the same content permission as WS. */
function mayReceivePush(device, notification) {
	const scope = pushScopeFor("s2c.notify", notification);
	return scope !== void 0 && device.scopes?.includes("notifications.register") === true && device.scopes.includes(scope);
}
/**
* Zero-touch relay self-heal: HTTP 401 means the relay no longer honors the
* cached credential. Only auto-enrolled cells with a still-current token may
* re-derive it; an explicitly configured relay token remains user-owned
* configuration and is never silently rewritten.
*/
function shouldReEnrollRelayToken(transport, outcome, reason, opts) {
	return transport === "relay" && outcome === "failed" && reason === "HTTP 401" && opts.hasEnrollKey && opts.usedCellToken && opts.tokenStillCurrent;
}
/** Apply before either transport receives the payload, including the Relay. */
function pushContent(notification, mode) {
	if (mode !== "generic") return notification;
	const bodies = {
		"turn.completed": "A task has completed.",
		"approval.required": "An approval needs your attention.",
		"question.asked": "A question needs your answer.",
		"session.error": "A task needs your attention."
	};
	return {
		...notification,
		title: "DeepPilot",
		body: bodies[notification.category] ?? "Open DeepPilot for an update."
	};
}
//#endregion
//#region src/relay-test.ts
/**
* Relay connectivity self-test used by the settings page "测试中继" button.
*
* Two steps mirror what zero-touch enrollment actually does:
*   1. health  — GET {url}/healthz        → is the relay reachable?
*   2. enroll  — POST {url}/v1/enroll     → does the shared key grant a token?
*
* The enroll step doubles as a repair path: a token it issues is handed back
* via `onEnrolled` so the bridge caches it and flips push readiness without
* waiting for the next app registration.
*
* Transport is injectable (`fetchImpl`) so tests never touch the network.
*/
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
	const base = normalizeRelayBaseUrl(options.url);
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
//#region src/push-gateway.ts
/**
* 推送网关（PushGateway）——离线推送的单一属主。
*
* 迁移前，这约 450 行住在 `apply()` 的闭包里：enrollment cell 与持久化、
* `handlePushEnrollKey`、`resolvePushConfig`、`ensureRelayEnrolled`、
* `senderFor` + cachedSender + 失败退避、两个 scheduler、`makePushOutlet`、
* 两个自测。它今天的「接口」其实是「被 WidgetPushScheduler、
* LiveActivityPushManager、PushOutlet 和两个 report 回调各自捕获的那几段代码」
* ——没有任何一处能回答「推送为什么没到」。
*
* 现在：一个 module，实现 `PushOutlet`（HostBridge 消费的那四个方法）并额外
* 暴露自测与零配置注册入口。enrollment、持久化、sender 缓存、退避、401 自愈
* 全部入内；`apply()` 只做依赖注入。
*
* 两处本次收敛的重复：
* - effective provider 推导（原先在 resolvePushConfig 与 relay 自测里各一份）；
* - 401 自愈三元组（原先在 widget / liveActivity / fanOut 三处各一份，
*   见 healRelayCredential）。
*/
/** 274 秒（约 4.5 分钟）内的失败只记一次；其间同一指纹不再重试。 */
const SENDER_FAILURE_RETRY_MS = 6e4;
/** 中继注册失败的节流：一次/分钟，避免中继抖动把每次通知变成一次外呼。 */
const ENROLL_RETRY_MS = 6e4;
var PushGateway = class {
	deps;
	pushRelayPath;
	enrollmentCell = {};
	enrollmentWriteTail = Promise.resolve();
	enrollAttemptFor;
	enrollLastAttemptAt = 0;
	cachedSender;
	senderFailedFor;
	widgetPush;
	liveActivityPush;
	constructor(deps) {
		this.deps = deps;
		this.pushRelayPath = join(deps.dataDir, "push-relay.json");
		this.widgetPush = new WidgetPushScheduler(async () => {
			await this.flushWidgetPushes();
		});
		this.liveActivityPush = new LiveActivityPushManager(() => deps.devices() ?? void 0, async (deviceToken, environment, notification) => this.sendLiveActivity(deviceToken, environment, notification));
	}
	/** 首启恢复零配置注册状态（best effort）。 */
	async restore() {
		try {
			const raw = JSON.parse(await readFile(this.pushRelayPath, "utf8"));
			if (typeof raw.clientId === "string") this.enrollmentCell.clientId = raw.clientId;
			if (typeof raw.enrollKey === "string") this.enrollmentCell.enrollKey = raw.enrollKey;
			if (typeof raw.token === "string") this.enrollmentCell.token = raw.token;
			if (raw.autoRelay === true) this.enrollmentCell.autoRelay = true;
		} catch {}
	}
	/** 写盘串行化：并发注册不会交错写坏同一个文件。 */
	persistEnrollment() {
		const snapshot = JSON.stringify({
			version: 1,
			...this.enrollmentCell
		}, null, 2) + "\n";
		this.enrollmentWriteTail = this.enrollmentWriteTail.then(async () => {
			const tempPath = this.pushRelayPath + "." + randomBytes(6).toString("hex") + ".tmp";
			try {
				await mkdir(this.deps.dataDir, { recursive: true });
				await writeFile(tempPath, snapshot, { mode: 384 });
				await rename(tempPath, this.pushRelayPath);
			} catch {
				await unlink(tempPath).catch(() => {});
			}
		});
	}
	/** 等注册状态的写盘尾部排空；测试与收尾都用它取得确定性。 */
	async persisted() {
		await this.enrollmentWriteTail;
	}
	/** 进程收尾：等写盘尾部落盘，释放 sender。 */
	async dispose() {
		this.widgetPush.dispose();
		this.liveActivityPush.dispose();
		const sender = this.cachedSender;
		this.cachedSender = void 0;
		await Promise.allSettled([this.enrollmentWriteTail, sender?.dispose?.() ?? Promise.resolve()]);
	}
	widgetChanged() {
		this.widgetPush.changed();
	}
	liveActivityChanged(sessions) {
		this.liveActivityPush.changed(sessions);
	}
	/** 能力位必须说真话：只在 provider 完全就绪时才广告 push。 */
	isAvailable() {
		const resolved = this.resolvePushConfig(this.deps.config());
		if (!resolved.ok) return false;
		if (resolved.value.kind === "relay" && !resolved.value.token) return false;
		return true;
	}
	/**
	* 把一个值得通知的事件扇到持有 APNs token 的已配对设备。规则：
	*  - 有活跃 WebSocket 的设备跳过（它们已收到 WS 帧，会自己弹本地通知）；
	*  - 只考虑被授予 `notifications.register` 的设备——scope 被收窄的设备不得
	*    再收到离线推送（R1/P2 S→C 权限策略）；
	*  - 每设备按它自己注册的环境投递，沙盒与生产设备可共存；
	*  - 设备按类别的静音开关抑制对应类别；
	*  - 只有 APNs 的终态 Unregistered/ExpiredToken 才清理存储；
	*    BadDeviceToken 可能是环境不匹配，保留可诊断性。
	*/
	fanOut(sourceNotification) {
		const notification = pushContent({
			...sourceNotification,
			hostAudience: this.deps.audience() ?? void 0
		}, this.deps.config().push?.contentMode);
		(async () => {
			let resolved = this.resolvePushConfig(this.deps.config());
			if (!resolved.ok && resolved.reason === "relay token not enrolled yet") {
				await this.ensureRelayEnrolled(this.relayUrl());
				resolved = this.resolvePushConfig(this.deps.config());
			}
			if (!resolved.ok) return;
			const devices = this.deps.devices();
			if (!devices) return;
			const send = await this.senderFor(resolved.value);
			if (!send) return;
			const transport = resolved.value.kind;
			const connectedIds = /* @__PURE__ */ new Set();
			for (const connection of this.deps.connections()) {
				const id = connection.connectedDeviceId;
				if (id && connection.suppressesAlertPush) connectedIds.add(id);
			}
			const candidates = devices.list().filter((device) => {
				const registration = device.apns;
				if (!registration) return false;
				if (connectedIds.has(device.deviceId)) return false;
				if (!mayReceivePush(device, notification)) {
					if (this.deps.config().diagnostics?.debug === true) this.deps.log(`push skip "${deviceDisplayName(device)}": notification permission not granted`);
					return false;
				}
				if (registration.categories?.[notification.category] === false) {
					if (this.deps.config().diagnostics?.debug === true) this.deps.log(`push skip "${deviceDisplayName(device)}": category ${notification.category} muted`);
					return false;
				}
				return true;
			});
			if (candidates.length === 0) {
				const tokenized = devices.list().filter((device) => device.apns !== void 0).length;
				this.deps.log(`push(${transport}) ${notification.category}: no offline targets (connected=${connectedIds.size}, tokenized=${tokenized})`);
				return;
			}
			const relayUrl = resolved.value.kind === "relay" ? resolved.value.url : void 0;
			const relayTokenUsed = resolved.value.kind === "relay" ? resolved.value.token : void 0;
			const usedCellToken = relayTokenUsed !== void 0 && relayTokenUsed === this.enrollmentCell.token;
			const hasEnrollKey = Boolean(this.enrollmentCell.enrollKey);
			for (const device of candidates) {
				const registration = device.apns;
				send({
					deviceToken: registration.token,
					environment: registration.environment,
					notification
				}).then(({ outcome, reason }) => {
					this.deps.log(`push(${transport}) ${notification.category} → "${deviceDisplayName(device)}" [${registration.environment}] = ${outcome}${reason ? " (" + reason + ")" : ""}`);
					if (shouldPrunePushToken(outcome, reason)) {
						devices.clearPushToken(device.deviceId);
						this.deps.log(`push: pruned stale token of "${deviceDisplayName(device)}" (${reason ?? "unknown"}) — app re-registers on next launch`);
						return;
					}
					if (relayUrl !== void 0 && shouldReEnrollRelayToken(transport, outcome, reason, {
						usedCellToken,
						hasEnrollKey,
						tokenStillCurrent: this.enrollmentCell.token === relayTokenUsed
					})) this.healRelayCredential(relayUrl, relayTokenUsed, "push relay credential rejected (HTTP 401); re-enrolling");
				}).catch(() => {});
			}
		})();
	}
	/** 分布式 App 在 c2s.push.register 里呈上分发方的共享钥匙时触发。 */
	async enrollKey(enrollKey) {
		if (this.enrollmentCell.enrollKey !== enrollKey) this.enrollmentCell.enrollKey = enrollKey;
		const configuredProvider = this.deps.config().push?.provider;
		if (!configuredProvider || configuredProvider === "none") {
			if (!this.enrollmentCell.autoRelay) {
				this.enrollmentCell.autoRelay = true;
				this.deps.log("push relay mode auto-enabled by enrolled app");
			}
		}
		this.persistEnrollment();
		await this.ensureRelayEnrolled(this.relayUrl());
	}
	/** 设置页推送自测：强制一条合成通知走完整链路到每个已注册设备。 */
	async selfTest() {
		const resolved = this.resolvePushConfig(this.deps.config());
		if (!resolved.ok) return {
			transport: "none",
			overall: "not-configured",
			message: "推送未启用（" + resolved.reason + "）。可先用「测试访问与注册」完成中继注册，或在配置中设置 push.provider",
			results: []
		};
		const devices = this.deps.devices();
		const tokenized = (devices?.list() ?? []).filter((device) => device.apns !== void 0);
		if (!devices || tokenized.length === 0) return {
			transport: resolved.value.kind,
			overall: "no-targets",
			message: "还没有设备注册离线推送——在手机上打开 DeepPilot 并允许系统通知，等状态变为「已就绪」后再试",
			results: []
		};
		const send = await this.senderFor(resolved.value);
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
				name: deviceDisplayName(device),
				environment: registration.environment,
				outcome,
				tokenFingerprint: registration.token.slice(0, 10),
				...reason !== void 0 ? { reason } : {}
			};
		}));
		const overall = results.some((r) => r.outcome === "sent") ? "sent" : "failed";
		this.deps.log("push self-test: " + overall + " (" + results.map((r) => `"${r.name}"=${r.outcome}${r.reason ? "/" + r.reason : ""}`).join(", ") + ")");
		return {
			transport: resolved.value.kind,
			overall,
			results
		};
	}
	/** 设置页中继自测：健康检查 + 注册往返，成功即完成一次注册。 */
	async relayTest() {
		const push = this.deps.config().push ?? {};
		const configured = push.provider ?? "none";
		if ((configured === "none" && this.enrollmentCell.autoRelay === true ? "relay" : configured) !== "relay") return {
			url: "",
			overall: "failed",
			tokenIssued: false,
			steps: [{
				id: "health",
				ok: false,
				message: `当前推送模式不是中继（provider=${configured}）。启用方式二选一：① 零配置——在 ios/project.yml 填写 DSPushEnrollKey（与服务器 RELAY_ENROLL_KEY 一致）并重新安装 App，打开 App 即自动启用；② 手动——将 push.provider 设为 relay 并填入 relayToken`
			}]
		};
		const url = this.relayUrl();
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
		if (!this.enrollmentCell.clientId && this.enrollmentCell.enrollKey) {
			this.enrollmentCell.clientId = "u_" + randomBytes(16).toString("base64url");
			this.persistEnrollment();
		}
		return await runRelayProbe({
			url,
			clientId: this.enrollmentCell.clientId,
			enrollKey: this.enrollmentCell.enrollKey,
			manualToken: Boolean((push.relayToken ?? "").trim()),
			...this.deps.fetchImpl !== void 0 ? { fetchImpl: this.deps.fetchImpl } : {},
			onEnrolled: (token) => {
				this.enrollmentCell.token = token;
				this.persistEnrollment();
				this.deps.log("push relay enrollment succeeded (via settings self-test)");
			}
		});
	}
	relayUrl() {
		return (this.deps.config().push?.relayUrl ?? "").trim() || "https://pilot.hailab.dev";
	}
	resolvePushConfig(config) {
		const push = config.push ?? {};
		const configured = push.provider ?? "none";
		const effectiveProvider = configured === "none" && this.enrollmentCell.autoRelay === true ? "relay" : configured;
		if (effectiveProvider === "relay") {
			const url = this.relayUrl();
			const token = (push.relayToken ?? "").trim() || this.enrollmentCell.token || "";
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
			const keyPath = expandHome((push.keyPath ?? "").trim() || join(this.deps.dataDir, "apns", "AuthKey.p8"));
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
	}
	/**
	* 对运营方中继做零配置注册。幂等且结果缓存在持久化单元里；一次失败只留
	* 一行日志，直到配置指纹变化。
	*/
	async ensureRelayEnrolled(url) {
		if (!/^https:\/\//i.test(url.trim())) {
			this.deps.log("push relay enrollment refused: relayUrl must be an https URL");
			return;
		}
		if (this.enrollmentCell.token) return this.enrollmentCell.token;
		const fingerprint = url + ":" + String(this.enrollmentCell.enrollKey ?? "");
		if (fingerprint !== this.enrollAttemptFor) {
			this.enrollAttemptFor = fingerprint;
			this.enrollLastAttemptAt = 0;
		}
		if (Date.now() - this.enrollLastAttemptAt < ENROLL_RETRY_MS) return void 0;
		this.enrollLastAttemptAt = Date.now();
		try {
			if (!this.enrollmentCell.clientId) {
				this.enrollmentCell.clientId = "u_" + randomBytes(16).toString("base64url");
				this.persistEnrollment();
			}
			const token = await new RelayClient({
				url,
				debug: this.deps.config().diagnostics?.debug === true,
				log: this.deps.log
			}).enroll(this.enrollmentCell.clientId, this.enrollmentCell.enrollKey ?? "");
			if (!token) {
				this.deps.log("push relay enrollment failed (" + url + "); will retry on next trigger");
				return;
			}
			this.enrollmentCell.token = token;
			this.persistEnrollment();
			this.deps.log("push relay enrollment succeeded");
			return token;
		} catch (error) {
			this.deps.log("push relay enrollment error: " + String(error));
			return;
		}
	}
	/**
	* 按当前配置惰性构建 sender。坏配置（读不到的 .p8）只让该指纹失效并留
	* 一行日志，而不是每个事件都失败。
	*/
	async senderFor(resolved) {
		const fingerprint = JSON.stringify(resolved);
		if (this.cachedSender?.fingerprint === fingerprint) return this.cachedSender.send;
		if (this.senderFailedFor?.fingerprint === fingerprint && Date.now() - this.senderFailedFor.at < SENDER_FAILURE_RETRY_MS) return;
		if (this.cachedSender) {
			await this.cachedSender.dispose?.().catch(() => {});
			this.cachedSender = void 0;
		}
		if (resolved.kind === "relay") {
			const client = new RelayClient({
				url: resolved.url,
				token: resolved.token,
				debug: this.deps.config().diagnostics?.debug === true,
				log: this.deps.log
			});
			this.cachedSender = {
				fingerprint,
				send: (request) => client.send(request)
			};
			this.deps.log("push relay enabled");
		} else {
			try {
				await readFile(expandHome(resolved.keyPath), "utf8");
			} catch (error) {
				this.senderFailedFor = {
					fingerprint,
					at: Date.now()
				};
				this.deps.log("apns push unavailable (key unreadable at " + resolved.keyPath + "): " + String(error));
				return;
			}
			const client = new ApnsClient({
				teamId: resolved.teamId,
				keyId: resolved.keyId,
				keyPath: resolved.keyPath,
				bundleId: resolved.bundleId,
				debug: this.deps.config().diagnostics?.debug === true,
				log: this.deps.log
			});
			this.cachedSender = {
				fingerprint,
				send: (request) => client.send({
					...request.notification,
					deviceToken: request.deviceToken,
					environment: request.environment
				}),
				dispose: () => client.dispose()
			};
			this.deps.log("apns push enabled");
		}
		this.senderFailedFor = void 0;
		return this.cachedSender.send;
	}
	/**
	* 小组件总览推送：令牌新鲜、三项 scope 齐全、7 天内的设备，按环境去重后
	* 各投一次；中继拒绝凭据时自愈。
	*/
	async flushWidgetPushes() {
		if (!this.deps.enabledNow()) return;
		const resolved = this.resolvePushConfig(this.deps.config());
		if (!resolved.ok) return;
		const devices = this.deps.devices();
		const send = await this.senderFor(resolved.value);
		if (!devices || !send) return;
		const sent = /* @__PURE__ */ new Set();
		for (const device of devices.list()) {
			const registration = device.widgetApns;
			if (!registration || device.revokedAt !== void 0 || ![
				"notifications.register",
				"sessions.read",
				"interactions.respond"
			].every((scope) => device.scopes?.includes(scope)) || Date.now() - registration.updatedAt > 6048e5) continue;
			const key = registration.environment + ":" + registration.token;
			if (sent.has(key)) continue;
			sent.add(key);
			const { outcome, reason } = await send({
				deviceToken: registration.token,
				environment: registration.environment,
				notification: { kind: "widget" }
			});
			if (shouldPrunePushToken(outcome, reason)) devices.clearWidgetPushToken(device.deviceId, registration.token);
			if (resolved.value.kind === "relay" && reason === "HTTP 401") await this.healRelayCredential(resolved.value.url, resolved.value.token);
		}
	}
	/** Live Activity 推送：与 alert 推送共用 sender 与自愈。 */
	async sendLiveActivity(deviceToken, environment, notification) {
		if (!this.deps.enabledNow()) return { outcome: "failed" };
		const resolved = this.resolvePushConfig(this.deps.config());
		if (!resolved.ok) return { outcome: "failed" };
		const send = await this.senderFor(resolved.value);
		if (!send) return { outcome: "failed" };
		const result = await send({
			deviceToken,
			environment,
			notification
		});
		if (resolved.value.kind === "relay" && result.reason === "HTTP 401") await this.healRelayCredential(resolved.value.url, resolved.value.token);
		return result;
	}
	/**
	* 401 自愈（原先是三份拷贝：widget / liveActivity / fanOut）。
	* 中继不再认这个凭据：丢掉它，从 enroll key 重新派生。节流由
	* ensureRelayEnrolled 自己负责，并行 401 不会打爆端点。
	*/
	async healRelayCredential(url, token, logLine) {
		if (token === void 0 || this.enrollmentCell.token !== token) return;
		if (!this.enrollmentCell.enrollKey) return;
		this.enrollmentCell.token = void 0;
		this.persistEnrollment();
		if (logLine !== void 0) this.deps.log(logLine);
		await this.ensureRelayEnrolled(url);
	}
};
//#endregion
//#region src/phone-server.ts
/**
* A deliberately narrow transport listener. Both the LAN endpoint and the
* loopback-only Funnel origin use this factory, so neither can accidentally
* inherit DSH's wider web/API route surface.
*
* With `tls` the listener speaks HTTPS/WSS only (the LAN posture); without
* it the listener is plain HTTP, which is reserved for the loopback Funnel
* origin where tailscaled terminates TLS.
*/
function createPhoneServer(handlers, tls) {
	const onRequest = (req, res) => {
		const path = requestPath(req);
		if (path === "/phone/health") handlers.health(req, res);
		else if (path === "/phone/pair") handlers.pair(req, res);
		else {
			res.statusCode = 404;
			res.end("not found");
		}
	};
	const server = tls === void 0 ? createServer(onRequest) : createServer$1({
		key: tls.key,
		cert: tls.cert,
		minVersion: "TLSv1.2"
	}, onRequest);
	server.on("upgrade", (req, socket, head) => {
		if (requestPath(req) !== "/phone") {
			socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			return;
		}
		handlers.upgrade(req, socket, head);
	});
	return server;
}
function requestPath(req) {
	try {
		return new URL(req.url ?? "/", "http://phone.local").pathname;
	} catch {
		return "/";
	}
}
function listen(server, port, host) {
	return new Promise((resolve, reject) => {
		const onError = (error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}
function closeServer(server) {
	if (server === void 0 || !server.listening) return Promise.resolve();
	return new Promise((resolve) => server.close(() => resolve()));
}
//#endregion
//#region src/transport-reconciler.ts
var TransportReconciler = class {
	spec;
	config;
	log;
	instance;
	appliedKey;
	disposed = false;
	tail = Promise.resolve();
	currentStatus;
	constructor(spec, config, log, initialStatus) {
		this.spec = spec;
		this.config = config;
		this.log = log;
		this.currentStatus = initialStatus;
	}
	/**
	* 当前状态；report 快照直接读它。实例不在场时返回协调器自己维护的状态
	* （disabled / error / 初始），不被 `statusOf(undefined)` 的缺省值覆盖——
	* 否则一次启动失败会把状态翻转回 idle。
	*/
	status() {
		if (this.instance === void 0) return this.currentStatus;
		return this.spec.statusOf(this.instance) ?? this.currentStatus;
	}
	/** 由 loader/volatile-update 触发：串行执行，前一个没完就不抢。 */
	scheduleReconcile() {
		this.tail = this.tail.then(() => this.reconcile()).catch((error) => this.log("reconcile failed: " + String(error)));
	}
	/** 等当前在途的那一次完成；供 teardown 使用。 */
	async settled() {
		await this.tail;
	}
	/** 一次协调：差分 → 拆除 → 启动 → 状态。 */
	async reconcile() {
		if (this.disposed) return;
		const target = this.spec.keyOf(this.config());
		const nextKey = JSON.stringify(target);
		if (nextKey === this.appliedKey) return;
		if (this.spec.applyKey === "before-teardown") this.appliedKey = nextKey;
		const previous = this.instance;
		this.instance = void 0;
		if (previous !== void 0) await this.spec.stop(previous).catch(() => {});
		if (this.disposed) return;
		if (target.enabled !== true && this.spec.skipWhenDisabled) {
			this.currentStatus = this.spec.disabledStatus(target);
			if (this.spec.disabledMessage !== void 0) this.log(this.spec.disabledMessage);
			return;
		}
		this.currentStatus = this.spec.startingStatus(target);
		try {
			const constructed = this.spec.construct(target);
			this.instance = constructed;
			if (this.spec.applyKey === "after-construct") this.appliedKey = nextKey;
			const replacement = await this.spec.begin(constructed, {
				isCurrent: () => this.appliedKey === nextKey,
				owns: (instance) => this.instance === instance,
				isDisposed: () => this.disposed
			});
			if (replacement !== void 0) this.instance = replacement;
			if (this.disposed) {
				await this.spec.stop(this.instance).catch(() => {});
				return;
			}
			this.currentStatus = this.spec.statusOf(this.instance) ?? this.currentStatus;
		} catch (error) {
			if (this.spec.errorStatus === void 0) throw error;
			const partial = this.instance;
			this.instance = void 0;
			if (partial !== void 0) await this.spec.stop(partial).catch(() => {});
			this.currentStatus = this.spec.errorStatus(error, target);
			this.log(this.spec.failureMessage?.(error) ?? "transport failed: " + String(error));
		}
	}
	/** 进程收尾：标记销毁、拆掉实例、等在途的那一次完成。 */
	async dispose() {
		this.disposed = true;
		const active = this.instance;
		this.instance = void 0;
		await this.spec.stop(active).catch(() => {});
		await this.tail;
	}
};
/**
* LAN 传输：TLS-only，绑定 0.0.0.0 的稳定端口。
*
* 三处刻意保留的差异：`skipWhenDisabled: true`（未启用即提前返回并置
* disabled）、`applyKey: 'before-teardown'`（拆除旧 listener 之前写键）、
* 有错误分支（监听失败落到 `phase: 'error'`）。另有两处 supersede 检查原样
* 保留：TLS 加载后查 `isCurrent()`，listen 后查 `owns()`。
*/
function createLocalTransport(deps) {
	return new TransportReconciler({
		keyOf: (config) => ({
			enabled: config.enabled === true && config.local?.enabled !== false,
			port: normalizeLocalPort(config.local?.port)
		}),
		skipWhenDisabled: true,
		applyKey: "before-teardown",
		construct: (target) => ({
			server: void 0,
			tlsFingerprint: void 0,
			port: normalizeLocalPort(target.port),
			onlineAt: Date.now()
		}),
		begin: async (instance, guard) => {
			const tls = await deps.tls();
			if (!guard.isCurrent() || guard.isDisposed()) return;
			const port = instance.port;
			const server = createPhoneServer(deps.handlers, {
				key: tls.key,
				cert: tls.cert
			});
			instance.server = server;
			instance.tlsFingerprint = tls.fingerprint;
			await listen(server, port, "0.0.0.0");
			if (!guard.owns(instance) || guard.isDisposed()) {
				instance.server = void 0;
				await closeServer(server);
				return;
			}
			instance.onlineAt = Date.now();
			deps.log(`local transport listening on https://0.0.0.0:${port} (tls fingerprint ${tls.fingerprint})`);
		},
		stop: async (instance) => {
			if (instance?.server === void 0) return;
			const server = instance.server;
			instance.server = void 0;
			await closeServer(server);
		},
		disabledStatus: (target) => ({
			phase: "disabled",
			port: normalizeLocalPort(target.port),
			endpoints: [],
			updatedAt: Date.now()
		}),
		startingStatus: (target) => ({
			phase: "starting",
			port: normalizeLocalPort(target.port),
			endpoints: [],
			updatedAt: Date.now()
		}),
		errorStatus: (error, target) => ({
			phase: "error",
			port: normalizeLocalPort(target.port),
			endpoints: [],
			message: localListenError(error, normalizeLocalPort(target.port)),
			updatedAt: Date.now()
		}),
		disabledMessage: "local transport disabled",
		failureMessage: (error) => "local transport failed: " + localListenError(error, 0),
		statusOf: (instance) => {
			if (instance === void 0 || instance.server === void 0) return void 0;
			return {
				phase: "online",
				port: instance.port,
				endpoints: [],
				tlsFingerprint: instance.tlsFingerprint,
				updatedAt: instance.onlineAt
			};
		}
	}, deps.config, deps.log, {
		phase: deps.config().enabled === true && deps.config().local?.enabled !== false ? "starting" : "disabled",
		port: normalizeLocalPort(deps.config().local?.port),
		endpoints: [],
		updatedAt: Date.now()
	});
}
/**
* Funnel 传输：loopback origin + Tailscale Funnel helper。
*
* 三处刻意保留的差异：`skipWhenDisabled: false`（未启用仍构造 supervisor，
* 由其内部 no-op 把状态置 disabled）、`applyKey: 'after-construct'`
* （supervisor 构造后、异步 start 之前写键）、没有错误分支（supervisor 自己
* 的状态机负责 phase）。
*/
function createRemoteTransport(deps) {
	const fallbackStatus = () => ({
		provider: "tailscale-funnel",
		phase: deps.config().remote?.enabled === true ? "stopped" : "disabled",
		updatedAt: Date.now()
	});
	return new TransportReconciler({
		keyOf: (config) => {
			const remoteConfig = config.remote ?? {};
			const remotePort = remoteConfig.funnelPort === 8443 || remoteConfig.funnelPort === 1e4 ? remoteConfig.funnelPort : 443;
			return {
				enabled: config.enabled === true && remoteConfig.enabled === true && remoteConfig.provider === "tailscale-funnel",
				hostname: normalizeRemoteHostname(remoteConfig.hostname),
				statePath: remoteConfig.statePath?.trim() || join(deps.dataDir, "tailscale"),
				helperPath: remoteConfig.helperPath?.trim() || void 0,
				funnelPort: remotePort,
				maxConnectionsPerSource: normalizeFunnelConnectionLimit(remoteConfig.maxConnectionsPerSource)
			};
		},
		skipWhenDisabled: false,
		applyKey: "after-construct",
		construct: (target) => new RemoteSupervisor({
			enabled: target.enabled === true,
			hostname: String(target.hostname),
			statePath: String(target.statePath),
			...target.helperPath !== void 0 ? { helperPath: String(target.helperPath) } : {},
			funnelPort: target.funnelPort,
			maxConnectionsPerSource: Number(target.maxConnectionsPerSource),
			log: deps.log
		}),
		begin: async (supervisor) => {
			const originURL = deps.originURL();
			if (originURL === void 0) return;
			await supervisor.start(originURL);
		},
		stop: async (supervisor) => {
			if (supervisor === void 0) return;
			await supervisor.dispose();
		},
		disabledStatus: () => ({
			provider: "tailscale-funnel",
			phase: "disabled",
			updatedAt: Date.now()
		}),
		startingStatus: () => ({
			provider: "tailscale-funnel",
			phase: "stopped",
			updatedAt: Date.now()
		}),
		statusOf: (supervisor) => supervisor?.status() ?? fallbackStatus()
	}, deps.config, deps.log, fallbackStatus());
}
//#endregion
//#region src/dispatch-journal.ts
/**
* at-most-once dispatch journal：prompt 投递与非 prompt 变更的**同一个** module。
*
* 迁移前 `prompt-delivery.ts` 与 `mutation-journal.ts` 是同一份耐久协议的两份
* 拷贝（盘点结论：key/expired/save 骨架字节级相同，mutation 甚至反向 import
* prompt 的 validSendId，共享已从错误方向发生）。两者的差别集中在六个面：
* 指纹覆盖范围、条目字段、回执形状、id 校验、lookup、落盘容器格式——全部收进
* 注入的 codec；核心只留耐久协议。
*
* 核心拥有：key 派生、原子写盘（temp + fsync + rename + 目录 fsync）、加载与
* 逐字段校验、保留清扫、容量、healthy 降级、在途去重、opener 单例。
*
* codec 拥有：一次投递的全部「方言」。它同时是两个 adapter——prompt 回执与
* mutation 结果——因此这条缝是真的，不是假想的。
*/
const DEFAULT_CAPACITY = 1e4;
const DEFAULT_RETENTION_MS = 6048e5;
/** 比保留窗口多宽限 5 分钟：边界附近的条目不会被反复删了又写。 */
const SWEEP_GRACE_MS = 3e5;
/** Durable at-most-once dispatch. Unknown outcomes are never automatically retried. */
var DispatchJournal = class {
	options;
	entries = Object.create(null);
	inFlight = /* @__PURE__ */ new Map();
	healthy = true;
	maxFileBytes;
	capacity;
	retentionMs;
	joinInFlight;
	constructor(options) {
		this.options = options;
		this.maxFileBytes = options.maxFileBytes ?? 8388608;
		this.capacity = options.capacity ?? DEFAULT_CAPACITY;
		this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
		this.joinInFlight = options.joinInFlight ?? true;
		const path = options.path;
		if (path === void 0 || !existsSync(path)) return;
		try {
			if (statSync(path).size > this.maxFileBytes) throw new Error("oversized journal");
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.length > this.capacity) throw new Error("invalid journal");
			const loaded = this.options.codec.parse(parsed.entries);
			for (const key of Object.keys(loaded)) this.entries[key] = loaded[key];
		} catch {
			this.healthy = false;
		}
	}
	key(deviceId, id) {
		return createHash("sha256").update(JSON.stringify([deviceId, id])).digest("hex");
	}
	/** id 的纪元前缀是否还在保留窗口内（未来 5 分钟以上同样算非法）。 */
	expired(id, now = Date.now()) {
		const age = now - Number(id.slice(0, 13));
		return age > this.retentionMs || age < -3e5;
	}
	save() {
		const path = this.options.path;
		if (path === void 0) return;
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		const temp = path + "." + randomUUID() + ".tmp";
		const fd = openSync(temp, "wx", 384);
		try {
			writeFileSync(fd, JSON.stringify({
				version: 1,
				entries: this.options.codec.serialize(this.entries)
			}));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
		const dir = openSync(dirname(path), "r");
		try {
			fsyncSync(dir);
		} finally {
			closeSync(dir);
		}
	}
	/** 查询既有回执；`request` 交给 codec 的 matches 判定（缺省即不提供 lookup）。 */
	lookup(deviceId, id, request) {
		const codec = this.options.codec;
		if (codec.matches === void 0) return void 0;
		if (!this.healthy) return codec.resultOf({ kind: "unavailable" }, id);
		const entry = this.entries[this.key(deviceId, id)];
		if (entry !== void 0 && codec.matches(entry, request)) return codec.resultOf({
			kind: "replay",
			entry
		}, id);
		return codec.miss?.(id, this.expired(id)) ?? codec.resultOf({ kind: "unavailable" }, id);
	}
	/**
	* 幂等投递。未知结果绝不自动重试：条目保持 unknown，重放时由 codec 决定
	* 调用方看到什么。
	*/
	async dispatch(deviceId, id, request, operation) {
		const codec = this.options.codec;
		if (codec.requiresValidId === true && !validSendId(id)) return codec.resultOf({ kind: "invalid-id" }, id);
		const key = this.key(deviceId, id);
		const fingerprint = codec.fingerprint(request);
		const existing = this.entries[key];
		if (existing !== void 0) {
			if (existing.fingerprint !== fingerprint) return codec.resultOf({ kind: "mismatch" }, id);
			const pending = this.inFlight.get(key);
			if (this.joinInFlight && pending !== void 0) return pending;
			return codec.resultOf({
				kind: "replay",
				entry: existing
			}, id);
		}
		if (!this.healthy) return codec.resultOf({ kind: "unavailable" }, id);
		if (this.expired(id)) return codec.resultOf({ kind: "expired" }, id);
		const now = Date.now();
		for (const [entryKey, entry] of Object.entries(this.entries)) if (now - entry.createdAt > this.retentionMs + SWEEP_GRACE_MS && !this.inFlight.has(entryKey)) delete this.entries[entryKey];
		if (Object.keys(this.entries).length >= this.capacity) return codec.resultOf({ kind: "full" }, id);
		const entry = {
			fingerprint,
			createdAt: Number(id.slice(0, 13)),
			...codec.reserve(request, id)
		};
		this.entries[key] = entry;
		try {
			this.save();
		} catch {
			this.healthy = false;
			return codec.resultOf({ kind: "reserve-failed" }, id);
		}
		const run = (async () => {
			let ran;
			try {
				ran = await operation();
				if (ran.ok) codec.accepted(entry, id, ran.value);
				else codec.rejected(entry, id, ran.code);
			} catch {
				return codec.resultOf({ kind: "crashed" }, id);
			}
			try {
				this.save();
			} catch {
				this.healthy = false;
			}
			return codec.resultOf({
				kind: "ran",
				entry,
				result: ran
			}, id);
		})();
		this.inFlight.set(key, run);
		try {
			return await run;
		} finally {
			this.inFlight.delete(key);
		}
	}
	/** 等所有在途投递结束；供进程收尾。 */
	async settled() {
		while (this.inFlight.size > 0) await Promise.all([...this.inFlight.values()]);
	}
};
const journals = /* @__PURE__ */ new Map();
/**
* 按 path + codec 身份取单例。身份进键是必要的：同一路径用不同 codec/persistValues
* 打开必须得到不同实例——迁移前的键只有 path，`persistValues` 因此会被静默忽略。
*/
function openDispatchJournal(options) {
	const { path, codec } = options;
	if (path === void 0) return new DispatchJournal(options);
	const cacheKey = path + "|" + codec.identity;
	const cached = journals.get(cacheKey);
	if (cached !== void 0) return cached;
	const journal = new DispatchJournal(options);
	journals.set(cacheKey, journal);
	return journal;
}
/** 受理即 accepted；四种会被 APNs 终态清理的失败码之外一律原样上抛。 */
const PROMPT_RECEIPT_CODES = [
	"E_BUSY",
	"E_NOT_FOUND",
	"E_PROTOCOL",
	"E_UNSUPPORTED"
];
/**
* prompt 投递方言：
* - 指纹覆盖 [sessionId, content]（同一条 prompt 换会话重发视为不同请求）；
* - 并发重复搭同在途那次（joinInFlight），因此重复方拿到同一最终回执；
* - 有 lookup，且 sessionId 不匹配即视为未命中；
* - 落盘是 [key, entry] 二元组数组（历史格式，零迁移）。
*/
const promptDeliveryCodec = {
	identity: "prompt-delivery",
	fingerprint: (request) => createHash("sha256").update(JSON.stringify([request.sessionId, request.content])).digest("hex"),
	reserve: (request, id) => ({
		sessionId: request.sessionId,
		receipt: {
			clientSendId: id,
			status: "unknown"
		}
	}),
	accepted: (entry, id, value) => {
		entry.receipt;
		entry.receipt = {
			clientSendId: id,
			status: "accepted",
			userSeq: value
		};
	},
	rejected: (entry, id, code) => {
		entry.receipt;
		entry.receipt = {
			clientSendId: id,
			status: "rejected",
			code
		};
	},
	resultOf: (outcome, id) => {
		switch (outcome.kind) {
			case "replay":
			case "ran": return outcome.entry.receipt ?? {
				clientSendId: id,
				status: "unknown"
			};
			case "mismatch": return {
				clientSendId: id,
				status: "rejected",
				code: "E_PROTOCOL"
			};
			case "unavailable":
			case "crashed":
			case "reserve-failed": return {
				clientSendId: id,
				status: "unknown"
			};
			case "expired": return {
				clientSendId: id,
				status: "expired"
			};
			case "full": return {
				clientSendId: id,
				status: "rejected",
				code: "E_BUSY"
			};
			case "invalid-id": return {
				clientSendId: id,
				status: "rejected",
				code: "E_PROTOCOL"
			};
		}
	},
	requiresValidId: false,
	matches: (entry, request) => entry.sessionId === request,
	miss: (id, expired) => ({
		clientSendId: id,
		status: expired ? "expired" : "notFound"
	}),
	parse: (raw) => {
		const out = Object.create(null);
		for (const [key, value] of raw) {
			if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key) || !value || typeof value.sessionId !== "string" || !Number.isFinite(value.createdAt) || typeof value.fingerprint !== "string" || !validSendId(value.receipt?.clientSendId) || ![
				"accepted",
				"rejected",
				"unknown"
			].includes(value.receipt.status)) throw new Error("invalid entry");
			if (!/^[a-f0-9]{64}$/.test(value.fingerprint) || value.createdAt !== Number(value.receipt.clientSendId.slice(0, 13)) || value.receipt.status === "accepted" && !Number.isSafeInteger(value.receipt.userSeq) || value.receipt.status === "rejected" && !PROMPT_RECEIPT_CODES.includes(String(value.receipt.code))) throw new Error("invalid receipt");
			out[key] = value;
		}
		return out;
	},
	serialize: (entries) => Object.entries(entries).map(([key, entry]) => [key, entry])
};
/**
* mutation 方言（schedule 与 fork 共用，fork 打开 persistValues）：
* - 有 id 守卫，且在最前面（形状非法的 clientRequestId 不落盘）；
* - 并发重复不搭在途那次：重复方立刻拿到 unknown → E_INTERNAL「不得自动重试」；
* - 成功值只在 persistValues 时落盘——fork 需要重启后仍能重放 sessionId，
*   schedule 的 authoritative 资源由客户端重新拉取，不在此复制第二份；
* - 落盘是对象数组（历史格式，零迁移）。
*/
function scheduleMutationCodec(persistValues) {
	const isErrorCode = (value) => typeof value === "string" && value in ERROR_CODES;
	return {
		identity: "mutation:" + (persistValues ? "persist" : "memory"),
		fingerprint: (request) => createHash("sha256").update(JSON.stringify(request)).digest("hex"),
		reserve: () => ({ status: "unknown" }),
		accepted: (entry, _id, value) => {
			entry.status = "accepted";
			if (persistValues) entry.value = value;
		},
		rejected: (entry, _id, code) => {
			entry.status = "rejected";
			entry.code = code;
		},
		resultOf: (outcome, id) => {
			switch (outcome.kind) {
				case "ran": return outcome.result;
				case "replay": {
					const entry = outcome.entry;
					if (entry.status === "accepted") return {
						ok: true,
						value: entry.value,
						replayed: true
					};
					if (entry.status === "rejected" && entry.code !== void 0) return {
						ok: false,
						code: entry.code,
						replayed: true
					};
					return {
						ok: false,
						code: "E_INTERNAL",
						message: "mutation outcome is unknown; do not retry automatically",
						replayed: true
					};
				}
				case "mismatch": return {
					ok: false,
					code: "E_PROTOCOL",
					message: "clientRequestId was reused with different content",
					replayed: true
				};
				case "invalid-id": return {
					ok: false,
					code: "E_PROTOCOL",
					message: "invalid clientRequestId"
				};
				case "unavailable": return {
					ok: false,
					code: "E_INTERNAL",
					message: "mutation journal unavailable"
				};
				case "expired": return {
					ok: false,
					code: "E_PROTOCOL",
					message: "clientRequestId is outside the retry window"
				};
				case "full": return {
					ok: false,
					code: "E_BUSY",
					message: "mutation journal is full"
				};
				case "reserve-failed": return {
					ok: false,
					code: "E_INTERNAL",
					message: "mutation journal could not persist the request"
				};
				case "crashed": return {
					ok: false,
					code: "E_INTERNAL",
					message: "mutation outcome is unknown; do not retry automatically"
				};
			}
		},
		requiresValidId: true,
		parse: (raw) => {
			const out = Object.create(null);
			for (const value of raw) {
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid mutation entry");
				const entry = value;
				if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint) || typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) || ![
					"accepted",
					"rejected",
					"unknown"
				].includes(String(entry.status))) throw new Error("invalid mutation entry");
				if (entry.status === "rejected" && !isErrorCode(entry.code)) throw new Error("invalid mutation code");
				const key = String(value.key);
				if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("invalid mutation key");
				out[key] = {
					fingerprint: entry.fingerprint,
					createdAt: entry.createdAt,
					status: entry.status,
					...isErrorCode(entry.code) ? { code: entry.code } : {},
					...persistValues && entry.value !== void 0 ? { value: entry.value } : {}
				};
			}
			return out;
		},
		serialize: (entries) => Object.entries(entries).map(([key, entry]) => ({
			key,
			...entry
		}))
	};
}
//#endregion
//#region src/host-api.ts
/**
* Subagent sessions are host-internal workers of a parent conversation.
* They must never surface on the phone: not in the project/session list,
* and not as turn-completion pushes for a session the device cannot open.
*
* `parentSessionId` alone is NOT a subagent signal: a session forked from
* another one (c2s.session.fork) also carries it, as fork lineage, while
* being an ordinary top-level session the phone must show. Only the host's
* explicit `origin` marks a worker — mirror the same rule already used for
* the live mux stream (see dsh-api-proxy.ts's `isSubagent` derivation).
*/
function isSubagentRow(row) {
	return row.origin === "subagent";
}
function unwrapStreamItem(item) {
	const nested = item.payload;
	if (nested && typeof nested === "object" && typeof nested.type === "string") return item.rpcId ? {
		...nested,
		rpcId: item.rpcId
	} : nested;
	return item;
}
//#endregion
//#region src/document-payload.ts
const PREFIX = "[DeepPilot document:";
const SUFFIX = "]";
/**
* DSH 0.1.2 has durable image attachments but no generic file content block.
* Documents therefore travel as a bounded, explicitly-labelled text block.
* The marker lets the canonical phone row recover an attachment chip without
* exposing the complete document body as ordinary user-authored bubble text.
*/
function documentPromptBlock(document) {
	const marker = {
		v: 1,
		name: document.name,
		mediaType: document.mediaType,
		...document.truncated ? { truncated: true } : {}
	};
	const encoded = Buffer.from(JSON.stringify(marker), "utf8").toString("base64url");
	return `${PREFIX}${encoded}${SUFFIX}\nAttached document: ${document.name}\n\n${document.text}`;
}
function projectedDocument(text) {
	if (!text.startsWith(PREFIX)) return void 0;
	const end = text.indexOf(SUFFIX, 20);
	if (end < 0) return void 0;
	try {
		const decoded = JSON.parse(Buffer.from(text.slice(20, end), "base64url").toString("utf8"));
		if (decoded.v !== 1 || typeof decoded.name !== "string" || typeof decoded.mediaType !== "string") return void 0;
		if (!decoded.name.trim() || !decoded.mediaType.trim()) return void 0;
		return {
			name: decoded.name,
			mediaType: decoded.mediaType,
			text: text.slice(end + 1).replace(/^\nAttached document:[^\n]*\n\n/, ""),
			...decoded.truncated === true ? { truncated: true } : {}
		};
	} catch {
		return;
	}
}
//#endregion
//#region src/host-event-projection.ts
const MAX_MESSAGE_PROJECTION_BYTES = 262144;
/** One durable host event sequence becomes exactly one phone message row.
* Keep the last projection when a host history response repeats an event. */
function canonicalSessionMessages(messages) {
	const bySequence = /* @__PURE__ */ new Map();
	for (const message of messages) bySequence.set(message.seq, message);
	return [...bySequence.values()].sort((a, b) => a.seq - b.seq);
}
function limitSessionPageMessages(messages) {
	const canonical = canonicalSessionMessages(messages);
	let bytes = 2;
	const kept = [];
	for (let index = canonical.length - 1; index >= 0; index -= 1) {
		const message = canonical[index];
		const candidateBytes = jsonBytes(message) + (kept.length > 0 ? 1 : 0);
		if (bytes + candidateBytes > 921600) break;
		kept.unshift(message);
		bytes += candidateBytes;
	}
	return {
		messages: kept,
		dropped: canonical.length - kept.length
	};
}
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
		case "system/message": return null;
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
			const ok = data?.error === void 0;
			const result = limitMessageProjection({
				seq: event.seq,
				role: "tool",
				ts: tsOf(event),
				tool: {
					name: "result",
					state: ok ? "ok" : "error",
					summary: ok ? summarizeResult(data?.message?.content) : "失败"
				},
				...ok ? attachmentProjection(data?.message) : {}
			});
			return {
				kind: "tool.end",
				data: {
					seq: result.seq,
					role: result.role,
					ts: result.ts,
					ok,
					summary: result.tool?.summary,
					...result.attachments ? { attachments: result.attachments } : {},
					...data?.callId ? { callId: String(data.callId) } : {}
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
			if (piece.type === "text" && typeof piece.text === "string") return projectedDocument(piece.text) ? "" : piece.text;
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
	const attachments = [];
	for (const part of obj.content) {
		if (!part || typeof part !== "object") continue;
		const block = part;
		if (block.type === "text" && typeof block.text === "string") {
			const document = projectedDocument(block.text);
			if (document) attachments.push({
				kind: "document",
				name: document.name,
				mediaType: document.mediaType,
				...document.truncated ? { truncated: true } : {}
			});
			continue;
		}
		if (block.type !== "image" || !block.attachment) continue;
		const attachmentId = typeof block.attachment.attachmentId === "string" && block.attachment.attachmentId.length > 0 ? block.attachment.attachmentId : void 0;
		const width = typeof block.attachment.width === "number" && Number.isFinite(block.attachment.width) ? block.attachment.width : void 0;
		const height = typeof block.attachment.height === "number" && Number.isFinite(block.attachment.height) ? block.attachment.height : void 0;
		attachments.push({
			kind: "image",
			...typeof block.attachment.name === "string" ? { name: block.attachment.name } : {},
			...typeof block.attachment.mediaType === "string" ? { mediaType: block.attachment.mediaType } : {},
			...attachmentId ? { attachmentId } : {},
			...width !== void 0 ? { width } : {},
			...height !== void 0 ? { height } : {}
		});
	}
	return attachments;
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
			case "system/message": break;
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
				const attachments = failed ? {} : attachmentProjection(data?.message);
				if (target?.tool) {
					target.tool = {
						...target.tool,
						state: failed ? "error" : "ok",
						summary
					};
					if (attachments.attachments) Object.assign(target, attachments);
				} else messages.push({
					...base,
					role: "tool",
					tool: {
						name: "result",
						state: failed ? "error" : "ok",
						summary
					},
					...attachments
				});
				break;
			}
		}
	}
	return canonicalSessionMessages(messages.map(limitMessageProjection));
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
//#region src/host-capabilities.ts
/** 每位一行：Host 上必须存在的依赖。缺失即该位为 false，相关帧回 E_UNSUPPORTED。 */
const HOST_CAPABILITY_PROBES = {
	models: (proxy) => typeof proxy.sessions.models === "function",
	sessionManagement: (proxy) => typeof proxy.sessions.rename === "function" && typeof proxy.workspace?.archiveSession === "function",
	sessionFork: (proxy) => typeof proxy.sessions.fork === "function",
	sessionRestore: (proxy) => typeof proxy.workspace?.unarchiveSession === "function",
	projectSelection: (proxy) => typeof proxy.workspace?.list === "function" && typeof proxy.workspace?.create === "function",
	schedules: (proxy) => proxy.schedule !== void 0
};
/**
* 按当前 apiProxy 与推送出口算出 welcome 能力位。`push` 位描述「当前离线推送
* 可用」：APNs 凭据或中继注册就绪才为 true，否则客户端不应压下自己的本地通知。
*/
function capabilityBits(proxy, pushOutlet) {
	return {
		historyPaging: true,
		replay: true,
		approvals: true,
		questions: true,
		pendingSnapshot: true,
		promptDelivery: true,
		notifyAllCategories: true,
		models: HOST_CAPABILITY_PROBES.models(proxy),
		sessionManagement: HOST_CAPABILITY_PROBES.sessionManagement(proxy),
		sessionFork: HOST_CAPABILITY_PROBES.sessionFork(proxy),
		sessionRestore: HOST_CAPABILITY_PROBES.sessionRestore(proxy),
		projectSelection: HOST_CAPABILITY_PROBES.projectSelection(proxy),
		schedules: HOST_CAPABILITY_PROBES.schedules(proxy),
		push: pushOutlet?.isAvailable() === true,
		widgetPush: true,
		liveActivityPush: true,
		deviceRevoke: true
	};
}
//#endregion
//#region src/host-bridge.ts
const MAX_RING_DEFAULT = 2e3;
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
	activeTools = /* @__PURE__ */ new Map();
	approvals = /* @__PURE__ */ new Map();
	questions = /* @__PURE__ */ new Map();
	archivedSessionIds = /* @__PURE__ */ new Set();
	/** Mirrors archived rows from the last sessions.list so the phone can browse
	* and restore them. Excluded from `summaries` and from the live broadcast. */
	archivedSummaries = /* @__PURE__ */ new Map();
	subagentSessionIds = /* @__PURE__ */ new Set();
	sinks = /* @__PURE__ */ new Set();
	ring = [];
	cursor = 0;
	userReceiptSeq = 0;
	abort = new AbortController();
	started = false;
	disposed = false;
	promptDeliveries;
	scheduleMutations;
	forkMutations;
	constructor(apiProxy, historyBufferMax = MAX_RING_DEFAULT, deliveryJournalPath, scheduleJournalPath, forkJournalPath) {
		this.apiProxy = apiProxy;
		this.historyBufferMax = historyBufferMax;
		this.promptDeliveries = openDispatchJournal({
			path: deliveryJournalPath,
			codec: promptDeliveryCodec,
			joinInFlight: true,
			maxFileBytes: 8388608
		});
		this.scheduleMutations = openDispatchJournal({
			path: scheduleJournalPath,
			codec: scheduleMutationCodec(false),
			joinInFlight: false,
			maxFileBytes: 4194304
		});
		this.forkMutations = openDispatchJournal({
			path: forkJournalPath,
			codec: scheduleMutationCodec(true),
			joinInFlight: false,
			maxFileBytes: 4194304
		});
	}
	pushOutlet;
	widgetFingerprint = "";
	/**
	* Wire the offline-push fan-out. Present ⇒ welcome advertises the `push`
	* capability and notify-worthy events are mirrored to APNs.
	*/
	setPushOutlet(outlet) {
		this.pushOutlet = outlet;
	}
	/**
	* welcome 能力位。委托 host-capabilities.ts 的探测表：此前同一条事实在这里
	* 和各方法体内各存一份，已经漂移过两次（models 位过严、schedules 位与
	* schedule 方法的探测不同源）。
	*/
	get capabilities() {
		return capabilityBits(this.apiProxy, this.pushOutlet);
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
		if ((args.category === "turn.completed" || args.category === "session.error") && this.subagentSessionIds.has(args.sessionId)) return;
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
	* Each frame is filtered by the S→C permission policy per sink, so a
	* reader without interactions.respond never gets the missed approval
	* frames back (R1/P2).
	*/
	resumeFrom(cursor, target) {
		const oldest = this.ring.length > 0 ? this.ring[0].seq : this.cursor + 1;
		if (cursor + 1 < oldest) return false;
		const receivers = target !== void 0 ? [target] : [...this.sinks];
		for (const entry of this.ring) if (entry.seq > cursor) for (const sink of receivers) {
			const need = pushScopeFor(entry.type, entry.payload);
			if (need === void 0 || !sink.canReceive(need)) continue;
			sink.replay([entry]);
		}
		for (const sink of receivers) sink.replayDone();
		return true;
	}
	refreshLiveActivities() {
		try {
			this.pushOutlet?.liveActivityChanged?.(this.listSessions());
		} catch {}
	}
	record(type, payload, except) {
		if (this.disposed) return;
		if (type === "s2c.sessions.delta") this.refreshLiveActivities();
		if (type === "s2c.sessions.delta" || type.startsWith("s2c.pending.")) {
			const fingerprint = JSON.stringify([
				this.listSessions().map(({ id, title, status, lastActivityTs, todos, todoItems, pendingApproval, pendingQuestion }) => ({
					id,
					title,
					status,
					lastActivityTs,
					todos,
					todoItems,
					pendingApproval,
					pendingQuestion
				})),
				this.approvals.size,
				this.questions.size
			]);
			if (fingerprint !== this.widgetFingerprint) {
				this.widgetFingerprint = fingerprint;
				try {
					this.pushOutlet?.widgetChanged?.();
				} catch {}
			}
		}
		this.cursor += 1;
		const entry = {
			seq: this.cursor,
			type,
			payload
		};
		this.ring.push(entry);
		if (this.ring.length > this.historyBufferMax) this.ring.splice(0, this.ring.length - this.historyBufferMax);
		const need = pushScopeFor(type, payload);
		for (const sink of this.sinks) {
			if (need === void 0 || !sink.canReceive(need)) continue;
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
			case "host/schedule-changed":
				this.record("s2c.schedule.changed", {});
				break;
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
				if (frame.isSubagent === true) this.subagentSessionIds.add(sessionId);
				if (this.subagentSessionIds.has(sessionId)) break;
				this.noteActivity(sessionId, event);
				this.captureAssistantText(sessionId, event);
				const projection = projectEvent(sessionId, event);
				this.captureActivity(sessionId, event, projection?.data.tool);
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
				if (p.callId) this.loadApprovalArguments(p.approvalId, p.callId);
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
			const nextArchived = /* @__PURE__ */ new Map();
			for (const row of response.result.value.items ?? []) {
				if (isSubagentRow(row)) this.subagentSessionIds.add(row.sessionId);
				if (this.subagentSessionIds.has(row.sessionId)) continue;
				const summary = toSummary(row, this.approvals, this.questions, workspaceBySession.get(row.sessionId));
				if (this.archivedSessionIds.has(row.sessionId)) {
					nextArchived.set(row.sessionId, {
						...summary,
						archived: true
					});
					continue;
				}
				next.set(row.sessionId, summary);
			}
			for (const [id, calls] of this.activeTools) {
				const row = next.get(id);
				if (!row || row.status !== "running" && !row.pendingApproval && !row.pendingQuestion) this.activeTools.delete(id);
				else row.activity = [...calls.values()].at(-1) ?? null;
			}
			this.summaries = next;
			this.archivedSummaries = nextArchived;
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
	captureActivity(sessionId, event, tool) {
		const row = this.summaries.get(sessionId);
		if (!row) return;
		const data = event.data;
		if (event.type === "tool/call" && data?.callId) {
			const calls = this.activeTools.get(sessionId) ?? /* @__PURE__ */ new Map();
			const detail = [tool?.name, tool?.summary].filter(Boolean).join(": ");
			calls.set(data.callId, Array.from(detail).slice(0, 160).join(""));
			if (calls.size > 64) calls.delete(calls.keys().next().value);
			this.activeTools.set(sessionId, calls);
		} else if (event.type === "tool/result" && data?.callId) this.activeTools.get(sessionId)?.delete(data.callId);
		else if (event.type === "turn/start" || event.type === "turn/end") this.activeTools.delete(sessionId);
		else return;
		const activity = [...this.activeTools.get(sessionId)?.values() ?? []].at(-1) ?? null;
		if (row.activity === activity) return;
		row.activity = activity;
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
		} else if (key === "sessionStats" || key === "tokenUsage") {
			const patch = sanitizeUsageStatsPatch(key, value);
			if (!patch) return;
			row.stats = {
				...emptyUsageStats,
				...row.stats ?? {},
				...patch
			};
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
	* Archived rows from the last sessions.list, newest first. Served only on
	* demand so the live session list and its broadcast keep their shape for
	* clients that predate `c2s.sessions.archived`.
	*/
	listArchivedSessions() {
		return [...this.archivedSummaries.values()].sort((a, b) => b.lastActivityTs - a.lastActivityTs);
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
				...pending.toolArguments !== void 0 ? { toolArguments: pending.toolArguments } : {},
				riskLevel: riskOf(pending.toolName)
			})),
			questions: [...this.questions.entries()].map(([requestId, pending]) => ({
				requestId,
				sessionId: pending.sessionId,
				questions: Array.isArray(pending.questions) ? pending.questions : []
			}))
		};
	}
	/** Resolve only the exact invocation in this session; never guess from the latest tool. */
	async loadApprovalArguments(requestId, callId) {
		const pending = this.approvals.get(requestId);
		if (!pending) return;
		try {
			const response = await this.apiProxy.sessions.history({
				rpcId: randomUUID(),
				payload: {
					sessionId: pending.sessionId,
					maxMessages: 200
				}
			});
			if (this.disposed || this.approvals.get(requestId) !== pending || !response.result?.ok) return;
			const args = ((response.result.value.events ?? []).map((row) => row.event).find((event) => {
				const data = event.data;
				return event.type === "tool/call" && data?.callId === callId && data?.name === pending.toolName;
			})?.data)?.arguments;
			if (typeof args !== "string" || !args.trim()) return;
			pending.toolArguments = args;
			this.record("s2c.pending.approval", {
				requestId,
				sessionId: pending.sessionId,
				toolName: pending.toolName,
				summary: pending.reason,
				riskLevel: riskOf(pending.toolName),
				toolArguments: args
			});
		} catch {}
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
			const page = limitSessionPageMessages(projectHistory(result.events ?? []));
			const messages = page.messages;
			const oldestSeq = messages.length > 0 ? messages[0].seq : 0;
			sink.push("s2c.session.tail", {
				sessionId,
				messages,
				oldestSeq,
				hasMore: Boolean(result.hasMore) || page.dropped > 0
			});
			this.deriveTitleFallback(sessionId, messages);
			this.refreshProjections(sessionId);
			return true;
		} catch {
			return false;
		}
	}
	/**
	* Pull one session's projection baseline and fold every key
	* through applyProjection — unknown keys are ignored there, `null` means the
	* session no longer exists, and any failure degrades to a diagnostic: opening
	* a session must never fail because a baseline could not be read.
	*/
	async refreshProjections(sessionId) {
		try {
			const response = await this.apiProxy.sessions.projections({
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (this.disposed) return;
			const result = response.result;
			if (!result) return;
			if (!result.ok) {
				this.diagnostic("sessions.projections failed: " + result.error.code);
				return;
			}
			const baseline = result.value;
			if (baseline === null || baseline === void 0) return;
			for (const [key, value] of Object.entries(baseline.values ?? {})) this.applyProjection(sessionId, key, value);
		} catch (error) {
			this.diagnostic("sessions.projections threw: " + String(error?.message ?? error));
		}
	}
	async historyPage(sessionId, beforeSeq, limit) {
		try {
			const response = await this.apiProxy.sessions.history({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					beforeSeq,
					maxMessages: clampTail(limit)
				}
			});
			if (!response.result || !response.result.ok) return null;
			const result = response.result.value;
			const page = limitSessionPageMessages(projectHistory(result.events ?? []).filter((message) => message.seq < beforeSeq));
			return {
				sessionId,
				messages: page.messages,
				hasMore: page.messages.length > 0 && (Boolean(result.hasMore) || page.dropped > 0)
			};
		} catch {
			return null;
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
			code: "E_UNSUPPORTED",
			message: "model catalog unavailable on this host version"
		};
		try {
			const response = await models.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "model catalog returned no result"
			};
			if (!response.result.ok) return wireErrorOf("model", response.result.error);
			return {
				ok: true,
				value: projectSessionModels(response.result.value)
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async selectSessionModel(sessionId, selection) {
		const selectModel = this.apiProxy.sessions.selectModel;
		if (typeof selectModel !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
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
				code: "E_INTERNAL",
				message: "model selection returned no result"
			};
			if (!response.result.ok) return wireErrorOf("model", response.result.error);
			return {
				ok: true,
				value: { ...response.result.value.selected }
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async renameSession(sessionId, title) {
		const rename = this.apiProxy.sessions.rename;
		if (typeof rename !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
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
				code: "E_INTERNAL",
				message: "session rename returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
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
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async archiveSession(sessionId) {
		const archive = this.apiProxy.workspace?.archiveSession;
		if (typeof archive !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "session archive unavailable on this host version"
		};
		try {
			const response = await archive.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "session archive returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
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
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async unarchiveSession(sessionId) {
		const unarchive = this.apiProxy.workspace?.unarchiveSession;
		if (typeof unarchive !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "session restore unavailable on this host version"
		};
		try {
			const response = await unarchive.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "session restore returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
			this.archivedSessionIds = new Set((response.result.value.archivedSessionIds ?? []).map(String));
			await this.refreshSummaries();
			return {
				ok: true,
				value: true
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async cancelSession(sessionId) {
		const cancel = this.apiProxy.sessions.cancel;
		if (typeof cancel !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "session cancel unavailable on this host version"
		};
		try {
			const response = await cancel.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "session cancel returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
			return {
				ok: true,
				value: true
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async listWorkspaces() {
		const list = this.apiProxy.workspace?.list;
		if (typeof list !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "workspace list unavailable on this host version"
		};
		try {
			const response = await list.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: {}
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "workspace list returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
			return {
				ok: true,
				value: (response.result.value.items ?? []).map(projectWorkspace)
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async createWorkspace(path) {
		const create = this.apiProxy.workspace?.create;
		if (typeof create !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "workspace create unavailable on this host version"
		};
		try {
			const response = await create.call(this.apiProxy.workspace, {
				rpcId: randomUUID(),
				payload: { path }
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "workspace create returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
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
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async listDirectory(path) {
		const list = this.apiProxy.host?.listDirectory;
		if (typeof list !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "directory browsing unavailable on this host version"
		};
		try {
			const response = await list.call(this.apiProxy.host, {
				rpcId: randomUUID(),
				payload: path && path.trim().length > 0 ? { path } : {}
			}, this.abort.signal);
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "directory list returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
			return {
				ok: true,
				value: response.result.value
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async pickDirectory() {
		const pick = this.apiProxy.host?.pickDirectory;
		if (typeof pick !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "native directory picker unavailable on this host version"
		};
		try {
			const response = await pick.call(this.apiProxy.host, {
				rpcId: randomUUID(),
				payload: {}
			}, this.abort.signal);
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "directory picker returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
			return {
				ok: true,
				value: response.result.value.path
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
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
	async forkSession(deviceId, payload) {
		const fork = this.apiProxy.sessions.fork;
		if (typeof fork !== "function") return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "session fork unavailable on this host version"
		};
		if (!this.summaries.has(payload.sessionId)) return {
			ok: false,
			code: "E_NOT_FOUND",
			message: "session not found"
		};
		if (this.archivedSessionIds.has(payload.sessionId) || this.subagentSessionIds.has(payload.sessionId)) return {
			ok: false,
			code: "E_PROTOCOL",
			message: "archived or subagent sessions cannot be forked"
		};
		const result = await this.forkMutations.dispatch(deviceId, payload.clientRequestId, {
			sessionId: payload.sessionId,
			...payload.atSeq !== void 0 ? { atSeq: payload.atSeq } : {}
		}, async () => {
			const response = await fork.call(this.apiProxy.sessions, {
				rpcId: randomUUID(),
				payload: {
					sessionId: payload.sessionId,
					...payload.atSeq !== void 0 ? { atSeq: payload.atSeq } : {}
				}
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "session fork returned no result"
			};
			if (!response.result.ok) return wireErrorOf("schedule", response.result.error);
			return {
				ok: true,
				value: { sessionId: response.result.value.sessionId }
			};
		});
		if (result.ok) {
			await this.refreshSummaries();
			return {
				ok: true,
				value: result.value,
				replayed: result.replayed
			};
		}
		return {
			ok: false,
			code: result.code,
			message: result.message ?? result.code,
			replayed: result.replayed
		};
	}
	async listSchedules(sessionId) {
		const schedule = this.apiProxy.schedule;
		if (schedule === void 0) return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "schedules unavailable on this host version"
		};
		try {
			const response = await schedule.list({
				rpcId: randomUUID(),
				payload: { sessionId }
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "schedule list returned no result"
			};
			if (!response.result.ok) return wireErrorOf("schedule", response.result.error);
			return {
				ok: true,
				value: response.result.value.tasks
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async scheduleHistory(sessionId, id, limit, before) {
		const schedule = this.apiProxy.schedule;
		if (schedule === void 0) return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "schedules unavailable on this host version"
		};
		try {
			const response = await schedule.history({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					id,
					limit,
					...before !== void 0 ? { before } : {}
				}
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "schedule history returned no result"
			};
			if (!response.result.ok) return wireErrorOf("schedule", response.result.error);
			return {
				ok: true,
				value: response.result.value.history
			};
		} catch (error) {
			return {
				ok: false,
				code: "E_INTERNAL",
				message: String(error)
			};
		}
	}
	async createSchedule(deviceId, payload) {
		const schedule = this.apiProxy.schedule;
		if (schedule === void 0) return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "schedules unavailable on this host version"
		};
		const { clientRequestId, sessionId, ...request } = payload;
		const result = await this.scheduleMutations.dispatch(deviceId, clientRequestId, {
			sessionId,
			request
		}, async () => {
			const response = await schedule.create({
				rpcId: randomUUID(),
				payload: {
					sessionId,
					...request
				}
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "schedule create returned no result"
			};
			if (!response.result.ok) return wireErrorOf("schedule", response.result.error);
			return {
				ok: true,
				value: response.result.value
			};
		});
		if (result.ok) {
			this.record("s2c.schedule.changed", {});
			return {
				ok: true,
				value: result.value,
				replayed: result.replayed
			};
		}
		return {
			ok: false,
			code: result.code,
			message: result.message ?? result.code,
			replayed: result.replayed
		};
	}
	async updateSchedule(deviceId, payload) {
		const schedule = this.apiProxy.schedule;
		if (schedule === void 0) return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "schedules unavailable on this host version"
		};
		const { clientRequestId, ...request } = payload;
		const result = await this.scheduleMutations.dispatch(deviceId, clientRequestId, request, async () => {
			const response = await schedule.update({
				rpcId: randomUUID(),
				payload: request
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "schedule update returned no result"
			};
			if (!response.result.ok) return wireErrorOf("schedule", response.result.error);
			const value = response.result.value;
			if (value.updated !== true || value.record === void 0) return {
				ok: false,
				code: wireCodeFor("schedule", value.code),
				message: value.code ?? "schedule update rejected"
			};
			return {
				ok: true,
				value: value.record
			};
		});
		if (result.ok) {
			this.record("s2c.schedule.changed", {});
			return {
				ok: true,
				value: result.value,
				replayed: result.replayed
			};
		}
		return {
			ok: false,
			code: result.code,
			message: result.message ?? result.code,
			replayed: result.replayed
		};
	}
	async deleteSchedule(deviceId, payload) {
		const schedule = this.apiProxy.schedule;
		if (schedule === void 0) return {
			ok: false,
			code: "E_UNSUPPORTED",
			message: "schedules unavailable on this host version"
		};
		const result = await this.scheduleMutations.dispatch(deviceId, payload.clientRequestId, {
			sessionId: payload.sessionId,
			id: payload.id
		}, async () => {
			const response = await schedule.delete({
				rpcId: randomUUID(),
				payload: {
					sessionId: payload.sessionId,
					id: payload.id
				}
			});
			if (!response.result) return {
				ok: false,
				code: "E_INTERNAL",
				message: "schedule delete returned no result"
			};
			if (!response.result.ok) return wireErrorOf("schedule", response.result.error);
			if (response.result.value.deleted !== true) return {
				ok: false,
				code: "E_NOT_FOUND",
				message: response.result.value.code ?? "schedule not found"
			};
			return {
				ok: true,
				value: {
					id: response.result.value.id,
					deleted: true
				}
			};
		});
		if (result.ok) {
			this.record("s2c.schedule.changed", {});
			return {
				ok: true,
				value: result.value,
				replayed: result.replayed
			};
		}
		return {
			ok: false,
			code: result.code,
			message: result.message ?? result.code,
			replayed: result.replayed
		};
	}
	async sendPrompt(sessionId, text, images = [], documents = []) {
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
			for (const document of documents) content.push({
				type: "text",
				text: documentPromptBlock(document)
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
				code: "E_INTERNAL",
				message: "prompt returned no result"
			};
			if (!response.result.ok) return wireErrorOf("session", response.result.error);
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
				code: "E_INTERNAL",
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
/** Zero-value stats snapshot used as the merge base for partial patches. */
const emptyUsageStats = {
	turns: 0,
	steps: 0,
	llmMs: 0,
	toolMs: 0,
	ttftMs: 0,
	ttftSteps: 0,
	decodeMs: 0,
	decodeTokens: 0,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0
};
/** Coerce one host counter to a non-negative integer; junk becomes 0. */
function usageCounter(value) {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n < 0) return 0;
	return Math.floor(n);
}
const SESSION_STATS_COUNTERS = [
	"turns",
	"steps",
	"llmMs",
	"toolMs",
	"ttftMs",
	"ttftSteps",
	"decodeMs",
	"decodeTokens"
];
const TOKEN_USAGE_COUNTERS = [
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens"
];
/** Sanitize one `sessionStats` / `tokenUsage` projection value into the wire
* stats fields; undefined when the payload carries nothing readable. Host
* field names differ between the two projections (tokenUsage reports
* `uncachedInputTokens`, the wire mirrors it as `inputTokens`). */
function sanitizeUsageStatsPatch(key, value) {
	if (!value || typeof value !== "object") return void 0;
	const raw = value;
	const patch = {};
	if (key === "sessionStats") {
		for (const field of SESSION_STATS_COUNTERS) if (field in raw) patch[field] = usageCounter(raw[field]);
	} else {
		if ("uncachedInputTokens" in raw) patch.inputTokens = usageCounter(raw.uncachedInputTokens);
		for (const field of TOKEN_USAGE_COUNTERS) if (field in raw) patch[field] = usageCounter(raw[field]);
	}
	return Object.keys(patch).length > 0 ? patch : void 0;
}
/** Combine one session's `sessionStats` + `tokenUsage` projection values into
* a complete wire stats object; undefined when neither carries anything. */
function usageStatsOf(sessionStats, tokenUsage) {
	const patches = [sanitizeUsageStatsPatch("sessionStats", sessionStats), sanitizeUsageStatsPatch("tokenUsage", tokenUsage)].filter((patch) => patch !== void 0);
	if (patches.length === 0) return void 0;
	return Object.assign({}, emptyUsageStats, ...patches);
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
	const stats = usageStatsOf(values.sessionStats, values.tokenUsage);
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
		...stats ? { stats } : {},
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
/** 把 Host 的模型目录投影成 wire 形状：字段全部收敛为字符串，缺省不补位。 */
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
//#endregion
//#region src/dsh-remote-interactions.ts
/**
* Resident DSH Remote Events client for phone interactions.
*
* The Host-side `approval/request` and `user-questions/request` events are
* owned once by DSH API Remotes. API Gateway then fans each pending waterfall
* out to every connected Client and settles the first result. DeepPilot joins
* that official Client plane in-process instead of registering a competing
* Host waterfall listener or replacing the official Web composer.
*/
/** The rc.2 Client sends relative RPC paths to its in-process carrier. */
function inProcessRemoteRequest(input, init) {
	return new Request(new URL(input, "http://localhost/"), init);
}
let clientFaces;
/**
* Load DSH's browser-distributed Client faces into a tiny Host-side module
* table. Published `lib/client.js` files register with `window.__ModuleLoader__`
* rather than exporting ESM values, so a normal Node import cannot consume
* them. The shim runs only while the three official bundles register; their
* apply functions then operate against a non-browser Cordis Context.
*/
function pluginModule(value, specifier) {
	if (typeof value !== "object" || value === null) throw new Error(`${specifier} Client bundle returned no exports`);
	if (typeof value.apply !== "function") throw new Error(`${specifier} has no Client apply() export`);
	return value;
}
async function loadClientFaces() {
	clientFaces ??= (async () => {
		const modules = /* @__PURE__ */ new Map([["@deepseek-ai/cordis", Cordis]]);
		const loaderGlobal = globalThis;
		const previousWindow = loaderGlobal.window;
		loaderGlobal.window = { __ModuleLoader__: { load: (definition) => {
			const exports = definition.factory((id) => {
				if (!modules.has(id)) throw new Error(`resident DSH Client cannot resolve ${JSON.stringify(id)}`);
				return modules.get(id);
			});
			modules.set(definition.id, exports);
		} } };
		try {
			for (const specifier of [
				"@deepseek-ai/dsh-typert-registry/client",
				"@deepseek-ai/dsh-client-connection/client",
				"@deepseek-ai/dsh-api-gateway/client"
			]) await import(specifier);
		} finally {
			if (previousWindow === void 0) delete loaderGlobal.window;
			else loaderGlobal.window = previousWindow;
		}
		return {
			typert: pluginModule(modules.get("@deepseek-ai/dsh-typert-registry"), "@deepseek-ai/dsh-typert-registry/client"),
			connection: pluginModule(modules.get("@deepseek-ai/dsh-client-connection"), "@deepseek-ai/dsh-client-connection/client"),
			gateway: pluginModule(modules.get("@deepseek-ai/dsh-api-gateway"), "@deepseek-ai/dsh-api-gateway/client")
		};
	})();
	return clientFaces;
}
const agentScopeKey = Symbol("deeppilot.dsh-client.agent-scope");
function scopeOf(ctx) {
	return ctx[agentScopeKey];
}
function createAgentScope(ctx, identity) {
	return ctx.plugin(function deeppilotAgentScope() {}).ctx.extend({
		[agentScopeKey]: identity,
		[Context.filter](listenerCtx) {
			const listenerIdentity = scopeOf(listenerCtx);
			return listenerIdentity === void 0 || listenerIdentity === identity;
		}
	});
}
function inProcessStream(gateway, endpoint, payload, signal) {
	return (async function* () {
		yield* await gateway.wireStream.open(endpoint, payload, void 0, void 0, signal);
	})();
}
/**
* Start one headless official DSH Client backed by the Host's in-process
* Connection and Gateway carriers.
*
* The returned disposer tears down the Remote Events generation, all pending
* listeners, and every lazily minted Agent scope.
*/
async function startDshRemoteInteractions(hostCtx, handlers) {
	const connection = hostCtx.get("connection");
	const gateway = hostCtx.get("typertGateway");
	if (connection === void 0) throw new Error("DSH Host connection is unavailable");
	if (gateway === void 0) throw new Error("DSH typertGateway is unavailable");
	const faces = await loadClientFaces();
	const client = new Context();
	const fetchHandler = connection.createSharedFetchHandler("/api");
	const transport = {
		fetch: (input, init) => fetchHandler.fetch(inProcessRemoteRequest(input, init)),
		openStream: (endpoint, payload, signal) => inProcessStream(gateway, endpoint, payload, signal),
		ownsHost: true
	};
	try {
		faces.typert.apply(client);
		const transportGlobal = globalThis;
		const previousTransport = transportGlobal.__DSH_TRANSPORT__;
		transportGlobal.__DSH_TRANSPORT__ = transport;
		try {
			faces.connection.apply(client);
		} finally {
			if (previousTransport === void 0) delete transportGlobal.__DSH_TRANSPORT__;
			else transportGlobal.__DSH_TRANSPORT__ = previousTransport;
		}
		const typert = client.get("typert");
		if (typert === void 0) throw new Error("resident DSH Client typert service was not installed");
		const scopes = /* @__PURE__ */ new Map();
		typert.contexts.registerClient("agent", {
			identity: (candidate) => scopeOf(candidate),
			resolve: (identity) => {
				let scope = scopes.get(identity);
				if (scope === void 0) {
					scope = createAgentScope(client, identity);
					scopes.set(identity, scope);
				}
				return scope;
			}
		});
		faces.gateway.apply(client);
		const remote = client.get("remote");
		if (remote === void 0) throw new Error("resident DSH Client remote service was not installed");
		remote.$on("approval/request", function(request, next) {
			return handlers.approval(scopeOf(this) ?? "", request, next);
		});
		remote.$on("user-questions/request", function(request, next) {
			return handlers.question(scopeOf(this) ?? "", request, next);
		});
		return async () => {
			await client.fiber.dispose();
		};
	} catch (error) {
		await client.fiber.dispose();
		throw error;
	}
}
//#endregion
//#region src/dsh-api-proxy.ts
/**
* Adapter for the DSH rc.2 controller API.
*
* DeepPilot's phone protocol deliberately speaks one stable in-process
* `apiProxy` vocabulary. This adapter maps it to the current public
* Session/Workspace controllers and Gateway-backed Remote Events, keeping
* the phone protocol isolated from the Host API.
*/
/** Direct-controller adapter with the shape HostBridge consumes. */
var DshApiProxy = class {
	ctx;
	session;
	workspaceController;
	scheduleController;
	scheduleApi;
	directoryPicker;
	interactions = /* @__PURE__ */ new Map();
	shouldSurfaceInteraction;
	constructor(ctx, options = {}) {
		this.ctx = ctx;
		const session = ctx.get("sessionController");
		if (session === void 0) throw new Error("DSH sessionController is unavailable");
		this.session = session;
		this.workspaceController = ctx.get("workspaceController");
		if (this.workspaceController === void 0) delete this.workspace?.unarchiveSession;
		this.directoryPicker = ctx.get("directoryPickerController");
		this.shouldSurfaceInteraction = options.shouldSurfaceInteraction ?? (() => true);
		this.resolveSchedule();
	}
	/**
	* Resolve the optional Schedule service lazily, on every read.
	*
	* The bridge is built from a `ctx.inject` on sessionController / connection
	* / typertGateway, and `schedule` is deliberately NOT in that list: it only
	* exists when the user enables the optional Automation tasks bundle. On a
	* DSH 0.2.0 host those three services become ready well before
	* ScheduleService finishes its own async init, so a value captured here in
	* the constructor stayed `undefined` for the bridge's whole lifetime and
	* welcome advertised `schedules=false` even with the bundle mounted.
	*
	* Once resolved the controller is kept: services are not torn down and
	* rebuilt underneath a live bridge, so re-resolving per call would be pure
	* overhead.
	*/
	resolveSchedule() {
		if (this.scheduleController !== void 0) return;
		const controller = this.ctx.get("schedule");
		if (controller === void 0) return;
		this.scheduleController = controller;
		this.scheduleApi = this.createScheduleApi(controller);
	}
	get schedule() {
		this.resolveSchedule();
		return this.scheduleApi;
	}
	createScheduleApi(controller) {
		return {
			list: async (request) => this.call(async () => ({
				sessionId: request.payload.sessionId,
				tasks: (await controller.list({ sessionId: request.payload.sessionId })).map(toScheduleTask)
			})),
			history: async (request) => this.call(async () => {
				const value = await controller.history({
					sessionId: request.payload.sessionId,
					id: request.payload.id,
					limit: request.payload.limit,
					...request.payload.before !== void 0 ? { before: request.payload.before } : {}
				});
				if (typeof value.code === "string") throw Object.assign(new Error(String(value.code)), { code: value.code });
				return {
					sessionId: request.payload.sessionId,
					history: toScheduleHistory(value)
				};
			}),
			create: async (request) => this.call(async () => {
				const { sessionId, ...createRequest } = request.payload;
				return toScheduleTask(await controller.create(sessionId, createRequest));
			}),
			update: async (request) => this.call(async () => {
				const payload = request.payload;
				const result = await controller.update({
					...payload,
					expected: toScheduleExpected(payload.expected)
				});
				return {
					id: String(result.id ?? payload.id),
					updated: result.updated === true,
					...result.record !== void 0 ? { record: toScheduleTask(result.record) } : {},
					...typeof result.code === "string" ? { code: result.code } : {}
				};
			}),
			delete: async (request) => this.call(async () => {
				const result = await controller.delete({
					sessionId: request.payload.sessionId,
					id: request.payload.id
				});
				return {
					id: String(result.id),
					deleted: result.deleted === true,
					...result.code !== void 0 ? { code: String(result.code) } : {}
				};
			})
		};
	}
	/**
	* Decide whether this Gateway Client can surface a phone card. The decision
	* fails open to false so a broken device registry delegates this delivery
	* while the official Web Client remains able to answer.
	*/
	canSurfaceInteraction(kind) {
		try {
			return this.shouldSurfaceInteraction(kind);
		} catch {
			return false;
		}
	}
	sessions = {
		list: async () => this.call(async () => {
			return { items: (await this.session.list({}, new AbortController().signal)).items.map(toPhoneSessionRow) };
		}),
		history: async (request) => this.call(async () => {
			const sessionId = request.payload.sessionId;
			let inspected;
			try {
				inspected = await this.session.inspect(sessionId);
			} catch (error) {
				console.warn(`[deeppilot] session history unavailable for ${JSON.stringify(sessionId)}: ${toError(error).code}: ${toError(error).message}`);
				throw error;
			}
			const before = request.payload?.beforeSeq;
			const limit = Math.max(1, request.payload?.maxMessages ?? 100);
			const source = inspected.events.filter((event) => typeof event === "object" && event !== null && typeof event.type === "string" && typeof event.seq === "number").filter((event) => before === void 0 || event.seq < before);
			let end = source.length;
			let events = [];
			while (end > 0 && projectHistory(events).length < limit) {
				const start = Math.max(0, end - limit);
				events = [...source.slice(start, end).map((event) => ({ event })), ...events];
				end = start;
			}
			let trimmed = false;
			while (events.length > 0 && projectHistory(events).length > limit) {
				events = events.slice(1);
				trimmed = true;
			}
			return {
				events,
				hasMore: end > 0 || trimmed
			};
		}),
		prompt: async (request) => this.call(() => this.session.prompt({
			...request.payload,
			requestId: request.rpcId ?? randomUUID()
		}, new AbortController().signal)),
		create: async (request) => this.call(() => this.session.create(request.payload ?? {})),
		fork: async (request) => this.call(() => this.session.fork(request.payload)),
		models: async (request) => this.call(async () => projectModels(await this.session.modelCatalog(), String(request.payload?.sessionId ?? ""), await this.session.list({}, new AbortController().signal))),
		selectModel: async (request) => this.call(() => this.session.selectModel(request.payload ?? {})),
		rename: async (request) => this.call(() => this.session.rename(request.payload)),
		cancel: async (request) => this.call(() => this.session.cancel(request.payload)),
		attachment: async (request) => this.call(() => this.session.attachment(request.payload)),
		projections: async (request) => this.call(() => this.session.projections(request.payload))
	};
	workspace = {
		list: async () => this.call(async () => {
			if (this.workspaceController === void 0) throw unavailable("workspace controller unavailable");
			const baseline = await readWorkspaceBaseline(this.workspaceController);
			return {
				items: baseline.items.map(toWorkspaceView),
				archivedSessionIds: baseline.archivedSessionIds.map(String)
			};
		}),
		create: async (request) => this.call(async () => {
			if (this.workspaceController === void 0) throw unavailable("workspace controller unavailable");
			const value = await this.workspaceController.create(request.payload);
			return {
				workspace: toWorkspaceView(value.workspace),
				created: value.created === true
			};
		}),
		archiveSession: async (request) => this.call(async () => {
			if (this.workspaceController === void 0) throw unavailable("workspace controller unavailable");
			return { archivedSessionIds: [...(await this.workspaceController.archiveSession(request.payload)).archivedSessionIds] };
		}),
		unarchiveSession: async (request) => this.call(async () => {
			if (this.workspaceController === void 0) throw unavailable("workspace controller unavailable");
			return { archivedSessionIds: [...(await this.workspaceController.unarchiveSession(request.payload)).archivedSessionIds] };
		})
	};
	host = {
		listDirectory: async (request, signal) => this.call(async () => {
			if (this.directoryPicker === void 0) throw unavailable("directory picker unavailable");
			return await this.directoryPicker.list(request.payload?.path, signal ?? new AbortController().signal);
		}),
		pickDirectory: async (_request, signal) => this.call(async () => {
			if (this.directoryPicker === void 0) throw unavailable("directory picker unavailable");
			return { path: await this.directoryPicker.pick(signal ?? new AbortController().signal) };
		})
	};
	events = {
		mux: (_request, signal) => this.mux(signal),
		host: (_request, signal) => this.hostEvents(signal)
	};
	async respond(message) {
		const pending = this.interactions.get(message.rpcId);
		if (pending === void 0) return {
			accepted: false,
			reason: "not-pending"
		};
		if (!message.result.ok) return {
			accepted: false,
			reason: "bad-response"
		};
		this.interactions.delete(message.rpcId);
		pending.resolve(pending.map(message.result.value));
		return { accepted: true };
	}
	async *mux(signal) {
		const queue = new AsyncFrameQueue(signal);
		const offEvent = this.ctx.on("session/event", ((session, event) => {
			queue.push({
				type: "session/event",
				sessionId: String(session.id),
				isSubagent: session.header?.origin === "subagent",
				event
			});
		}), { global: true });
		const offProjection = this.ctx.get("sessionProjections")?.onChanged?.((session, key, value) => {
			queue.push({
				type: "session/projection",
				sessionId: String(session.id),
				key,
				value
			});
		});
		let disposeInteractions;
		try {
			disposeInteractions = await startDshRemoteInteractions(this.ctx, {
				approval: (sessionId, request, next) => this.answerApproval(queue, sessionId, request, next),
				question: (sessionId, request, next) => this.answerQuestion(queue, sessionId, request, next)
			});
		} catch (error) {
			console.warn(`[deeppilot] DSH Remote interaction client unavailable: ${toError(error).message}`);
		}
		try {
			yield* queue.iterate();
		} finally {
			offEvent();
			offProjection?.();
			await disposeInteractions?.();
			queue.close();
		}
	}
	answerApproval(queue, sessionId, request, next) {
		if (!this.canSurfaceInteraction("approval")) return next();
		const rpcId = randomUUID();
		const response = deferred();
		const abort = () => response.resolve("cancelled");
		request.signal?.addEventListener("abort", abort, { once: true });
		this.interactions.set(rpcId, {
			resolve: response.resolve,
			map: (value) => {
				const outcome = value?.outcome;
				return outcome === "allowed-once" || outcome === "rejected" ? outcome : "unavailable";
			}
		});
		queue.push({
			type: "approval/requested",
			rpcId,
			sessionId,
			approvalId: rpcId,
			toolName: String(request.toolName ?? "tool"),
			reason: String(request.reason ?? ""),
			...request.callId ? { callId: request.callId } : {}
		});
		return response.promise.finally(() => {
			request.signal?.removeEventListener("abort", abort);
			this.interactions.delete(rpcId);
			queue.push({
				type: "approval/resolved",
				approvalId: rpcId
			});
		});
	}
	answerQuestion(queue, sessionId, request, next) {
		if (!this.canSurfaceInteraction("question")) return next();
		const rpcId = randomUUID();
		const response = deferred();
		const abort = () => response.reject(/* @__PURE__ */ new Error("question cancelled"));
		request.signal?.addEventListener("abort", abort, { once: true });
		this.interactions.set(rpcId, {
			resolve: response.resolve,
			map: (value) => value?.answer ?? value
		});
		queue.push({
			type: "question/requested",
			rpcId,
			sessionId,
			questions: request.questions ?? []
		});
		return response.promise.finally(() => {
			request.signal?.removeEventListener("abort", abort);
			this.interactions.delete(rpcId);
			queue.push({
				type: "question/resolved",
				questionRpcId: rpcId
			});
		});
	}
	async *hostEvents(signal) {
		const queue = new AsyncFrameQueue(signal);
		const listen = (event, type, project) => this.ctx.on(event, ((...args) => queue.push({
			type,
			...project?.(...args) ?? {}
		})), { global: true });
		const off = [
			listen("api-session/added", "host/session-added"),
			listen("api-session/removed", "host/session-removed"),
			listen("api-session/status", "host/session-status", (sessionId, running) => ({
				sessionId: String(sessionId),
				running: running === true
			})),
			listen("api-session/activity", "host/session-added"),
			listen("schedule/changed", "host/schedule-changed")
		];
		const workspaceAbort = new AbortController();
		const stop = () => workspaceAbort.abort();
		signal.addEventListener("abort", stop, { once: true });
		this.workspaceController === void 0 || (async () => {
			try {
				for await (const frame of this.workspaceController.follow(workspaceAbort.signal)) if (frame.type === "archived") queue.push({
					type: "host/archived-sessions-changed",
					archivedSessionIds: frame.archivedSessionIds
				});
				else if (frame.type !== "baseline") queue.push({ type: "host/workspace-changed" });
			} catch {}
		})();
		try {
			yield* queue.iterate();
		} finally {
			for (const dispose of off) dispose();
			signal.removeEventListener("abort", stop);
			workspaceAbort.abort();
			queue.close();
		}
	}
	async call(invoke) {
		try {
			return { result: {
				ok: true,
				value: await invoke()
			} };
		} catch (error) {
			return { result: {
				ok: false,
				error: toError(error)
			} };
		}
	}
};
function deferred() {
	let resolve;
	let reject;
	return {
		promise: new Promise((ok, fail) => {
			resolve = ok;
			reject = fail;
		}),
		resolve,
		reject
	};
}
var AsyncFrameQueue = class {
	frames = [];
	wake;
	closed = false;
	constructor(signal) {
		signal.addEventListener("abort", () => this.close(), { once: true });
	}
	push(frame) {
		if (!this.closed) {
			this.frames.push(frame);
			this.wake?.();
		}
	}
	close() {
		if (!this.closed) {
			this.closed = true;
			this.wake?.();
		}
	}
	async *iterate() {
		while (!this.closed) {
			const frame = this.frames.shift();
			if (frame !== void 0) {
				yield frame;
				continue;
			}
			await new Promise((resolve) => {
				this.wake = resolve;
			});
			this.wake = void 0;
		}
	}
};
function unavailable(message) {
	return Object.assign(new Error(message), { code: "directory-picker-unavailable" });
}
function toError(error) {
	const value = error;
	return {
		code: typeof value?.code === "string" ? value.code : "internal",
		message: typeof value?.message === "string" ? value.message : String(error)
	};
}
function toPhoneSessionRow(value) {
	const row = value;
	return {
		sessionId: String(row.sessionId ?? ""),
		updatedAt: Number(row.updatedAt ?? Date.now()),
		running: row.running === true,
		...row.blank === true ? { blank: true } : {},
		...typeof row.cwd === "string" ? { cwd: row.cwd } : {},
		...typeof row.origin === "string" ? { origin: row.origin } : {},
		...typeof row.parentSessionId === "string" ? { parentSessionId: row.parentSessionId } : {},
		...row.projections && typeof row.projections === "object" ? { projections: row.projections } : {}
	};
}
function toWorkspaceView(value) {
	const row = value;
	return {
		workspaceId: String(row.workspaceId ?? ""),
		title: String(row.title ?? ""),
		path: String(row.path ?? ""),
		sessionIds: Array.isArray(row.sessionIds) ? row.sessionIds.map(String) : []
	};
}
function toScheduleExpected(value) {
	const { state: _state, deliveryMode: _deliveryMode, ...record } = value !== null && typeof value === "object" ? value : {};
	return record;
}
function toScheduleTask(value) {
	const row = value;
	const kind = [
		"after",
		"at",
		"every",
		"daily",
		"weekly",
		"cron"
	].includes(String(row.kind)) ? String(row.kind) : "at";
	const optionalNumber = (key) => typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] : void 0;
	return {
		id: String(row.id ?? ""),
		kind,
		title: String(row.title ?? ""),
		prompt: String(row.prompt ?? ""),
		scheduledAt: String(row.scheduledAt ?? ""),
		state: row.state === "overdue" ? "overdue" : "scheduled",
		deliveryMode: "host",
		...optionalNumber("afterSeconds") !== void 0 ? { afterSeconds: optionalNumber("afterSeconds") } : {},
		...optionalNumber("everySeconds") !== void 0 ? { everySeconds: optionalNumber("everySeconds") } : {},
		...typeof row.time === "string" ? { time: row.time } : {},
		...typeof row.timeZone === "string" ? { timeZone: row.timeZone } : {},
		...Array.isArray(row.weekdays) ? { weekdays: row.weekdays.filter((day) => typeof day === "number") } : {},
		...typeof row.expression === "string" ? { expression: row.expression } : {}
	};
}
function toScheduleHistory(value) {
	const row = value;
	const records = Array.isArray(row.records) ? row.records : [];
	return {
		id: String(row.id ?? ""),
		records: records.map((entry) => {
			const item = entry;
			return {
				scheduledAt: String(item.scheduledAt ?? ""),
				deliveredAt: String(item.deliveredAt ?? ""),
				messageId: String(item.messageId ?? ""),
				...typeof item.prompt === "string" ? { prompt: item.prompt } : {}
			};
		}),
		earlierRecordsUnavailable: row.earlierRecordsUnavailable === true,
		...typeof row.earlierRecordsPruned === "boolean" ? { earlierRecordsPruned: row.earlierRecordsPruned } : {},
		retention: {
			days: Number(row.retention?.days ?? 0),
			records: Number(row.retention?.records ?? 0)
		},
		...typeof row.nextBefore === "string" ? { nextBefore: row.nextBefore } : {}
	};
}
async function readWorkspaceBaseline(controller) {
	const abort = new AbortController();
	const iterator = controller.follow(abort.signal)[Symbol.asyncIterator]();
	try {
		const baseline = (await iterator.next()).value;
		if (baseline?.type !== "baseline") throw new Error("workspace follow did not provide a baseline");
		return {
			items: (baseline.value?.items ?? []).map(toWorkspaceView),
			archivedSessionIds: (baseline.value?.archivedSessionIds ?? []).map(String)
		};
	} finally {
		abort.abort();
		await iterator.return?.();
	}
}
async function projectModels(catalog, sessionId, list) {
	const value = catalog;
	const selected = (list.items.map(toPhoneSessionRow).find((item) => item.sessionId === sessionId)?.projections?.values?.modelSelection)?.next;
	return {
		current: {
			provider: String(selected?.provider ?? value.default?.provider ?? ""),
			model: String(selected?.model ?? value.default?.model ?? ""),
			...typeof selected?.reasoningEffort === "string" ? { reasoningEffort: selected.reasoningEffort } : {}
		},
		routable: true,
		groups: Array.isArray(value.groups) ? value.groups : [],
		failures: Array.isArray(value.failures) ? value.failures : []
	};
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
	pairingStarter;
	deviceRevoker;
	deviceRenamer;
	deviceScopeUpdater;
	relayTester;
	pushTester;
	constructor(ctx, snapshot, pairingStarter, deviceRevoker, deviceRenamer, deviceScopeUpdater, relayTester, pushTester) {
		super(ctx, "deeppilotReport", { namespace: "deeppilot" });
		this.snapshot = snapshot;
		this.pairingStarter = pairingStarter;
		this.deviceRevoker = deviceRevoker;
		this.deviceRenamer = deviceRenamer;
		this.deviceScopeUpdater = deviceScopeUpdater;
		this.relayTester = relayTester;
		this.pushTester = pushTester;
	}
	async report() {
		return this.snapshot();
	}
	async beginPairing() {
		return this.pairingStarter();
	}
	async revokeDevice(deviceId) {
		return this.deviceRevoker(deviceId);
	}
	async setDeviceName(deviceId, customName) {
		return this.deviceRenamer(deviceId, customName);
	}
	async setDeviceScopes(deviceId, scopes) {
		return this.deviceScopeUpdater(deviceId, scopes);
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
const BEGIN_PAIRING_ENDPOINT = "deeppilot/beginPairing";
const REVOKE_DEVICE_ENDPOINT = "deeppilot/revokeDevice";
const SET_DEVICE_NAME_ENDPOINT = "deeppilot/setDeviceName";
const SET_DEVICE_SCOPES_ENDPOINT = "deeppilot/setDeviceScopes";
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
	const customName = s.customName;
	if (customName !== void 0 && (typeof customName !== "string" || customName.length === 0 || customName.length > 64 || customName.trim() !== customName || /[\u0000-\u001f\u007f-\u009f]/u.test(customName))) reject("device.customName");
	return {
		deviceId: str(s, "deviceId", "device.deviceId"),
		deviceName: str(s, "deviceName", "device.deviceName"),
		...typeof customName === "string" ? { customName } : {},
		appVersion: str(s, "appVersion", "device.appVersion"),
		firstSeenTs: int(s, "firstSeenTs", "device.firstSeenTs"),
		lastSeenTs: int(s, "lastSeenTs", "device.lastSeenTs"),
		fingerprint: str(s, "fingerprint", "device.fingerprint"),
		scopes: normalizeDeviceScopes(s.scopes),
		...s.revokedAt !== void 0 ? { revokedAt: int(s, "revokedAt", "device.revokedAt") } : {},
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
function parseLocal(value) {
	const s = rec(value, "local");
	const phase = str(s, "phase", "local.phase");
	if (![
		"disabled",
		"starting",
		"online",
		"error",
		"stopped"
	].includes(phase)) reject("local.phase");
	const endpoints = s.endpoints;
	if (!Array.isArray(endpoints) || endpoints.some((entry) => typeof entry !== "string")) reject("local.endpoints");
	const message = s.message;
	if (message !== void 0 && typeof message !== "string") reject("local.message");
	const tlsFingerprint = s.tlsFingerprint;
	if (tlsFingerprint !== void 0 && typeof tlsFingerprint !== "string") reject("local.tlsFingerprint");
	const tlsIdentityRegenerated = s.tlsIdentityRegenerated;
	if (tlsIdentityRegenerated !== void 0 && typeof tlsIdentityRegenerated !== "boolean") reject("local.tlsIdentityRegenerated");
	return {
		phase,
		port: int(s, "port", "local.port"),
		endpoints,
		...typeof tlsFingerprint === "string" ? { tlsFingerprint } : {},
		...tlsIdentityRegenerated === true ? { tlsIdentityRegenerated: true } : {},
		...typeof message === "string" ? { message } : {},
		updatedAt: int(s, "updatedAt", "local.updatedAt")
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
		identityPath: str(s, "identityPath", "identityPath"),
		pairingReady: bool(s, "pairingReady", "pairingReady"),
		activeConnections: int(s, "activeConnections", "activeConnections"),
		historyBufferMax: int(s, "historyBufferMax", "historyBufferMax"),
		lanAddresses,
		local: parseLocal(s.local),
		remote: parseRemote(s.remote),
		devices: devices.map(parseDevice)
	};
}
const reportSchema = { parse: parseReport };
const relayTestSchema = { parse: parseRelayTestResult };
const pushTestSchema = { parse: parsePushTestResult };
const pairingGrantSchema = { parse(value) {
	const s = rec(value, "pairing grant");
	const code = str(s, "code", "pairingGrant.code");
	if (code.length < 32) reject("pairingGrant.code");
	return {
		code,
		expiresAt: int(s, "expiresAt", "pairingGrant.expiresAt"),
		audience: str(s, "audience", "pairingGrant.audience")
	};
} };
const deviceIdSchema = { parse(value) {
	if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) reject("deviceId");
	return value;
} };
const customNameSchema = { parse(value) {
	if (value === null) return null;
	if (typeof value !== "string") reject("customName");
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) reject("customName");
	return trimmed;
} };
const scopesSchema = { parse(value) {
	if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string" || !DEVICE_SCOPES.includes(scope))) reject("scopes");
	return normalizeDeviceScopes(value);
} };
const booleanSchema = { parse(value) {
	if (typeof value !== "boolean") reject("boolean");
	return value;
} };
/** The rc.2 Gateway materializes each strict codec through `create()`. */
function strictCodec(typeSymbol, schema) {
	return {
		mode: "strict",
		typeSymbol,
		create: () => schema
	};
}
const REPORT_HOST_CONTRIBUTION = {
	package: REPORT_REMOTE_PACKAGE,
	face: "host",
	schemas: [],
	model: {
		services: [],
		events: [],
		objects: []
	},
	invocations: [
		{
			id: `${REPORT_REMOTE_PACKAGE}#${REPORT_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "report",
			invocation: { kind: "direct" },
			parameters: [],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#DeepPilotReport`, reportSchema)
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#${BEGIN_PAIRING_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "beginPairing",
			invocation: { kind: "direct" },
			parameters: [],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#PairingGrantSnapshot`, pairingGrantSchema)
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#${REVOKE_DEVICE_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "revokeDevice",
			invocation: { kind: "direct" },
			parameters: [{
				name: "deviceId",
				wire: "deviceId",
				source: "json",
				codec: strictCodec(`${REPORT_REMOTE_PACKAGE}#DeviceId`, deviceIdSchema)
			}],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#Boolean`, booleanSchema)
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#${SET_DEVICE_NAME_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "setDeviceName",
			invocation: { kind: "direct" },
			parameters: [{
				name: "deviceId",
				wire: "deviceId",
				source: "json",
				codec: strictCodec(`${REPORT_REMOTE_PACKAGE}#DeviceId`, deviceIdSchema)
			}, {
				name: "customName",
				wire: "customName",
				source: "json",
				codec: strictCodec(`${REPORT_REMOTE_PACKAGE}#CustomDeviceName`, customNameSchema)
			}],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#CustomDeviceName`, customNameSchema)
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#${SET_DEVICE_SCOPES_ENDPOINT}`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "setDeviceScopes",
			invocation: { kind: "direct" },
			parameters: [{
				name: "deviceId",
				wire: "deviceId",
				source: "json",
				codec: strictCodec(`${REPORT_REMOTE_PACKAGE}#DeviceId`, deviceIdSchema)
			}, {
				name: "scopes",
				wire: "scopes",
				source: "json",
				codec: strictCodec(`${REPORT_REMOTE_PACKAGE}#DeviceScopes`, scopesSchema)
			}],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#DeviceScopes`, scopesSchema)
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#deeppilot/testRelay`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "testRelay",
			invocation: { kind: "direct" },
			parameters: [],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#RelayTestResult`, relayTestSchema)
		},
		{
			id: `${REPORT_REMOTE_PACKAGE}#deeppilot/testPush`,
			service: "deeppilotReport",
			namespace: "deeppilot",
			method: "testPush",
			invocation: { kind: "direct" },
			parameters: [],
			result: strictCodec(`${REPORT_REMOTE_PACKAGE}#PushTestResult`, pushTestSchema)
		}
	]
};
//#endregion
//#region src/report-remote.ts
/**
* Provide the report service and register its Remote descriptor. Rides an
* optional `typert` inject: profiles without the web stack never activate it.
*/
function applyReportRemote(ctx, snapshot, pairingStarter, deviceRevoker, deviceRenamer, deviceScopeUpdater, relayTester, pushTester) {
	ctx.inject(["typert"], (remoteCtx) => {
		new DeepPilotReportService(remoteCtx, snapshot, pairingStarter, deviceRevoker, deviceRenamer, deviceScopeUpdater, relayTester, pushTester);
		const unregister = remoteCtx.typert.register(REPORT_HOST_CONTRIBUTION);
		remoteCtx.effect(() => () => void unregister(), "dsh-deeppilot: report remote");
	});
}
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
//#region src/phone-http.ts
const CLIENT_IP_HEADER = "x-deeppilot-client-ip";
function rejectUpgrade(socket, status, reason, retryAfterSeconds) {
	const body = JSON.stringify({ error: reason });
	const statusText = {
		401: "Unauthorized",
		429: "Too Many Requests",
		500: "Internal Server Error",
		503: "Service Unavailable"
	};
	const retryAfter = status === 429 && retryAfterSeconds !== void 0 ? `Retry-After: ${Math.max(1, Math.ceil(retryAfterSeconds))}\r\n` : "";
	socket.end("HTTP/1.1 " + status + " " + (statusText[status] ?? "Error") + "\r\n" + retryAfter + "Content-Type: application/json\r\nContent-Length: " + Buffer.byteLength(body) + "\r\nConnection: close\r\n\r\n" + body);
}
function normalizedAddress(value) {
	if (!value) return null;
	const normalized = value.startsWith("::ffff:") ? value.slice(7) : value;
	return isIP(normalized) === 0 ? null : normalized;
}
function isLoopback(value) {
	const address = normalizedAddress(value);
	return address === "127.0.0.1" || address === "::1";
}
/**
* Resolve a stable rate-limit key. The helper-supplied address is trusted only
* on the private loopback hop; direct clients cannot spoof it.
*/
function requestClientIdentity(req) {
	if (isLoopback(req.socket.remoteAddress)) {
		const forwarded = req.headers[CLIENT_IP_HEADER];
		const address = normalizedAddress(Array.isArray(forwarded) ? forwarded[0] : forwarded);
		if (address !== null) return address;
	}
	return normalizedAddress(req.socket.remoteAddress) ?? "unknown";
}
//#endregion
//#region src/lan-tls.ts
const LAN_TLS_COMMON_NAME = "dsh-deeppilot";
const LAN_TLS_KEY_FILE = "key.pem";
const LAN_TLS_CERT_FILE = "cert.pem";
const CERT_VALIDITY_MS = 31536e7;
/** Re-sign this far ahead of expiry so a long-running host never serves a stale leaf. */
const CERT_RENEW_LEAD_MS = 2592e6;
/** Compute the pinned public-key fingerprint of a PEM certificate. */
function spkiFingerprint(certPem) {
	const der = createPublicKey(certPem).export({
		type: "spki",
		format: "der"
	});
	return "sha256:" + createHash("sha256").update(der).digest("base64url");
}
/**
* Load the LAN listener's TLS identity from `dir`, creating or repairing it
* as needed. The private key is the durable identity: it is created once and
* reused for every subsequent certificate, so pinned devices survive
* certificate renewals. Only a missing or unreadable key forces a new one.
*/
async function loadOrCreateLanTlsIdentity(dir, now = Date.now()) {
	await mkdir(dir, {
		recursive: true,
		mode: 448
	});
	const keyPath = join(dir, LAN_TLS_KEY_FILE);
	const certPath = join(dir, LAN_TLS_CERT_FILE);
	let key = await readPem(keyPath);
	let regenerated = false;
	if (key === void 0 || !validPrivateKey(key)) {
		regenerated = true;
		key = void 0;
	}
	let cert = regenerated ? void 0 : await readPem(certPath);
	let resigned = false;
	const existing = key !== void 0 && cert !== void 0 ? inspectCertificate(cert, key, now) : void 0;
	if (existing === void 0) {
		const issued = await issueCertificate(key, now);
		if (key === void 0) {
			key = pemFile(issued.key);
			await writePrivate(keyPath, key);
		} else resigned = true;
		cert = pemFile(issued.cert);
		await writePrivate(certPath, cert);
	}
	if (key === void 0 || cert === void 0) throw new Error("LAN TLS identity unavailable");
	return {
		key,
		cert,
		fingerprint: spkiFingerprint(cert),
		notAfter: existing ?? new X509Certificate(cert).validToDate.getTime(),
		regenerated,
		resigned
	};
}
async function readPem(path) {
	try {
		const text = await readFile(path, "utf8");
		return text.trim().length > 0 ? text : void 0;
	} catch (error) {
		if (error.code === "ENOENT") return void 0;
		return;
	}
}
function validPrivateKey(pem) {
	try {
		return createPrivateKey(pem).asymmetricKeyType === "ec";
	} catch {
		return false;
	}
}
/**
* Return the certificate's expiry when it is usable with `keyPem`, or
* `undefined` when it must be re-issued (malformed, wrong key, or expiring).
*/
function inspectCertificate(certPem, keyPem, now) {
	try {
		const cert = new X509Certificate(certPem);
		const certSpki = cert.publicKey.export({
			type: "spki",
			format: "der"
		});
		const keySpki = createPublicKey(createPrivateKey(keyPem)).export({
			type: "spki",
			format: "der"
		});
		if (!certSpki.equals(keySpki)) return void 0;
		const notAfter = cert.validToDate.getTime();
		if (!(cert.validFromDate.getTime() <= now && notAfter - CERT_RENEW_LEAD_MS > now)) return void 0;
		return notAfter;
	} catch {
		return;
	}
}
async function issueCertificate(existingKey, now) {
	const notBeforeDate = /* @__PURE__ */ new Date(now - 3e5);
	const notAfterDate = new Date(now + CERT_VALIDITY_MS);
	const keyPair = existingKey === void 0 ? void 0 : {
		privateKey: createPrivateKey(existingKey).export({
			type: "pkcs8",
			format: "pem"
		}),
		publicKey: createPublicKey(existingKey).export({
			type: "spki",
			format: "pem"
		})
	};
	const result = await generate([{
		name: "commonName",
		value: LAN_TLS_COMMON_NAME
	}], {
		keyType: "ec",
		curve: "P-256",
		algorithm: "sha256",
		notBeforeDate,
		notAfterDate,
		...keyPair ? { keyPair } : {},
		extensions: [
			{
				name: "basicConstraints",
				cA: false,
				critical: true
			},
			{
				name: "keyUsage",
				digitalSignature: true,
				keyAgreement: true,
				critical: true
			},
			{
				name: "extKeyUsage",
				serverAuth: true
			},
			{
				name: "subjectAltName",
				altNames: [{
					type: 2,
					value: LAN_TLS_COMMON_NAME
				}]
			}
		]
	});
	return {
		key: existingKey ?? result.private,
		cert: result.cert
	};
}
/** Exact on-disk form, so a freshly issued value equals its later reload. */
function pemFile(pem) {
	return pem.replace(/\r\n/g, "\n").trimEnd() + "\n";
}
async function writePrivate(path, contents) {
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(tmp, contents, { mode: 384 });
		await rename(tmp, path);
	} catch (error) {
		await unlink(tmp).catch(() => {});
		throw error;
	}
}
//#endregion
//#region src/index.ts
/**
* dsh-deeppilot — data bridge between the DSH host and DeepPilot
* clients. Owns independent, narrowly routed LAN (TLS-only, pinned by paired
* devices) and loopback Funnel-origin listeners. The web UI and the rest of
* DSH's API are never exposed by these listeners.
*
* Data plane: an in-process HostBridge consumes a local adapter over DSH
* Session/Workspace controllers, mirrors session summaries,
* tracks pending approvals/questions, and fans projected protocol-v2 pushes
* out to every connected device.
*
* Protocol: PROTOCOL.md is normative; src/protocol.ts and the private app's
* Swift models mirror that v2 contract.
*/
const name = "deeppilot";
/** No web-service requirement: the plugin owns its own transport listeners. */
const inject = [];
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
function apply(ctx, options) {
	const cfg = normalizeOptions(options);
	const log = (message) => {
		console.log("[deeppilot] " + message);
	};
	const auditSalt = randomBytes(32);
	const auditLabel = (value) => createHash("sha256").update(auditSalt).update(value).digest("hex").slice(0, 12);
	let scheduleRemoteReconcile;
	let scheduleLocalReconcile;
	const currentConfig = () => normalizeOptions(options);
	const enabledNow = () => currentConfig().enabled === true;
	ctx.on("loader/volatile-update", () => queueMicrotask(() => {
		scheduleLocalReconcile?.();
		scheduleRemoteReconcile?.();
	}));
	if (currentConfig().enabled !== true) log("disabled via settings; bridge stays inactive (rumors of /phone below are skipped)");
	const dataDir = bridgeDataDir();
	const pushGateway = new PushGateway({
		config: currentConfig,
		dataDir,
		devices: () => auth.devices,
		audience: () => auth.audience,
		connections: () => connections,
		enabledNow,
		log
	});
	const pairingCodes = new PairingCodeManager();
	const auth = {
		audience: null,
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
			await ensurePrivateBridgeDataDir();
			auth.audience = await loadOrCreateHostAudience(join(dataDir, "host-id"));
			auth.devices = await DeviceStore.load(cfg.devicesPath ?? join(dataDir, "devices-v2.json"));
			{
				const rows = auth.devices.list();
				const registered = rows.filter((row) => row.apns !== void 0).length;
				log(`device registry loaded from ${expandHome(cfg.devicesPath ?? join(dataDir, "devices-v2.json"))}: ${rows.length} device(s), ${registered} push registration(s)`);
			}
			await pushGateway.restore();
		} catch (error) {
			log("auth material unavailable, bridge degraded: " + String(error));
			return {
				audience: null,
				devices: null
			};
		}
		return {
			audience: auth.audience,
			devices: auth.devices
		};
	})();
	const beginPairing = async () => {
		await ready;
		if (auth.audience === null || auth.devices === null) throw new Error("device authentication unavailable");
		return {
			...pairingCodes.issue(),
			audience: auth.audience
		};
	};
	/**
	* Settings-page push self-test: force one synthetic notification down the
	* active pathway to EVERY registered device, deliberately ignoring the
	* connected-skip and category-mute filters — an explicit user action must
	* always be able to prove delivery end to end.
	*/
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
	/**
	* Unbind one device. Single path shared by the settings page (report-service
	* revokeDevice) and the wire-level c2s.device.revoke frame: mark the registry
	* tombstone (which also drops every APNs/WidgetKit/LiveActivity token, so the
	* push fan-out can no longer select it) and hard-drop its live sockets.
	* `except` is the connection that sent the revoke frame — it closes itself
	* with 4401 after acking, so it is not terminated here.
	*/
	const revokeDevice = async (deviceId, except) => {
		const { devices } = await ready;
		if (!devices) throw new Error("device registry unavailable");
		const revoked = devices.revoke(deviceId, Date.now());
		if (revoked) {
			for (const connection of [...connections]) {
				if (connection === except || connection.connectedDeviceId !== deviceId) continue;
				connection.terminate();
				connections.delete(connection);
			}
			log(`device revoked id=${auditLabel(deviceId)}`);
		}
		return revoked;
	};
	const wss = new WebSocketServer({
		noServer: true,
		maxPayload: MAX_FRAME_BYTES
	});
	let lanTlsIdentity;
	let tlsIdentityRegenerated = false;
	const loadLanTls = () => {
		lanTlsIdentity ??= (async () => {
			await ready;
			const identity = await loadOrCreateLanTlsIdentity(join(dataDir, "lan-tls"));
			if (identity.regenerated) {
				tlsIdentityRegenerated = true;
				log(`LAN TLS identity created: fingerprint=${identity.fingerprint}; previously paired LAN devices must pair again`);
			} else if (identity.resigned) log(`LAN TLS certificate renewed (fingerprint unchanged: ${identity.fingerprint})`);
			return identity;
		})();
		lanTlsIdentity.catch(() => {
			lanTlsIdentity = void 0;
		});
		return lanTlsIdentity;
	};
	const updateChecker = new UpdateChecker({
		log,
		currentVersion: SERVER_VERSION
	});
	updateChecker.scheduleInitial();
	const updateInfo = () => updateChecker.get();
	applyReportRemote(ctx, async () => {
		let pairingReady = false;
		let devices = [];
		try {
			await ready;
			pairingReady = auth.audience !== null && auth.devices !== null;
			devices = (auth.devices?.list() ?? []).filter((device) => device.publicKey !== void 0 && device.fingerprint !== void 0).map(({ deviceId, deviceName, customName, appVersion, firstSeenTs, lastSeenTs, fingerprint, scopes, revokedAt, apns }) => ({
				deviceId,
				deviceName: deviceDisplayName({
					deviceName,
					customName
				}),
				...customName ? { customName } : {},
				appVersion,
				firstSeenTs,
				lastSeenTs,
				fingerprint,
				scopes: normalizeDeviceScopes(scopes),
				...revokedAt !== void 0 ? { revokedAt } : {},
				...apns ? { apns: {
					environment: apns.environment,
					updatedAt: apns.updatedAt
				} } : {}
			}));
		} catch {}
		const update = updateInfo();
		const lanAddresses = localLANIPv4Addresses();
		return {
			protocolVersion: 2,
			serverVersion: SERVER_VERSION,
			pluginVersion: update.currentVersion,
			...update.available ? { updateAvailable: true } : {},
			...update.releaseUrl !== null ? { releaseUrl: update.releaseUrl } : {},
			enabled: currentConfig().enabled === true,
			identityPath: expandHome(currentConfig().devicesPath ?? join(bridgeDataDir(), "devices-v2.json")),
			pairingReady,
			activeConnections: connections.size,
			historyBufferMax: currentConfig().historyBufferMax ?? 2e3,
			lanAddresses,
			local: localStatus(lanAddresses),
			remote: remoteStatus(),
			devices
		};
	}, beginPairing, async (deviceId) => {
		return await revokeDevice(deviceId);
	}, async (deviceId, customName) => {
		const { devices } = await ready;
		if (!devices) throw new Error("device registry unavailable");
		if (await devices.setCustomName(deviceId, customName) === null) throw new Error("active device not found");
		const normalized = customName === null ? "" : sanitizeDeviceField(customName, 64);
		log(`device custom name updated id=${auditLabel(deviceId)} custom=${String(normalized.length > 0)}`);
		return normalized === "" ? null : normalized;
	}, async (deviceId, scopes) => {
		const { devices } = await ready;
		if (!devices) throw new Error("device registry unavailable");
		const updated = devices.setScopes(deviceId, scopes);
		if (updated === null) throw new Error("active device not found");
		for (const connection of [...connections]) {
			if (connection.connectedDeviceId !== deviceId) continue;
			connection.terminate();
			connections.delete(connection);
		}
		log(`device scopes updated id=${auditLabel(deviceId)} scopes=${updated.join(",")}`);
		return updated;
	}, () => pushGateway.relayTest(), () => pushGateway.selfTest());
	const state = {};
	let pendingUpgrades = 0;
	const authRateLimiter = new AuthRateLimiter();
	const readJSONBody = async (req, maxBytes = 16384) => {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > maxBytes) throw new Error("request body too large");
			chunks.push(buffer);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	};
	const handlePair = async (req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (!enabledNow()) {
			res.statusCode = 503;
			res.end(JSON.stringify({
				ok: false,
				error: "bridge disabled"
			}));
			return;
		}
		if (req.method !== "POST") {
			res.statusCode = 405;
			res.setHeader("Allow", "POST");
			res.end(JSON.stringify({
				ok: false,
				error: "POST required"
			}));
			return;
		}
		const source = requestClientIdentity(req);
		const admission = authRateLimiter.admit(source);
		if (!admission.ok) {
			res.statusCode = 429;
			res.setHeader("Retry-After", String(Math.max(1, Math.ceil(admission.retryAfterMs / 1e3))));
			res.end(JSON.stringify({
				ok: false,
				error: "pairing rate limited"
			}));
			return;
		}
		try {
			const { devices, audience } = await ready;
			if (!devices || !audience) throw new Error("device authentication unavailable");
			const raw = await readJSONBody(req);
			if (raw === null || typeof raw !== "object" || raw.v !== 2) throw new TypeError("protocol v2 required");
			const code = typeof raw.code === "string" ? raw.code : "";
			const publicKey = typeof raw.publicKey === "string" ? raw.publicKey : "";
			const deviceName = sanitizeDeviceField(raw.deviceName, 64) || "unknown";
			const appVersion = sanitizeDeviceField(raw.appVersion, 32) || "unknown";
			const deviceId = deviceIdForPublicKey(publicKey);
			if (devices.list().length >= 64 && devices.authorized(deviceId) === void 0) {
				res.statusCode = 409;
				res.end(JSON.stringify({
					ok: false,
					error: "device registry is full"
				}));
				return;
			}
			if (!pairingCodes.consume(code)) {
				const failure = authRateLimiter.recordFailure(source);
				res.statusCode = failure.blocked ? 429 : 401;
				if (failure.retryAfterMs > 0) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(failure.retryAfterMs / 1e3))));
				res.end(JSON.stringify({
					ok: false,
					error: failure.blocked ? "pairing rate limited" : "pairing code invalid or expired"
				}));
				return;
			}
			const record = devices.register({
				publicKey,
				deviceName,
				appVersion,
				scopes: normalizeDeviceScopes(raw.scopes)
			}, Date.now());
			authRateLimiter.recordSuccess(source);
			log(`device paired id=${auditLabel(record.deviceId)} source=${auditLabel(source)}`);
			const tlsFingerprint = req.socket.encrypted === true ? (await lanTlsIdentity)?.fingerprint : void 0;
			res.statusCode = 201;
			res.end(JSON.stringify({
				ok: true,
				v: 2,
				deviceId: record.deviceId,
				audience,
				scopes: record.scopes ?? [],
				...tlsFingerprint ? { tlsFingerprint } : {}
			}));
		} catch (error) {
			res.statusCode = error instanceof SyntaxError || error instanceof TypeError ? 400 : 503;
			res.end(JSON.stringify({
				ok: false,
				error: error instanceof Error ? error.message : "pairing failed"
			}));
		} finally {
			admission.release();
		}
	};
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
				let gate;
				try {
					const { devices, audience } = await ready;
					if (!audience || !devices) {
						rejectUpgrade(socket, 503, "bridge degraded");
						return;
					}
					const bridge = state.bridge;
					if (!bridge) {
						rejectUpgrade(socket, 503, "bridge not ready");
						return;
					}
					gate = new ConnectionGate({
						source: requestClientIdentity(req),
						devices,
						audience,
						limiter: authRateLimiter,
						log,
						auditLabel
					});
					if (!gate.admitted) {
						rejectUpgrade(socket, 429, "authentication rate limited");
						return;
					}
					const live = gate;
					wss.handleUpgrade(req, socket, head, (ws) => {
						if (auth.audience !== audience || state.bridge !== bridge) {
							live.markDead();
							ws.close(1012, "bridge changed");
							return;
						}
						try {
							const connection = new BridgeConnection(ws, {
								bridge,
								devices,
								serverVersion: SERVER_VERSION,
								audience,
								log,
								debug: currentConfig().diagnostics?.debug === true,
								source: live.source,
								rateLimiter: authRateLimiter,
								auditLabel,
								onClosed: (closed) => connections.delete(closed),
								onDeviceAuthenticated: (deviceId) => {
									log(`device authenticated id=${auditLabel(deviceId)} source=${auditLabel(live.source)}`);
								},
								onPushEnrollKey: (enrollKey) => pushGateway.enrollKey(enrollKey),
								onDeviceRevoke: (deviceId, except) => revokeDevice(deviceId, except)
							}, live);
							connections.add(connection);
						} catch (error) {
							live.markDead();
							ws.close(1011, "connection setup failed");
							throw error;
						}
					});
				} finally {
					gate?.releaseIfNeverAttached();
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
			res.setHeader("Content-Type", "application/json");
			if (!auth.audience || !auth.devices) {
				res.statusCode = 503;
				res.end(JSON.stringify({
					ok: false,
					degraded: true
				}));
				return;
			}
			res.statusCode = 200;
			res.end(JSON.stringify({
				ok: true,
				enabled: enabledNow(),
				protocolVersion: 2,
				serverVersion: SERVER_VERSION,
				dataPlane: Boolean(state.bridge)
			}));
		} catch {
			res.statusCode = 500;
			res.end(JSON.stringify({ ok: false }));
		}
	};
	const phoneHandlers = {
		health: handleHealth,
		pair: handlePair,
		upgrade: handleUpgrade
	};
	const localTransport = createLocalTransport({
		handlers: phoneHandlers,
		config: currentConfig,
		tls: loadLanTls,
		log
	});
	const remoteTransport = createRemoteTransport({
		handlers: phoneHandlers,
		config: currentConfig,
		originURL: () => originURL,
		dataDir,
		log
	});
	const localStatus = (addresses) => {
		const state = localTransport.status();
		return {
			...state,
			endpoints: state.phase === "online" ? localEndpointURLs(addresses, state.port) : [],
			...tlsIdentityRegenerated ? { tlsIdentityRegenerated: true } : {}
		};
	};
	const remoteStatus = () => remoteTransport.status();
	const originServer = createPhoneServer(phoneHandlers);
	let originURL;
	scheduleLocalReconcile = () => localTransport.scheduleReconcile();
	scheduleRemoteReconcile = () => remoteTransport.scheduleReconcile();
	ctx.effect(() => {
		scheduleLocalReconcile?.();
		listen(originServer, 0, "127.0.0.1").then(() => {
			const address = originServer.address();
			if (address && typeof address === "object") {
				originURL = `http://127.0.0.1:${address.port}`;
				scheduleRemoteReconcile?.();
			}
		}, (error) => log("remote origin failed: " + String(error)));
		return async () => {
			scheduleLocalReconcile = void 0;
			scheduleRemoteReconcile = void 0;
			await Promise.allSettled([
				closeServer(originServer),
				localTransport.dispose(),
				remoteTransport.dispose()
			]);
		};
	}, "deeppilot: independent transports");
	const sweep = setInterval(() => {
		const now = Date.now();
		for (const connection of connections) if (connection.isStale(now, 6e4)) {
			log("dropping stale connection");
			connection.closeIdle();
			connections.delete(connection);
		}
	}, 3e4);
	ctx.effect(() => () => clearInterval(sweep), "deeppilot: stale sweep");
	/**
	* Whether the resident Gateway Client represents a real phone surface. A
	* paired device remains answerable even while offline: HostBridge retains an
	* authoritative pending snapshot that the app pulls on reconnect, while
	* APNs is only a best-effort wakeup. With no paired device this Client calls
	* `next()`; Gateway's independent official Web delivery is unaffected.
	*/
	const hasPairedPhoneSurface = (_kind) => {
		return (auth.devices?.list() ?? []).some((device) => device.revokedAt === void 0);
	};
	ctx.inject([
		"sessionController",
		"connection",
		"typertGateway"
	], (sub) => {
		if (currentConfig().enabled !== true) {
			log("bridge disabled; data plane stays inactive");
			return;
		}
		const apiCtx = sub;
		let proxy;
		try {
			proxy = new DshApiProxy(apiCtx, { shouldSurfaceInteraction: hasPairedPhoneSurface });
		} catch (error) {
			log("DSH session bridge unavailable: " + String(error));
			return;
		}
		const bridge = new HostBridge(proxy, cfg.historyBufferMax, join(dataDir, "prompt-deliveries-v1.json"), join(dataDir, "schedule-mutations-v1.json"), join(dataDir, "fork-mutations-v1.json"));
		bridge.setPushOutlet(pushGateway);
		state.bridge = bridge;
		bridge.start();
		log("data plane active (mux + host streams)");
		apiCtx.effect(() => () => {
			closeConnectionsForBridge(bridge);
			if (state.bridge === bridge) state.bridge = void 0;
			bridge.dispose();
		}, "deeppilot: host streams");
	});
	ctx.effect(() => async () => {
		closeAllConnections();
		const bridge = state.bridge;
		state.bridge = void 0;
		bridge?.dispose();
		updateChecker.dispose();
		await pushGateway.dispose();
		const wssClosed = new Promise((resolve) => wss.close(() => resolve()));
		await Promise.allSettled([wssClosed]);
	}, "deeppilot: process resources");
}
//#endregion
export { Config, HostBridge, apply, inject, mayReceivePush, name, shouldPrunePushToken, shouldReEnrollRelayToken };

//# sourceMappingURL=index.js.map