window.__ModuleLoader__.load({
	id: "dsh-deeppilot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __commonJSMin = (cb, mod) => () => (mod || (cb((mod = { exports: {} }).exports, mod), cb = null), mod.exports);
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let _deepseek_ai_dsh_client_runtime_client = require("@deepseek-ai/dsh-client-runtime/client");
		let react = require("react");
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
		const REPORT_REMOTE_CONTRIBUTION = {
			package: REPORT_REMOTE_PACKAGE,
			descriptors: [
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
		//#region src/client/report-mount.ts
		/** Mount the contribution and resolve the namespace service it installs. */
		async function mountReportRemote(remote, resolveNamespace) {
			const dispose = await remote.$mount(REPORT_REMOTE_CONTRIBUTION);
			const namespace = resolveNamespace();
			if (namespace === void 0) {
				await dispose();
				throw new Error("remote.deeppilot 未注册");
			}
			return {
				namespace,
				dispose
			};
		}
		//#endregion
		//#region src/client/i18n.ts
		/** Single namespace shared with the host's locale registry, so other
		*  host-side modules (if any) can translate the same keys. */
		const DEEPPILOT_LOCALE_NS = "settings.deeppilot";
		/**
		* Single source of truth. Every key here MUST have a translation in every
		* supported locale; the i18n.test.ts "table parity" check enforces that.
		*
		* Shape: `{ locale: { key: value } }` — the same shape `dsh-client-locale`'s
		* `register(namespace, table)` accepts (and the same shape we already used
		* at the bottom of client/index.ts before this module existed).
		*
		* Naming convention: `<section>.<field>` (two dotted segments, lowercase,
		* ASCII-only). Names longer than two segments are reserved for future
		* sub-section splits and intentionally absent today.
		*/
		const TABLES = {
			zh: {
				"nav": "DeepPilot",
				"meta.title": "DeepPilot",
				"meta.intro": "把 iPhone 与这台电脑上的 DeepSeek Harness（DSH）连接起来（协议 v1）。",
				"meta.refresh": "刷新",
				"master.title": "DeepPilot 连接",
				"master.loading": "正在读取配置…",
				"master.on": "已开启：接受手机连接。",
				"master.off": "已关闭：不接受手机连接。",
				"remote.title": "远程连接（Tailscale Funnel）",
				"remote.on": "已配置：内嵌 Funnel 会自动启动并同步状态。",
				"remote.off": "关闭：仅保留局域网连接。",
				"remote.openAuth": "打开授权页面",
				"remote.limitTitle": "每个公网来源的连接上限",
				"remote.limitDescription": "默认 8，范围 1–16。应用后 Funnel 会重启，已有远程连接将短暂重连。",
				"remote.limitApply": "应用",
				"remote.limitApplied": "连接上限已保存，远程入口正在重新加载。",
				"remote.limitInvalid": "请输入 1–16 之间的整数。",
				"remote.limitFailed": "连接上限保存失败：",
				"phase.disabled": "未启用",
				"phase.starting": "正在启动",
				"phase.login_required": "等待 Tailscale 授权",
				"phase.online": "远程连接已就绪",
				"phase.error": "远程连接失败",
				"phase.unavailable": "远程 helper 不可用",
				"phase.stopped": "已停止",
				"phase.unknown": "状态未知",
				"panel.activeConnections": "当前连接",
				"panel.token": "配对 Token",
				"panel.tokenReady": "已就绪",
				"panel.tokenNotReady": "未生成",
				"panel.tokenMasked": "••••••••••••",
				"panel.tokenAction.show": "显示",
				"panel.tokenAction.hide": "隐藏",
				"panel.tokenAction.copy": "复制",
				"panel.tokenAction.rotate": "更换",
				"panel.tokenAction.rotateConfirm": "确认更换？",
				"panel.tokenAction.showing": "读取中…",
				"panel.tokenAction.rotating": "更换中…",
				"panel.tokenAutoHidden": "Token 已自动隐藏",
				"panel.tokenCopied": "已复制到剪贴板",
				"panel.tokenCopyFailed": "复制失败：",
				"panel.tokenRevealFailed": "Token 读取失败：",
				"panel.tokenRotateWarning": "更换会使当前 Token 立即失效、断开所有手机连接；5 秒内再次点击确认。",
				"panel.tokenRotated": "新 Token 已生效，旧 Token 已失效；请重新配对所有设备。",
				"panel.tokenRotateFailed": "更换失败：",
				"pair.qrPanelTitle": "扫码添加当前手机",
				"pair.kind.public": "公网",
				"pair.kind.lan": "内网",
				"pair.noAddress": "没有可用地址",
				"pair.noAddressHelp": "未发现可供手机访问的局域网地址，请确认这台电脑已连接局域网。",
				"pair.qrAlt": "DeepPilot 配对二维码",
				"pair.qrShow": "显示二维码",
				"pair.qrHide": "隐藏二维码",
				"pair.qrGenerating": "生成中…",
				"pair.qrAutoHidden": "配对二维码已自动隐藏",
				"pair.qrFailed": "二维码生成失败：",
				"pair.publicCopyDone": "公网地址已复制",
				"pair.publicCopyFailed": "复制失败：",
				"pair.qrHint": "二维码包含{kind}地址和配对 Token，将在 60 秒后自动隐藏。",
				"advanced.summary": "高级信息",
				"advanced.protocolVersion": "协议版本",
				"advanced.serverVersion": "服务器版本",
				"advanced.tokenPath": "Token 路径",
				"advanced.bufferMax": "重放缓冲上限",
				"advanced.frames": " 帧",
				"push.relayTitle": "离线推送中继",
				"push.testRelay": "测试访问与注册",
				"push.testPush": "发送测试通知",
				"push.relayTesting": "测试中…",
				"push.pushSending": "发送中…",
				"push.relayDefault": "验证 Mac 到推送中继的连通性与自动注册是否正常。",
				"push.pushDefault": "向所有已注册设备强制发送一条真实推送（不受在线状态与分类开关影响）。",
				"push.relayOk": "通过",
				"push.relayBad": "存在问题",
				"push.relayUrlEmpty": "（未启用）",
				"push.pushSent": "已送达",
				"push.pushFailed": "发送失败",
				"push.pushNoTargets": "无已注册设备",
				"push.pushNotEnabled": "推送未启用",
				"push.relayStep.health": "服务可达",
				"push.relayStep.enroll": "自动注册",
				"push.prefix.ok": "✓ ",
				"push.prefix.fail": "✗ ",
				"devices.title": "已配对设备",
				"devices.col.name": "设备",
				"devices.col.appVersion": "App 版本",
				"devices.col.push": "离线推送",
				"devices.col.lastSeen": "最近在线",
				"devices.pushRegistered": "已注册（",
				"devices.pushNotRegistered": "未注册",
				"devices.pushEnvProduction": "生产",
				"devices.pushEnvDevelopment": "开发",
				"devices.empty": "还没有设备配对过。在 iPhone 上的 DeepPilot App 中扫码或填入本机地址与 Token 即可配对。",
				"help.remoteTitle": "远程连接帮助",
				"help.recommended": "推荐设置流程",
				"help.step1": "先打开\"DeepPilot 连接\"，再打开\"远程连接（Tailscale Funnel）\"。",
				"help.step2": "状态变为\"等待 Tailscale 授权\"后，点击\"打开授权页面\"。",
				"help.step3": "使用有权管理此 Tailnet 的账号登录，并按授权页提示启用 Funnel。通常需要 Owner、Admin 或 Network admin 权限。",
				"help.step4": "返回此页面并点击\"刷新\"。远程连接标题旁出现绿点后，即可扫描下方二维码添加手机。",
				"help.funnelHint": "插件已内嵌 Tailscale 网络组件，这台电脑和手机都不需要另外安装 Tailscale App；但首次启用仍需由 Tailnet 管理员授权。",
				"help.httpsTitle": "授权页未自动完成时：开启 HTTPS",
				"help.httpsStep1": "打开 Tailscale 管理后台的 Network → DNS。",
				"help.httpsStep2": "确认 MagicDNS 已开启。",
				"help.httpsStep3": "在 HTTPS Certificates 中点击 Enable HTTPS。",
				"help.httpsHint": "启用 HTTPS 后，设备的完整域名会写入公开的证书透明度日志。如果设备名包含敏感信息，请先在 Tailscale 中重命名设备。",
				"help.allowTitle": "授权页未自动完成时：允许 Funnel",
				"help.allowBody": "打开 Access controls → Definitions，选择 Node attributes。在现有 nodeAttrs 数组中追加下面这一项；不要覆盖已有访问规则，也不要创建第二个 nodeAttrs 顶层字段。",
				"help.allowHint": "保存策略后回到本页刷新。公共 DNS 和权限变更可能需要几分钟生效。",
				"help.faqTitle": "常见问题",
				"help.faq1": "提示\"HTTPS must be enabled\"：完成上面的 HTTPS Certificates 设置。",
				"help.faq2": "\"Funnel not available\"：确认 nodeAttrs 已保存，并且当前节点属于规则的 target。",
				"help.faq3": "已有公网地址但手机超时：等待几分钟后重试，同时确认这台电脑未休眠、DSH 正在运行，再重新扫描最新二维码。",
				"help.faq4": "没有公网地址：检查 Tailscale 授权是否完成，然后点击\"刷新\"或重启 DSH。",
				"help.securityTitle": "安全说明",
				"help.security1": "Funnel 公网地址可从互联网访问，但手机接口仍需要配对 Token。不要分享二维码、Token 或包含它们的截图。",
				"help.security2": "怀疑 Token 泄露时，点击上方\"更换\"生成新 Token：旧 Token 立即失效，所有已连接设备会被断开并需要重新配对。",
				"help.security3": "插件只通过 Funnel 转发 /phone 和 /phone/health，不会新增 3098 端口。",
				"help.security4": "局域网连接沿用 DSH 的 3080 端口；仅在可信网络中使用，不建议直接把 3080 暴露到公网。",
				"help.security5": "关闭远程连接开关会停止 Funnel，但不会影响可用的局域网连接。",
				"help.funnelDocs": "Tailscale Funnel 官方文档",
				"help.docsPrefix": "更多信息：",
				"diag.remoteUnavailable": "remote 服务不可用",
				"diag.remoteUnmounted": "report remote 未挂载",
				"diag.mountFailed": "报告远程未挂载（remote mount 失败）— 请确认宿主包含 typert 组合",
				"diag.mountFailedShort": "remote mount 失败: ",
				"diag.callFailed": "report remote 调用失败",
				"diag.settingsUnavailable": "设置命名空间不可用（settingsScope 未提供）",
				"diag.missingReportHook": "useDeepPilotReport hook 缺失",
				"diag.missingEnabledHook": "useDeepPilotEnabled hook 缺失",
				"diag.missingRemoteEnabledHook": "useDeepPilotRemoteEnabled hook 缺失",
				"diag.missingRemoteLimitHook": "useDeepPilotRemoteConnectionLimit hook 缺失",
				"diag.missingRefresh": "refresh 回调缺失",
				"diag.missingReveal": "revealPairingToken 回调缺失",
				"diag.missingRotate": "rotatePairingToken 回调缺失",
				"diag.missingTestRelay": "testRelay 回调缺失",
				"diag.missingTestPush": "testPush 回调缺失",
				"diag.missingSetEnabled": "setDeepPilotEnabled 回调缺失",
				"diag.missingSetRemote": "setDeepPilotRemoteEnabled 回调缺失",
				"diag.missingSetRemoteLimit": "setDeepPilotRemoteConnectionLimit 回调缺失",
				"diag.renderError": "渲染异常: ",
				"diag.prefix": "diag: ",
				"clipboard.rejected": "浏览器拒绝了剪贴板写入",
				"push.staleHost": "宿主插件版本较旧，不支持推送测试",
				"push.staleHostRelay": "宿主插件版本较旧，不支持中继测试",
				"push.staleHostPush": "宿主插件版本较旧，不支持推送测试 — 请更新 dsh-deeppilot",
				"push.staleHostPushRelay": "宿主插件版本较旧，不支持中继测试 — 请更新 dsh-deeppilot",
				"update.badge": "有新版本"
			},
			en: {
				"nav": "DeepPilot",
				"meta.title": "DeepPilot",
				"meta.intro": "Connect your iPhone to DeepSeek Harness (DSH) on this Mac (protocol v1).",
				"meta.refresh": "Refresh",
				"master.title": "DeepPilot connection",
				"master.loading": "Loading settings…",
				"master.on": "On: accepting phone connections.",
				"master.off": "Off: not accepting phone connections.",
				"remote.title": "Remote connection (Tailscale Funnel)",
				"remote.on": "Configured: the embedded Funnel will start and sync state automatically.",
				"remote.off": "Off: LAN connections only.",
				"remote.openAuth": "Open authorization page",
				"remote.limitTitle": "Connections per public source",
				"remote.limitDescription": "Default 8; range 1–16. Applying restarts Funnel and briefly reconnects existing remote clients.",
				"remote.limitApply": "Apply",
				"remote.limitApplied": "Connection limit saved; the remote endpoint is reloading.",
				"remote.limitInvalid": "Enter an integer from 1 to 16.",
				"remote.limitFailed": "Failed to save connection limit: ",
				"phase.disabled": "Disabled",
				"phase.starting": "Starting",
				"phase.login_required": "Awaiting Tailscale authorization",
				"phase.online": "Remote connection ready",
				"phase.error": "Remote connection failed",
				"phase.unavailable": "Remote helper unavailable",
				"phase.stopped": "Stopped",
				"phase.unknown": "Status unknown",
				"panel.activeConnections": "Active connections",
				"panel.token": "Pairing token",
				"panel.tokenReady": "Ready",
				"panel.tokenNotReady": "Not generated",
				"panel.tokenMasked": "••••••••••••",
				"panel.tokenAction.show": "Show",
				"panel.tokenAction.hide": "Hide",
				"panel.tokenAction.copy": "Copy",
				"panel.tokenAction.rotate": "Rotate",
				"panel.tokenAction.rotateConfirm": "Confirm rotate?",
				"panel.tokenAction.showing": "Reading…",
				"panel.tokenAction.rotating": "Rotating…",
				"panel.tokenAutoHidden": "Token auto-hidden",
				"panel.tokenCopied": "Copied to clipboard",
				"panel.tokenCopyFailed": "Copy failed: ",
				"panel.tokenRevealFailed": "Token reveal failed: ",
				"panel.tokenRotateWarning": "Rotation invalidates the current token immediately and drops every paired phone. Click again within 5s to confirm.",
				"panel.tokenRotated": "New token active, old token invalidated. Please re-pair every device.",
				"panel.tokenRotateFailed": "Rotation failed: ",
				"pair.qrPanelTitle": "Scan to pair this phone",
				"pair.kind.public": "Public",
				"pair.kind.lan": "LAN",
				"pair.noAddress": "No address available",
				"pair.noAddressHelp": "No LAN address reachable from a phone. Make sure this Mac is on the local network.",
				"pair.qrAlt": "DeepPilot pairing QR code",
				"pair.qrShow": "Show QR code",
				"pair.qrHide": "Hide QR code",
				"pair.qrGenerating": "Generating…",
				"pair.qrAutoHidden": "Pairing QR auto-hidden",
				"pair.qrFailed": "QR generation failed: ",
				"pair.publicCopyDone": "Public URL copied",
				"pair.publicCopyFailed": "Copy failed: ",
				"pair.qrHint": "The QR contains a {kind} address and the pairing token; it auto-hides after 60 seconds.",
				"advanced.summary": "Advanced info",
				"advanced.protocolVersion": "Protocol version",
				"advanced.serverVersion": "Server version",
				"advanced.tokenPath": "Token path",
				"advanced.bufferMax": "Replay buffer cap",
				"advanced.frames": " frames",
				"push.relayTitle": "Offline push relay",
				"push.testRelay": "Test reach & enroll",
				"push.testPush": "Send test notification",
				"push.relayTesting": "Testing…",
				"push.pushSending": "Sending…",
				"push.relayDefault": "Verify Mac → push relay connectivity and zero-touch enrollment.",
				"push.pushDefault": "Force one real push to every registered device (ignores online state and category switches).",
				"push.relayOk": "OK",
				"push.relayBad": "Issues found",
				"push.relayUrlEmpty": "(disabled)",
				"push.pushSent": "Delivered",
				"push.pushFailed": "Send failed",
				"push.pushNoTargets": "No registered devices",
				"push.pushNotEnabled": "Push not enabled",
				"push.relayStep.health": "Service reachable",
				"push.relayStep.enroll": "Auto enrollment",
				"push.prefix.ok": "✓ ",
				"push.prefix.fail": "✗ ",
				"devices.title": "Paired devices",
				"devices.col.name": "Device",
				"devices.col.appVersion": "App version",
				"devices.col.push": "Push",
				"devices.col.lastSeen": "Last seen",
				"devices.pushRegistered": "Registered (",
				"devices.pushNotRegistered": "Not registered",
				"devices.pushEnvProduction": "Production",
				"devices.pushEnvDevelopment": "Development",
				"devices.empty": "No devices paired yet. Scan the QR code or enter the host address + token in DeepPilot on iPhone to pair.",
				"help.remoteTitle": "Remote connection help",
				"help.recommended": "Recommended setup",
				"help.step1": "Turn on \"DeepPilot connection\" first, then \"Remote connection (Tailscale Funnel)\".",
				"help.step2": "When the status shows \"Awaiting Tailscale authorization\", click \"Open authorization page\".",
				"help.step3": "Sign in with an account that can manage this Tailnet and follow the on-page prompts to enable Funnel. Owner / Admin / Network admin is usually required.",
				"help.step4": "Come back to this page and click \"Refresh\". When a green dot appears next to the remote title, scan the QR code below to add your phone.",
				"help.funnelHint": "The plugin bundles the Tailscale networking stack, so neither this Mac nor the phone needs the Tailscale app — but a Tailnet administrator must approve first-time use.",
				"help.httpsTitle": "If authorization does not complete: enable HTTPS",
				"help.httpsStep1": "Open the Tailscale admin console → Network → DNS.",
				"help.httpsStep2": "Confirm MagicDNS is enabled.",
				"help.httpsStep3": "In HTTPS Certificates click Enable HTTPS.",
				"help.httpsHint": "Enabling HTTPS publishes the device hostname to public certificate transparency logs. Rename the device in Tailscale first if its name is sensitive.",
				"help.allowTitle": "If authorization does not complete: allow Funnel",
				"help.allowBody": "Open Access controls → Definitions, select Node attributes. Append the snippet below to your existing nodeAttrs array; do not overwrite other access rules and do not add a second top-level nodeAttrs field.",
				"help.allowHint": "Save the policy and refresh this page. Public DNS and policy changes can take a few minutes to propagate.",
				"help.faqTitle": "Frequently asked questions",
				"help.faq1": "\"HTTPS must be enabled\" — finish the HTTPS Certificates steps above.",
				"help.faq2": "\"Funnel not available\" — make sure the nodeAttrs snippet is saved and this node is in the rule's target.",
				"help.faq3": "Public URL exists but the phone times out: wait a few minutes, confirm the Mac is awake and DSH is running, then re-scan the latest QR code.",
				"help.faq4": "No public URL: check that Tailscale authorization completed, then click \"Refresh\" or restart DSH.",
				"help.securityTitle": "Security notes",
				"help.security1": "A Funnel public URL is reachable from the public Internet, but the phone interface still needs the pairing token. Do not share the QR code, the token, or any screenshot that contains them.",
				"help.security2": "If you suspect the token leaked, click \"Rotate\" above to mint a new one. The old token stops working immediately and every paired device must re-pair.",
				"help.security3": "The plugin only forwards /phone and /phone/health through Funnel; no new port 3098 is opened.",
				"help.security4": "LAN connections reuse DSH's existing 3080 port. Use them only on trusted networks; do not expose 3080 directly to the public Internet.",
				"help.security5": "Disabling the remote switch stops Funnel but does not affect any LAN connection you already have.",
				"help.funnelDocs": "Tailscale Funnel docs",
				"help.docsPrefix": "More info: ",
				"diag.remoteUnavailable": "remote service unavailable",
				"diag.remoteUnmounted": "report remote not mounted",
				"diag.mountFailed": "Report remote not mounted (mount failed) — confirm the host includes the typert composition",
				"diag.mountFailedShort": "remote mount failed: ",
				"diag.callFailed": "report remote call failed",
				"diag.settingsUnavailable": "Settings namespace unavailable (settingsScope not provided)",
				"diag.missingReportHook": "useDeepPilotReport hook missing",
				"diag.missingEnabledHook": "useDeepPilotEnabled hook missing",
				"diag.missingRemoteEnabledHook": "useDeepPilotRemoteEnabled hook missing",
				"diag.missingRemoteLimitHook": "useDeepPilotRemoteConnectionLimit hook missing",
				"diag.missingRefresh": "refresh callback missing",
				"diag.missingReveal": "revealPairingToken callback missing",
				"diag.missingRotate": "rotatePairingToken callback missing",
				"diag.missingTestRelay": "testRelay callback missing",
				"diag.missingTestPush": "testPush callback missing",
				"diag.missingSetEnabled": "setDeepPilotEnabled callback missing",
				"diag.missingSetRemote": "setDeepPilotRemoteEnabled callback missing",
				"diag.missingSetRemoteLimit": "setDeepPilotRemoteConnectionLimit callback missing",
				"diag.renderError": "Render error: ",
				"diag.prefix": "diag: ",
				"clipboard.rejected": "Clipboard write rejected by the browser",
				"push.staleHost": "Host plugin is too old for push testing",
				"push.staleHostRelay": "Host plugin is too old for relay testing",
				"push.staleHostPush": "Host plugin is too old for push testing — please update dsh-deeppilot",
				"push.staleHostPushRelay": "Host plugin is too old for relay testing — please update dsh-deeppilot",
				"update.badge": "New version available"
			}
		};
		Object.keys(TABLES.zh);
		/** Substitute every `{name}` in `template` with `String(vars[name])`. The
		*  host bind() does not interpolate, so we always run the result through
		*  here for any key the caller asked to format. Numeric / object placeholders
		*  are coerced to strings; missing placeholders are left intact so a
		*  missing key is visible in the rendered output. */
		function interpolate(template, vars) {
			if (!vars) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => {
				const value = vars[name];
				if (value === void 0) return match;
				return String(value);
			});
		}
		/** Detect the active language from the locale snapshot or browser hints. */
		function detectLocale(ctx) {
			try {
				const active = ctx.locale?.getSnapshot?.().active;
				if (active === "zh" || active?.toLowerCase().startsWith("zh-")) return "zh";
				if (active === "en" || active?.toLowerCase().startsWith("en-")) return "en";
			} catch {}
			if ((typeof document === "undefined" ? "" : document.documentElement.lang).toLowerCase().startsWith("zh")) return "zh";
			if ((typeof navigator === "undefined" ? [] : navigator.languages).some((language) => language.toLowerCase().startsWith("zh"))) return "zh";
			return "en";
		}
		/**
		* Invoke the translation function supplied to a locale-aware slot. Keeping
		* this adapter distinct from `t(ctx, ...)` prevents a translator function
		* from being mistaken for a Cordis Context, which previously forced every
		* settings-page lookup through the English no-host fallback.
		*/
		function translateWith(translator, key, vars) {
			if (typeof translator !== "function") return key;
			return translator(key, vars);
		}
		/** Translation function. Callers always go through this — never the
		*  underlying locale face — so the substitution / fallback path stays in
		*  one place. `ctx` may be omitted (offline / SSR / tests) and we resolve
		*  to en automatically. */
		function t(ctx, key, vars) {
			const anyCtx = ctx;
			let template;
			if (anyCtx?.locale) try {
				template = anyCtx.locale.bind(DEEPPILOT_LOCALE_NS)(key);
			} catch {
				template = void 0;
			}
			if (template === void 0 || template === key) {
				const locale = detectLocale(anyCtx ?? { locale: void 0 });
				template = TABLES[locale][key] ?? TABLES.zh[key] ?? TABLES.en[key] ?? key;
			}
			return interpolate(template, vars);
		}
		/** Register both dictionaries and return the host-owned disposer. */
		function registerLocale(ctx) {
			const anyCtx = ctx;
			if (anyCtx.locale === void 0) return () => {};
			return anyCtx.locale.register(DEEPPILOT_LOCALE_NS, {
				zh: TABLES.zh,
				en: TABLES.en
			});
		}
		//#endregion
		//#region src/client/styles.ts
		const CSS = [
			".pbb-section{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}",
			".pbb-title{margin:0;font-size:18px;font-weight:600}",
			".pbb-intro{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}",
			".pbb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:4px 16px}",
			".pbb-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}",
			".pbb-field+.pbb-field{border-top:1px solid var(--dsw-alias-border-l2)}",
			".pbb-row{display:flex;align-items:center;gap:8px}",
			".pbb-label{flex:1;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);min-width:0}",
			".pbb-value{font-size:13px;color:var(--dsw-alias-label-secondary);word-break:break-all;text-align:right}",
			".pbb-badge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;white-space:nowrap}",
			".pbb-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));font-weight:500}",
			".pbb-bad{color:var(--dsw-alias-label-error);font-weight:500}",
			".pbb-table{width:100%;border-collapse:collapse;font-size:12px}",
			".pbb-table th{color:var(--dsw-alias-label-tertiary);text-align:left;font-weight:500;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
			".pbb-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
			".pbb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:0}",
			".pbb-diag{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5}",
			".pbb-diagBad{color:var(--dsw-alias-label-error)}",
			".pbb-refresh{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;padding:0}",
			".pbb-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".pbb-refresh:disabled{cursor:default;opacity:.5}",
			".pbb-tokenRow{flex-wrap:wrap}",
			".pbb-token{max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
			".pbb-tokenActions{display:flex;align-items:center;gap:8px}",
			".pbb-action{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:3px 8px}",
			".pbb-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}",
			".pbb-action:disabled{cursor:default;opacity:.5}",
			".pbb-actionDanger:not(:disabled){color:#fff;background:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error)}",
			".pbb-qrPanel{display:flex;flex-direction:column;align-items:center;gap:9px;padding:12px 0 4px}",
			".pbb-qrImage{width:240px;height:240px;max-width:100%;background:#fff;border-radius:10px;padding:8px;box-sizing:border-box}",
			".pbb-qrHint{max-width:420px;text-align:center;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}",
			".pbb-switchRow{padding:12px 0;display:flex;align-items:center;gap:12px}",
			".pbb-switchRow+.pbb-field{border-top:1px solid var(--dsw-alias-border-l2)}",
			".pbb-switchText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
			".pbb-switchTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
			".pbb-dotRow{display:flex;align-items:center;gap:7px}",
			".pbb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}",
			".pbb-dotOk{background:var(--dsw-alias-state-success-primary,#22a06b)}",
			".pbb-dotWarn{background:var(--dsw-alias-state-warning-primary,#e2b203)}",
			".pbb-dotBad{background:var(--dsw-alias-label-error)}",
			".pbb-rowAction{display:flex;gap:8px;margin-top:4px}",
			".pbb-switchDesc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4}",
			".pbb-switch{appearance:none;-webkit-appearance:none;width:38px;height:22px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);position:relative;cursor:pointer;padding:0;flex:none;transition:background .15s ease}",
			".pbb-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background .15s ease}",
			".pbb-switchOn{background:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}",
			".pbb-switchOn::after{transform:translateX(16px);background:#fff}",
			".pbb-switch:disabled{opacity:.5;cursor:default}",
			".pbb-limitRow{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0;display:flex;align-items:center;gap:12px}",
			".pbb-limitControl{display:flex;align-items:center;gap:8px;flex:none}",
			".pbb-numberInput{width:72px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 8px}",
			".pbb-numberInput:focus{outline:2px solid var(--dsw-alias-state-success-primary,#22a06b);outline-offset:1px}",
			".pbb-numberInput:disabled{opacity:.5}",
			".pbb-help{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0}",
			".pbb-help summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;user-select:none}",
			".pbb-help summary:hover{color:var(--dsw-alias-label-secondary)}",
			".pbb-helpBody{display:flex;flex-direction:column;gap:14px;padding:12px 0 2px}",
			".pbb-helpSection{display:flex;flex-direction:column;gap:6px}",
			".pbb-helpHeading{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".pbb-helpList{margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
			".pbb-helpList li+li{margin-top:4px}",
			".pbb-helpText{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}",
			".pbb-helpCode{display:block;margin:2px 0 0;padding:10px;overflow:auto;white-space:pre-wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}",
			".pbb-helpLink{color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px}",
			".pbb-versionFooter{display:flex;justify-content:center;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);padding:8px 0 4px;line-height:1.4}",
			".pbb-versionFooter a{color:var(--dsw-alias-state-success-primary,#22a06b);text-decoration:none}",
			".pbb-versionFooter a:hover{text-decoration:underline;text-underline-offset:2px}"
		].join("\n");
		function injectCss() {
			if (typeof document === "undefined") return;
			const id = "dsh-deeppilot/page.css";
			if (document.querySelector("style[data-plugin-css=\"" + id + "\"]") !== null) return;
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", id);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion
		//#region node_modules/qrcode/lib/can-promise.js
		var require_can_promise = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			module.exports = function() {
				return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/utils.js
		var require_utils$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
			let toSJISFunction;
			const CODEWORDS_COUNT = [
				0,
				26,
				44,
				70,
				100,
				134,
				172,
				196,
				242,
				292,
				346,
				404,
				466,
				532,
				581,
				655,
				733,
				815,
				901,
				991,
				1085,
				1156,
				1258,
				1364,
				1474,
				1588,
				1706,
				1828,
				1921,
				2051,
				2185,
				2323,
				2465,
				2611,
				2761,
				2876,
				3034,
				3196,
				3362,
				3532,
				3706
			];
			/**
			* Returns the QR Code size for the specified version
			*
			* @param  {Number} version QR Code version
			* @return {Number}         size of QR code
			*/
			exports.getSymbolSize = function getSymbolSize(version) {
				if (!version) throw new Error("\"version\" cannot be null or undefined");
				if (version < 1 || version > 40) throw new Error("\"version\" should be in range from 1 to 40");
				return version * 4 + 17;
			};
			/**
			* Returns the total number of codewords used to store data and EC information.
			*
			* @param  {Number} version QR Code version
			* @return {Number}         Data length in bits
			*/
			exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
				return CODEWORDS_COUNT[version];
			};
			/**
			* Encode data with Bose-Chaudhuri-Hocquenghem
			*
			* @param  {Number} data Value to encode
			* @return {Number}      Encoded value
			*/
			exports.getBCHDigit = function(data) {
				let digit = 0;
				while (data !== 0) {
					digit++;
					data >>>= 1;
				}
				return digit;
			};
			exports.setToSJISFunction = function setToSJISFunction(f) {
				if (typeof f !== "function") throw new Error("\"toSJISFunc\" is not a valid function.");
				toSJISFunction = f;
			};
			exports.isKanjiModeEnabled = function() {
				return typeof toSJISFunction !== "undefined";
			};
			exports.toSJIS = function toSJIS(kanji) {
				return toSJISFunction(kanji);
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/error-correction-level.js
		var require_error_correction_level = /* @__PURE__ */ __commonJSMin(((exports) => {
			exports.L = { bit: 1 };
			exports.M = { bit: 0 };
			exports.Q = { bit: 3 };
			exports.H = { bit: 2 };
			function fromString(string) {
				if (typeof string !== "string") throw new Error("Param is not a string");
				switch (string.toLowerCase()) {
					case "l":
					case "low": return exports.L;
					case "m":
					case "medium": return exports.M;
					case "q":
					case "quartile": return exports.Q;
					case "h":
					case "high": return exports.H;
					default: throw new Error("Unknown EC Level: " + string);
				}
			}
			exports.isValid = function isValid(level) {
				return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
			};
			exports.from = function from(value, defaultValue) {
				if (exports.isValid(value)) return value;
				try {
					return fromString(value);
				} catch (e) {
					return defaultValue;
				}
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/bit-buffer.js
		var require_bit_buffer = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			function BitBuffer() {
				this.buffer = [];
				this.length = 0;
			}
			BitBuffer.prototype = {
				get: function(index) {
					const bufIndex = Math.floor(index / 8);
					return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
				},
				put: function(num, length) {
					for (let i = 0; i < length; i++) this.putBit((num >>> length - i - 1 & 1) === 1);
				},
				getLengthInBits: function() {
					return this.length;
				},
				putBit: function(bit) {
					const bufIndex = Math.floor(this.length / 8);
					if (this.buffer.length <= bufIndex) this.buffer.push(0);
					if (bit) this.buffer[bufIndex] |= 128 >>> this.length % 8;
					this.length++;
				}
			};
			module.exports = BitBuffer;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/bit-matrix.js
		var require_bit_matrix = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			/**
			* Helper class to handle QR Code symbol modules
			*
			* @param {Number} size Symbol size
			*/
			function BitMatrix(size) {
				if (!size || size < 1) throw new Error("BitMatrix size must be defined and greater than 0");
				this.size = size;
				this.data = new Uint8Array(size * size);
				this.reservedBit = new Uint8Array(size * size);
			}
			/**
			* Set bit value at specified location
			* If reserved flag is set, this bit will be ignored during masking process
			*
			* @param {Number}  row
			* @param {Number}  col
			* @param {Boolean} value
			* @param {Boolean} reserved
			*/
			BitMatrix.prototype.set = function(row, col, value, reserved) {
				const index = row * this.size + col;
				this.data[index] = value;
				if (reserved) this.reservedBit[index] = true;
			};
			/**
			* Returns bit value at specified location
			*
			* @param  {Number}  row
			* @param  {Number}  col
			* @return {Boolean}
			*/
			BitMatrix.prototype.get = function(row, col) {
				return this.data[row * this.size + col];
			};
			/**
			* Applies xor operator at specified location
			* (used during masking process)
			*
			* @param {Number}  row
			* @param {Number}  col
			* @param {Boolean} value
			*/
			BitMatrix.prototype.xor = function(row, col, value) {
				this.data[row * this.size + col] ^= value;
			};
			/**
			* Check if bit at specified location is reserved
			*
			* @param {Number}   row
			* @param {Number}   col
			* @return {Boolean}
			*/
			BitMatrix.prototype.isReserved = function(row, col) {
				return this.reservedBit[row * this.size + col];
			};
			module.exports = BitMatrix;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/alignment-pattern.js
		var require_alignment_pattern = /* @__PURE__ */ __commonJSMin(((exports) => {
			/**
			* Alignment pattern are fixed reference pattern in defined positions
			* in a matrix symbology, which enables the decode software to re-synchronise
			* the coordinate mapping of the image modules in the event of moderate amounts
			* of distortion of the image.
			*
			* Alignment patterns are present only in QR Code symbols of version 2 or larger
			* and their number depends on the symbol version.
			*/
			const getSymbolSize = require_utils$1().getSymbolSize;
			/**
			* Calculate the row/column coordinates of the center module of each alignment pattern
			* for the specified QR Code version.
			*
			* The alignment patterns are positioned symmetrically on either side of the diagonal
			* running from the top left corner of the symbol to the bottom right corner.
			*
			* Since positions are simmetrical only half of the coordinates are returned.
			* Each item of the array will represent in turn the x and y coordinate.
			* @see {@link getPositions}
			*
			* @param  {Number} version QR Code version
			* @return {Array}          Array of coordinate
			*/
			exports.getRowColCoords = function getRowColCoords(version) {
				if (version === 1) return [];
				const posCount = Math.floor(version / 7) + 2;
				const size = getSymbolSize(version);
				const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
				const positions = [size - 7];
				for (let i = 1; i < posCount - 1; i++) positions[i] = positions[i - 1] - intervals;
				positions.push(6);
				return positions.reverse();
			};
			/**
			* Returns an array containing the positions of each alignment pattern.
			* Each array's element represent the center point of the pattern as (x, y) coordinates
			*
			* Coordinates are calculated expanding the row/column coordinates returned by {@link getRowColCoords}
			* and filtering out the items that overlaps with finder pattern
			*
			* @example
			* For a Version 7 symbol {@link getRowColCoords} returns values 6, 22 and 38.
			* The alignment patterns, therefore, are to be centered on (row, column)
			* positions (6,22), (22,6), (22,22), (22,38), (38,22), (38,38).
			* Note that the coordinates (6,6), (6,38), (38,6) are occupied by finder patterns
			* and are not therefore used for alignment patterns.
			*
			* let pos = getPositions(7)
			* // [[6,22], [22,6], [22,22], [22,38], [38,22], [38,38]]
			*
			* @param  {Number} version QR Code version
			* @return {Array}          Array of coordinates
			*/
			exports.getPositions = function getPositions(version) {
				const coords = [];
				const pos = exports.getRowColCoords(version);
				const posLength = pos.length;
				for (let i = 0; i < posLength; i++) for (let j = 0; j < posLength; j++) {
					if (i === 0 && j === 0 || i === 0 && j === posLength - 1 || i === posLength - 1 && j === 0) continue;
					coords.push([pos[i], pos[j]]);
				}
				return coords;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/finder-pattern.js
		var require_finder_pattern = /* @__PURE__ */ __commonJSMin(((exports) => {
			const getSymbolSize = require_utils$1().getSymbolSize;
			const FINDER_PATTERN_SIZE = 7;
			/**
			* Returns an array containing the positions of each finder pattern.
			* Each array's element represent the top-left point of the pattern as (x, y) coordinates
			*
			* @param  {Number} version QR Code version
			* @return {Array}          Array of coordinates
			*/
			exports.getPositions = function getPositions(version) {
				const size = getSymbolSize(version);
				return [
					[0, 0],
					[size - FINDER_PATTERN_SIZE, 0],
					[0, size - FINDER_PATTERN_SIZE]
				];
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/mask-pattern.js
		var require_mask_pattern = /* @__PURE__ */ __commonJSMin(((exports) => {
			/**
			* Data mask pattern reference
			* @type {Object}
			*/
			exports.Patterns = {
				PATTERN000: 0,
				PATTERN001: 1,
				PATTERN010: 2,
				PATTERN011: 3,
				PATTERN100: 4,
				PATTERN101: 5,
				PATTERN110: 6,
				PATTERN111: 7
			};
			/**
			* Weighted penalty scores for the undesirable features
			* @type {Object}
			*/
			const PenaltyScores = {
				N1: 3,
				N2: 3,
				N3: 40,
				N4: 10
			};
			/**
			* Check if mask pattern value is valid
			*
			* @param  {Number}  mask    Mask pattern
			* @return {Boolean}         true if valid, false otherwise
			*/
			exports.isValid = function isValid(mask) {
				return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
			};
			/**
			* Returns mask pattern from a value.
			* If value is not valid, returns undefined
			*
			* @param  {Number|String} value        Mask pattern value
			* @return {Number}                     Valid mask pattern or undefined
			*/
			exports.from = function from(value) {
				return exports.isValid(value) ? parseInt(value, 10) : void 0;
			};
			/**
			* Find adjacent modules in row/column with the same color
			* and assign a penalty value.
			*
			* Points: N1 + i
			* i is the amount by which the number of adjacent modules of the same color exceeds 5
			*/
			exports.getPenaltyN1 = function getPenaltyN1(data) {
				const size = data.size;
				let points = 0;
				let sameCountCol = 0;
				let sameCountRow = 0;
				let lastCol = null;
				let lastRow = null;
				for (let row = 0; row < size; row++) {
					sameCountCol = sameCountRow = 0;
					lastCol = lastRow = null;
					for (let col = 0; col < size; col++) {
						let module$1 = data.get(row, col);
						if (module$1 === lastCol) sameCountCol++;
						else {
							if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
							lastCol = module$1;
							sameCountCol = 1;
						}
						module$1 = data.get(col, row);
						if (module$1 === lastRow) sameCountRow++;
						else {
							if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
							lastRow = module$1;
							sameCountRow = 1;
						}
					}
					if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
					if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
				}
				return points;
			};
			/**
			* Find 2x2 blocks with the same color and assign a penalty value
			*
			* Points: N2 * (m - 1) * (n - 1)
			*/
			exports.getPenaltyN2 = function getPenaltyN2(data) {
				const size = data.size;
				let points = 0;
				for (let row = 0; row < size - 1; row++) for (let col = 0; col < size - 1; col++) {
					const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
					if (last === 4 || last === 0) points++;
				}
				return points * PenaltyScores.N2;
			};
			/**
			* Find 1:1:3:1:1 ratio (dark:light:dark:light:dark) pattern in row/column,
			* preceded or followed by light area 4 modules wide
			*
			* Points: N3 * number of pattern found
			*/
			exports.getPenaltyN3 = function getPenaltyN3(data) {
				const size = data.size;
				let points = 0;
				let bitsCol = 0;
				let bitsRow = 0;
				for (let row = 0; row < size; row++) {
					bitsCol = bitsRow = 0;
					for (let col = 0; col < size; col++) {
						bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
						if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
						bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
						if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
					}
				}
				return points * PenaltyScores.N3;
			};
			/**
			* Calculate proportion of dark modules in entire symbol
			*
			* Points: N4 * k
			*
			* k is the rating of the deviation of the proportion of dark modules
			* in the symbol from 50% in steps of 5%
			*/
			exports.getPenaltyN4 = function getPenaltyN4(data) {
				let darkCount = 0;
				const modulesCount = data.data.length;
				for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
				return Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10) * PenaltyScores.N4;
			};
			/**
			* Return mask value at given position
			*
			* @param  {Number} maskPattern Pattern reference value
			* @param  {Number} i           Row
			* @param  {Number} j           Column
			* @return {Boolean}            Mask value
			*/
			function getMaskAt(maskPattern, i, j) {
				switch (maskPattern) {
					case exports.Patterns.PATTERN000: return (i + j) % 2 === 0;
					case exports.Patterns.PATTERN001: return i % 2 === 0;
					case exports.Patterns.PATTERN010: return j % 3 === 0;
					case exports.Patterns.PATTERN011: return (i + j) % 3 === 0;
					case exports.Patterns.PATTERN100: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
					case exports.Patterns.PATTERN101: return i * j % 2 + i * j % 3 === 0;
					case exports.Patterns.PATTERN110: return (i * j % 2 + i * j % 3) % 2 === 0;
					case exports.Patterns.PATTERN111: return (i * j % 3 + (i + j) % 2) % 2 === 0;
					default: throw new Error("bad maskPattern:" + maskPattern);
				}
			}
			/**
			* Apply a mask pattern to a BitMatrix
			*
			* @param  {Number}    pattern Pattern reference number
			* @param  {BitMatrix} data    BitMatrix data
			*/
			exports.applyMask = function applyMask(pattern, data) {
				const size = data.size;
				for (let col = 0; col < size; col++) for (let row = 0; row < size; row++) {
					if (data.isReserved(row, col)) continue;
					data.xor(row, col, getMaskAt(pattern, row, col));
				}
			};
			/**
			* Returns the best mask pattern for data
			*
			* @param  {BitMatrix} data
			* @return {Number} Mask pattern reference number
			*/
			exports.getBestMask = function getBestMask(data, setupFormatFunc) {
				const numPatterns = Object.keys(exports.Patterns).length;
				let bestPattern = 0;
				let lowerPenalty = Infinity;
				for (let p = 0; p < numPatterns; p++) {
					setupFormatFunc(p);
					exports.applyMask(p, data);
					const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
					exports.applyMask(p, data);
					if (penalty < lowerPenalty) {
						lowerPenalty = penalty;
						bestPattern = p;
					}
				}
				return bestPattern;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/error-correction-code.js
		var require_error_correction_code = /* @__PURE__ */ __commonJSMin(((exports) => {
			const ECLevel = require_error_correction_level();
			const EC_BLOCKS_TABLE = [
				1,
				1,
				1,
				1,
				1,
				1,
				1,
				1,
				1,
				1,
				2,
				2,
				1,
				2,
				2,
				4,
				1,
				2,
				4,
				4,
				2,
				4,
				4,
				4,
				2,
				4,
				6,
				5,
				2,
				4,
				6,
				6,
				2,
				5,
				8,
				8,
				4,
				5,
				8,
				8,
				4,
				5,
				8,
				11,
				4,
				8,
				10,
				11,
				4,
				9,
				12,
				16,
				4,
				9,
				16,
				16,
				6,
				10,
				12,
				18,
				6,
				10,
				17,
				16,
				6,
				11,
				16,
				19,
				6,
				13,
				18,
				21,
				7,
				14,
				21,
				25,
				8,
				16,
				20,
				25,
				8,
				17,
				23,
				25,
				9,
				17,
				23,
				34,
				9,
				18,
				25,
				30,
				10,
				20,
				27,
				32,
				12,
				21,
				29,
				35,
				12,
				23,
				34,
				37,
				12,
				25,
				34,
				40,
				13,
				26,
				35,
				42,
				14,
				28,
				38,
				45,
				15,
				29,
				40,
				48,
				16,
				31,
				43,
				51,
				17,
				33,
				45,
				54,
				18,
				35,
				48,
				57,
				19,
				37,
				51,
				60,
				19,
				38,
				53,
				63,
				20,
				40,
				56,
				66,
				21,
				43,
				59,
				70,
				22,
				45,
				62,
				74,
				24,
				47,
				65,
				77,
				25,
				49,
				68,
				81
			];
			const EC_CODEWORDS_TABLE = [
				7,
				10,
				13,
				17,
				10,
				16,
				22,
				28,
				15,
				26,
				36,
				44,
				20,
				36,
				52,
				64,
				26,
				48,
				72,
				88,
				36,
				64,
				96,
				112,
				40,
				72,
				108,
				130,
				48,
				88,
				132,
				156,
				60,
				110,
				160,
				192,
				72,
				130,
				192,
				224,
				80,
				150,
				224,
				264,
				96,
				176,
				260,
				308,
				104,
				198,
				288,
				352,
				120,
				216,
				320,
				384,
				132,
				240,
				360,
				432,
				144,
				280,
				408,
				480,
				168,
				308,
				448,
				532,
				180,
				338,
				504,
				588,
				196,
				364,
				546,
				650,
				224,
				416,
				600,
				700,
				224,
				442,
				644,
				750,
				252,
				476,
				690,
				816,
				270,
				504,
				750,
				900,
				300,
				560,
				810,
				960,
				312,
				588,
				870,
				1050,
				336,
				644,
				952,
				1110,
				360,
				700,
				1020,
				1200,
				390,
				728,
				1050,
				1260,
				420,
				784,
				1140,
				1350,
				450,
				812,
				1200,
				1440,
				480,
				868,
				1290,
				1530,
				510,
				924,
				1350,
				1620,
				540,
				980,
				1440,
				1710,
				570,
				1036,
				1530,
				1800,
				570,
				1064,
				1590,
				1890,
				600,
				1120,
				1680,
				1980,
				630,
				1204,
				1770,
				2100,
				660,
				1260,
				1860,
				2220,
				720,
				1316,
				1950,
				2310,
				750,
				1372,
				2040,
				2430
			];
			/**
			* Returns the number of error correction block that the QR Code should contain
			* for the specified version and error correction level.
			*
			* @param  {Number} version              QR Code version
			* @param  {Number} errorCorrectionLevel Error correction level
			* @return {Number}                      Number of error correction blocks
			*/
			exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
				switch (errorCorrectionLevel) {
					case ECLevel.L: return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
					case ECLevel.M: return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
					case ECLevel.Q: return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
					case ECLevel.H: return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
					default: return;
				}
			};
			/**
			* Returns the number of error correction codewords to use for the specified
			* version and error correction level.
			*
			* @param  {Number} version              QR Code version
			* @param  {Number} errorCorrectionLevel Error correction level
			* @return {Number}                      Number of error correction codewords
			*/
			exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
				switch (errorCorrectionLevel) {
					case ECLevel.L: return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
					case ECLevel.M: return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
					case ECLevel.Q: return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
					case ECLevel.H: return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
					default: return;
				}
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/galois-field.js
		var require_galois_field = /* @__PURE__ */ __commonJSMin(((exports) => {
			const EXP_TABLE = /* @__PURE__ */ new Uint8Array(512);
			const LOG_TABLE = /* @__PURE__ */ new Uint8Array(256);
			(function initTables() {
				let x = 1;
				for (let i = 0; i < 255; i++) {
					EXP_TABLE[i] = x;
					LOG_TABLE[x] = i;
					x <<= 1;
					if (x & 256) x ^= 285;
				}
				for (let i = 255; i < 512; i++) EXP_TABLE[i] = EXP_TABLE[i - 255];
			})();
			/**
			* Returns log value of n inside Galois Field
			*
			* @param  {Number} n
			* @return {Number}
			*/
			exports.log = function log(n) {
				if (n < 1) throw new Error("log(" + n + ")");
				return LOG_TABLE[n];
			};
			/**
			* Returns anti-log value of n inside Galois Field
			*
			* @param  {Number} n
			* @return {Number}
			*/
			exports.exp = function exp(n) {
				return EXP_TABLE[n];
			};
			/**
			* Multiplies two number inside Galois Field
			*
			* @param  {Number} x
			* @param  {Number} y
			* @return {Number}
			*/
			exports.mul = function mul(x, y) {
				if (x === 0 || y === 0) return 0;
				return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/polynomial.js
		var require_polynomial = /* @__PURE__ */ __commonJSMin(((exports) => {
			const GF = require_galois_field();
			/**
			* Multiplies two polynomials inside Galois Field
			*
			* @param  {Uint8Array} p1 Polynomial
			* @param  {Uint8Array} p2 Polynomial
			* @return {Uint8Array}    Product of p1 and p2
			*/
			exports.mul = function mul(p1, p2) {
				const coeff = new Uint8Array(p1.length + p2.length - 1);
				for (let i = 0; i < p1.length; i++) for (let j = 0; j < p2.length; j++) coeff[i + j] ^= GF.mul(p1[i], p2[j]);
				return coeff;
			};
			/**
			* Calculate the remainder of polynomials division
			*
			* @param  {Uint8Array} divident Polynomial
			* @param  {Uint8Array} divisor  Polynomial
			* @return {Uint8Array}          Remainder
			*/
			exports.mod = function mod(divident, divisor) {
				let result = new Uint8Array(divident);
				while (result.length - divisor.length >= 0) {
					const coeff = result[0];
					for (let i = 0; i < divisor.length; i++) result[i] ^= GF.mul(divisor[i], coeff);
					let offset = 0;
					while (offset < result.length && result[offset] === 0) offset++;
					result = result.slice(offset);
				}
				return result;
			};
			/**
			* Generate an irreducible generator polynomial of specified degree
			* (used by Reed-Solomon encoder)
			*
			* @param  {Number} degree Degree of the generator polynomial
			* @return {Uint8Array}    Buffer containing polynomial coefficients
			*/
			exports.generateECPolynomial = function generateECPolynomial(degree) {
				let poly = new Uint8Array([1]);
				for (let i = 0; i < degree; i++) poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
				return poly;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/reed-solomon-encoder.js
		var require_reed_solomon_encoder = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const Polynomial = require_polynomial();
			function ReedSolomonEncoder(degree) {
				this.genPoly = void 0;
				this.degree = degree;
				if (this.degree) this.initialize(this.degree);
			}
			/**
			* Initialize the encoder.
			* The input param should correspond to the number of error correction codewords.
			*
			* @param  {Number} degree
			*/
			ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
				this.degree = degree;
				this.genPoly = Polynomial.generateECPolynomial(this.degree);
			};
			/**
			* Encodes a chunk of data
			*
			* @param  {Uint8Array} data Buffer containing input data
			* @return {Uint8Array}      Buffer containing encoded data
			*/
			ReedSolomonEncoder.prototype.encode = function encode(data) {
				if (!this.genPoly) throw new Error("Encoder not initialized");
				const paddedData = new Uint8Array(data.length + this.degree);
				paddedData.set(data);
				const remainder = Polynomial.mod(paddedData, this.genPoly);
				const start = this.degree - remainder.length;
				if (start > 0) {
					const buff = new Uint8Array(this.degree);
					buff.set(remainder, start);
					return buff;
				}
				return remainder;
			};
			module.exports = ReedSolomonEncoder;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/version-check.js
		var require_version_check = /* @__PURE__ */ __commonJSMin(((exports) => {
			/**
			* Check if QR Code version is valid
			*
			* @param  {Number}  version QR Code version
			* @return {Boolean}         true if valid version, false otherwise
			*/
			exports.isValid = function isValid(version) {
				return !isNaN(version) && version >= 1 && version <= 40;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/regex.js
		var require_regex = /* @__PURE__ */ __commonJSMin(((exports) => {
			const numeric = "[0-9]+";
			const alphanumeric = "[A-Z $%*+\\-./:]+";
			let kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
			kanji = kanji.replace(/u/g, "\\u");
			const byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
			exports.KANJI = new RegExp(kanji, "g");
			exports.BYTE_KANJI = /* @__PURE__ */ new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
			exports.BYTE = new RegExp(byte, "g");
			exports.NUMERIC = new RegExp(numeric, "g");
			exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
			const TEST_KANJI = new RegExp("^" + kanji + "$");
			const TEST_NUMERIC = /* @__PURE__ */ new RegExp("^[0-9]+$");
			const TEST_ALPHANUMERIC = /* @__PURE__ */ new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
			exports.testKanji = function testKanji(str) {
				return TEST_KANJI.test(str);
			};
			exports.testNumeric = function testNumeric(str) {
				return TEST_NUMERIC.test(str);
			};
			exports.testAlphanumeric = function testAlphanumeric(str) {
				return TEST_ALPHANUMERIC.test(str);
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/mode.js
		var require_mode = /* @__PURE__ */ __commonJSMin(((exports) => {
			const VersionCheck = require_version_check();
			const Regex = require_regex();
			/**
			* Numeric mode encodes data from the decimal digit set (0 - 9)
			* (byte values 30HEX to 39HEX).
			* Normally, 3 data characters are represented by 10 bits.
			*
			* @type {Object}
			*/
			exports.NUMERIC = {
				id: "Numeric",
				bit: 1,
				ccBits: [
					10,
					12,
					14
				]
			};
			/**
			* Alphanumeric mode encodes data from a set of 45 characters,
			* i.e. 10 numeric digits (0 - 9),
			*      26 alphabetic characters (A - Z),
			*   and 9 symbols (SP, $, %, *, +, -, ., /, :).
			* Normally, two input characters are represented by 11 bits.
			*
			* @type {Object}
			*/
			exports.ALPHANUMERIC = {
				id: "Alphanumeric",
				bit: 2,
				ccBits: [
					9,
					11,
					13
				]
			};
			/**
			* In byte mode, data is encoded at 8 bits per character.
			*
			* @type {Object}
			*/
			exports.BYTE = {
				id: "Byte",
				bit: 4,
				ccBits: [
					8,
					16,
					16
				]
			};
			/**
			* The Kanji mode efficiently encodes Kanji characters in accordance with
			* the Shift JIS system based on JIS X 0208.
			* The Shift JIS values are shifted from the JIS X 0208 values.
			* JIS X 0208 gives details of the shift coded representation.
			* Each two-byte character value is compacted to a 13-bit binary codeword.
			*
			* @type {Object}
			*/
			exports.KANJI = {
				id: "Kanji",
				bit: 8,
				ccBits: [
					8,
					10,
					12
				]
			};
			/**
			* Mixed mode will contain a sequences of data in a combination of any of
			* the modes described above
			*
			* @type {Object}
			*/
			exports.MIXED = { bit: -1 };
			/**
			* Returns the number of bits needed to store the data length
			* according to QR Code specifications.
			*
			* @param  {Mode}   mode    Data mode
			* @param  {Number} version QR Code version
			* @return {Number}         Number of bits
			*/
			exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
				if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
				if (!VersionCheck.isValid(version)) throw new Error("Invalid version: " + version);
				if (version >= 1 && version < 10) return mode.ccBits[0];
				else if (version < 27) return mode.ccBits[1];
				return mode.ccBits[2];
			};
			/**
			* Returns the most efficient mode to store the specified data
			*
			* @param  {String} dataStr Input data string
			* @return {Mode}           Best mode
			*/
			exports.getBestModeForData = function getBestModeForData(dataStr) {
				if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
				else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
				else if (Regex.testKanji(dataStr)) return exports.KANJI;
				else return exports.BYTE;
			};
			/**
			* Return mode name as string
			*
			* @param {Mode} mode Mode object
			* @returns {String}  Mode name
			*/
			exports.toString = function toString(mode) {
				if (mode && mode.id) return mode.id;
				throw new Error("Invalid mode");
			};
			/**
			* Check if input param is a valid mode object
			*
			* @param   {Mode}    mode Mode object
			* @returns {Boolean} True if valid mode, false otherwise
			*/
			exports.isValid = function isValid(mode) {
				return mode && mode.bit && mode.ccBits;
			};
			/**
			* Get mode object from its name
			*
			* @param   {String} string Mode name
			* @returns {Mode}          Mode object
			*/
			function fromString(string) {
				if (typeof string !== "string") throw new Error("Param is not a string");
				switch (string.toLowerCase()) {
					case "numeric": return exports.NUMERIC;
					case "alphanumeric": return exports.ALPHANUMERIC;
					case "kanji": return exports.KANJI;
					case "byte": return exports.BYTE;
					default: throw new Error("Unknown mode: " + string);
				}
			}
			/**
			* Returns mode from a value.
			* If value is not a valid mode, returns defaultValue
			*
			* @param  {Mode|String} value        Encoding mode
			* @param  {Mode}        defaultValue Fallback value
			* @return {Mode}                     Encoding mode
			*/
			exports.from = function from(value, defaultValue) {
				if (exports.isValid(value)) return value;
				try {
					return fromString(value);
				} catch (e) {
					return defaultValue;
				}
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/version.js
		var require_version = /* @__PURE__ */ __commonJSMin(((exports) => {
			const Utils = require_utils$1();
			const ECCode = require_error_correction_code();
			const ECLevel = require_error_correction_level();
			const Mode = require_mode();
			const VersionCheck = require_version_check();
			const G18 = 7973;
			const G18_BCH = Utils.getBCHDigit(G18);
			function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
				for (let currentVersion = 1; currentVersion <= 40; currentVersion++) if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) return currentVersion;
			}
			function getReservedBitsCount(mode, version) {
				return Mode.getCharCountIndicator(mode, version) + 4;
			}
			function getTotalBitsFromDataArray(segments, version) {
				let totalBits = 0;
				segments.forEach(function(data) {
					const reservedBits = getReservedBitsCount(data.mode, version);
					totalBits += reservedBits + data.getBitsLength();
				});
				return totalBits;
			}
			function getBestVersionForMixedData(segments, errorCorrectionLevel) {
				for (let currentVersion = 1; currentVersion <= 40; currentVersion++) if (getTotalBitsFromDataArray(segments, currentVersion) <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) return currentVersion;
			}
			/**
			* Returns version number from a value.
			* If value is not a valid version, returns defaultValue
			*
			* @param  {Number|String} value        QR Code version
			* @param  {Number}        defaultValue Fallback value
			* @return {Number}                     QR Code version number
			*/
			exports.from = function from(value, defaultValue) {
				if (VersionCheck.isValid(value)) return parseInt(value, 10);
				return defaultValue;
			};
			/**
			* Returns how much data can be stored with the specified QR code version
			* and error correction level
			*
			* @param  {Number} version              QR Code version (1-40)
			* @param  {Number} errorCorrectionLevel Error correction level
			* @param  {Mode}   mode                 Data mode
			* @return {Number}                      Quantity of storable data
			*/
			exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
				if (!VersionCheck.isValid(version)) throw new Error("Invalid QR Code version");
				if (typeof mode === "undefined") mode = Mode.BYTE;
				const dataTotalCodewordsBits = (Utils.getSymbolTotalCodewords(version) - ECCode.getTotalCodewordsCount(version, errorCorrectionLevel)) * 8;
				if (mode === Mode.MIXED) return dataTotalCodewordsBits;
				const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
				switch (mode) {
					case Mode.NUMERIC: return Math.floor(usableBits / 10 * 3);
					case Mode.ALPHANUMERIC: return Math.floor(usableBits / 11 * 2);
					case Mode.KANJI: return Math.floor(usableBits / 13);
					case Mode.BYTE:
					default: return Math.floor(usableBits / 8);
				}
			};
			/**
			* Returns the minimum version needed to contain the amount of data
			*
			* @param  {Segment} data                    Segment of data
			* @param  {Number} [errorCorrectionLevel=H] Error correction level
			* @param  {Mode} mode                       Data mode
			* @return {Number}                          QR Code version
			*/
			exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
				let seg;
				const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
				if (Array.isArray(data)) {
					if (data.length > 1) return getBestVersionForMixedData(data, ecl);
					if (data.length === 0) return 1;
					seg = data[0];
				} else seg = data;
				return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
			};
			/**
			* Returns version information with relative error correction bits
			*
			* The version information is included in QR Code symbols of version 7 or larger.
			* It consists of an 18-bit sequence containing 6 data bits,
			* with 12 error correction bits calculated using the (18, 6) Golay code.
			*
			* @param  {Number} version QR Code version
			* @return {Number}         Encoded version info bits
			*/
			exports.getEncodedBits = function getEncodedBits(version) {
				if (!VersionCheck.isValid(version) || version < 7) throw new Error("Invalid QR Code version");
				let d = version << 12;
				while (Utils.getBCHDigit(d) - G18_BCH >= 0) d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
				return version << 12 | d;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/format-info.js
		var require_format_info = /* @__PURE__ */ __commonJSMin(((exports) => {
			const Utils = require_utils$1();
			const G15 = 1335;
			const G15_MASK = 21522;
			const G15_BCH = Utils.getBCHDigit(G15);
			/**
			* Returns format information with relative error correction bits
			*
			* The format information is a 15-bit sequence containing 5 data bits,
			* with 10 error correction bits calculated using the (15, 5) BCH code.
			*
			* @param  {Number} errorCorrectionLevel Error correction level
			* @param  {Number} mask                 Mask pattern
			* @return {Number}                      Encoded format information bits
			*/
			exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
				const data = errorCorrectionLevel.bit << 3 | mask;
				let d = data << 10;
				while (Utils.getBCHDigit(d) - G15_BCH >= 0) d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
				return (data << 10 | d) ^ G15_MASK;
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/numeric-data.js
		var require_numeric_data = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const Mode = require_mode();
			function NumericData(data) {
				this.mode = Mode.NUMERIC;
				this.data = data.toString();
			}
			NumericData.getBitsLength = function getBitsLength(length) {
				return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
			};
			NumericData.prototype.getLength = function getLength() {
				return this.data.length;
			};
			NumericData.prototype.getBitsLength = function getBitsLength() {
				return NumericData.getBitsLength(this.data.length);
			};
			NumericData.prototype.write = function write(bitBuffer) {
				let i, group, value;
				for (i = 0; i + 3 <= this.data.length; i += 3) {
					group = this.data.substr(i, 3);
					value = parseInt(group, 10);
					bitBuffer.put(value, 10);
				}
				const remainingNum = this.data.length - i;
				if (remainingNum > 0) {
					group = this.data.substr(i);
					value = parseInt(group, 10);
					bitBuffer.put(value, remainingNum * 3 + 1);
				}
			};
			module.exports = NumericData;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/alphanumeric-data.js
		var require_alphanumeric_data = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const Mode = require_mode();
			/**
			* Array of characters available in alphanumeric mode
			*
			* As per QR Code specification, to each character
			* is assigned a value from 0 to 44 which in this case coincides
			* with the array index
			*
			* @type {Array}
			*/
			const ALPHA_NUM_CHARS = [
				"0",
				"1",
				"2",
				"3",
				"4",
				"5",
				"6",
				"7",
				"8",
				"9",
				"A",
				"B",
				"C",
				"D",
				"E",
				"F",
				"G",
				"H",
				"I",
				"J",
				"K",
				"L",
				"M",
				"N",
				"O",
				"P",
				"Q",
				"R",
				"S",
				"T",
				"U",
				"V",
				"W",
				"X",
				"Y",
				"Z",
				" ",
				"$",
				"%",
				"*",
				"+",
				"-",
				".",
				"/",
				":"
			];
			function AlphanumericData(data) {
				this.mode = Mode.ALPHANUMERIC;
				this.data = data;
			}
			AlphanumericData.getBitsLength = function getBitsLength(length) {
				return 11 * Math.floor(length / 2) + 6 * (length % 2);
			};
			AlphanumericData.prototype.getLength = function getLength() {
				return this.data.length;
			};
			AlphanumericData.prototype.getBitsLength = function getBitsLength() {
				return AlphanumericData.getBitsLength(this.data.length);
			};
			AlphanumericData.prototype.write = function write(bitBuffer) {
				let i;
				for (i = 0; i + 2 <= this.data.length; i += 2) {
					let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
					value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
					bitBuffer.put(value, 11);
				}
				if (this.data.length % 2) bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
			};
			module.exports = AlphanumericData;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/byte-data.js
		var require_byte_data = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const Mode = require_mode();
			function ByteData(data) {
				this.mode = Mode.BYTE;
				if (typeof data === "string") this.data = new TextEncoder().encode(data);
				else this.data = new Uint8Array(data);
			}
			ByteData.getBitsLength = function getBitsLength(length) {
				return length * 8;
			};
			ByteData.prototype.getLength = function getLength() {
				return this.data.length;
			};
			ByteData.prototype.getBitsLength = function getBitsLength() {
				return ByteData.getBitsLength(this.data.length);
			};
			ByteData.prototype.write = function(bitBuffer) {
				for (let i = 0, l = this.data.length; i < l; i++) bitBuffer.put(this.data[i], 8);
			};
			module.exports = ByteData;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/kanji-data.js
		var require_kanji_data = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			const Mode = require_mode();
			const Utils = require_utils$1();
			function KanjiData(data) {
				this.mode = Mode.KANJI;
				this.data = data;
			}
			KanjiData.getBitsLength = function getBitsLength(length) {
				return length * 13;
			};
			KanjiData.prototype.getLength = function getLength() {
				return this.data.length;
			};
			KanjiData.prototype.getBitsLength = function getBitsLength() {
				return KanjiData.getBitsLength(this.data.length);
			};
			KanjiData.prototype.write = function(bitBuffer) {
				let i;
				for (i = 0; i < this.data.length; i++) {
					let value = Utils.toSJIS(this.data[i]);
					if (value >= 33088 && value <= 40956) value -= 33088;
					else if (value >= 57408 && value <= 60351) value -= 49472;
					else throw new Error("Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8");
					value = (value >>> 8 & 255) * 192 + (value & 255);
					bitBuffer.put(value, 13);
				}
			};
			module.exports = KanjiData;
		}));
		//#endregion
		//#region node_modules/dijkstrajs/dijkstra.js
		var require_dijkstra = /* @__PURE__ */ __commonJSMin(((exports, module) => {
			/******************************************************************************
			* Created 2008-08-19.
			*
			* Dijkstra path-finding functions. Adapted from the Dijkstar Python project.
			*
			* Copyright (C) 2008
			*   Wyatt Baldwin <self@wyattbaldwin.com>
			*   All rights reserved
			*
			* Licensed under the MIT license.
			*
			*   http://www.opensource.org/licenses/mit-license.php
			*
			* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
			* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
			* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
			* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
			* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
			* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
			* THE SOFTWARE.
			*****************************************************************************/
			var dijkstra = {
				single_source_shortest_paths: function(graph, s, d) {
					var predecessors = {};
					var costs = {};
					costs[s] = 0;
					var open = dijkstra.PriorityQueue.make();
					open.push(s, 0);
					var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
					while (!open.empty()) {
						closest = open.pop();
						u = closest.value;
						cost_of_s_to_u = closest.cost;
						adjacent_nodes = graph[u] || {};
						for (v in adjacent_nodes) if (adjacent_nodes.hasOwnProperty(v)) {
							cost_of_e = adjacent_nodes[v];
							cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
							cost_of_s_to_v = costs[v];
							first_visit = typeof costs[v] === "undefined";
							if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
								costs[v] = cost_of_s_to_u_plus_cost_of_e;
								open.push(v, cost_of_s_to_u_plus_cost_of_e);
								predecessors[v] = u;
							}
						}
					}
					if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
						var msg = [
							"Could not find a path from ",
							s,
							" to ",
							d,
							"."
						].join("");
						throw new Error(msg);
					}
					return predecessors;
				},
				extract_shortest_path_from_predecessor_list: function(predecessors, d) {
					var nodes = [];
					var u = d;
					while (u) {
						nodes.push(u);
						predecessors[u];
						u = predecessors[u];
					}
					nodes.reverse();
					return nodes;
				},
				find_path: function(graph, s, d) {
					var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
					return dijkstra.extract_shortest_path_from_predecessor_list(predecessors, d);
				},
				/**
				* A very naive priority queue implementation.
				*/
				PriorityQueue: {
					make: function(opts) {
						var T = dijkstra.PriorityQueue, t = {}, key;
						opts = opts || {};
						for (key in T) if (T.hasOwnProperty(key)) t[key] = T[key];
						t.queue = [];
						t.sorter = opts.sorter || T.default_sorter;
						return t;
					},
					default_sorter: function(a, b) {
						return a.cost - b.cost;
					},
					/**
					* Add a new item to the queue and ensure the highest priority element
					* is at the front of the queue.
					*/
					push: function(value, cost) {
						var item = {
							value,
							cost
						};
						this.queue.push(item);
						this.queue.sort(this.sorter);
					},
					/**
					* Return the highest priority element in the queue.
					*/
					pop: function() {
						return this.queue.shift();
					},
					empty: function() {
						return this.queue.length === 0;
					}
				}
			};
			if (typeof module !== "undefined") module.exports = dijkstra;
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/segments.js
		var require_segments = /* @__PURE__ */ __commonJSMin(((exports) => {
			const Mode = require_mode();
			const NumericData = require_numeric_data();
			const AlphanumericData = require_alphanumeric_data();
			const ByteData = require_byte_data();
			const KanjiData = require_kanji_data();
			const Regex = require_regex();
			const Utils = require_utils$1();
			const dijkstra = require_dijkstra();
			/**
			* Returns UTF8 byte length
			*
			* @param  {String} str Input string
			* @return {Number}     Number of byte
			*/
			function getStringByteLength(str) {
				return unescape(encodeURIComponent(str)).length;
			}
			/**
			* Get a list of segments of the specified mode
			* from a string
			*
			* @param  {Mode}   mode Segment mode
			* @param  {String} str  String to process
			* @return {Array}       Array of object with segments data
			*/
			function getSegments(regex, mode, str) {
				const segments = [];
				let result;
				while ((result = regex.exec(str)) !== null) segments.push({
					data: result[0],
					index: result.index,
					mode,
					length: result[0].length
				});
				return segments;
			}
			/**
			* Extracts a series of segments with the appropriate
			* modes from a string
			*
			* @param  {String} dataStr Input string
			* @return {Array}          Array of object with segments data
			*/
			function getSegmentsFromString(dataStr) {
				const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
				const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
				let byteSegs;
				let kanjiSegs;
				if (Utils.isKanjiModeEnabled()) {
					byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
					kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
				} else {
					byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
					kanjiSegs = [];
				}
				return numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs).sort(function(s1, s2) {
					return s1.index - s2.index;
				}).map(function(obj) {
					return {
						data: obj.data,
						mode: obj.mode,
						length: obj.length
					};
				});
			}
			/**
			* Returns how many bits are needed to encode a string of
			* specified length with the specified mode
			*
			* @param  {Number} length String length
			* @param  {Mode} mode     Segment mode
			* @return {Number}        Bit length
			*/
			function getSegmentBitsLength(length, mode) {
				switch (mode) {
					case Mode.NUMERIC: return NumericData.getBitsLength(length);
					case Mode.ALPHANUMERIC: return AlphanumericData.getBitsLength(length);
					case Mode.KANJI: return KanjiData.getBitsLength(length);
					case Mode.BYTE: return ByteData.getBitsLength(length);
				}
			}
			/**
			* Merges adjacent segments which have the same mode
			*
			* @param  {Array} segs Array of object with segments data
			* @return {Array}      Array of object with segments data
			*/
			function mergeSegments(segs) {
				return segs.reduce(function(acc, curr) {
					const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
					if (prevSeg && prevSeg.mode === curr.mode) {
						acc[acc.length - 1].data += curr.data;
						return acc;
					}
					acc.push(curr);
					return acc;
				}, []);
			}
			/**
			* Generates a list of all possible nodes combination which
			* will be used to build a segments graph.
			*
			* Nodes are divided by groups. Each group will contain a list of all the modes
			* in which is possible to encode the given text.
			*
			* For example the text '12345' can be encoded as Numeric, Alphanumeric or Byte.
			* The group for '12345' will contain then 3 objects, one for each
			* possible encoding mode.
			*
			* Each node represents a possible segment.
			*
			* @param  {Array} segs Array of object with segments data
			* @return {Array}      Array of object with segments data
			*/
			function buildNodes(segs) {
				const nodes = [];
				for (let i = 0; i < segs.length; i++) {
					const seg = segs[i];
					switch (seg.mode) {
						case Mode.NUMERIC:
							nodes.push([
								seg,
								{
									data: seg.data,
									mode: Mode.ALPHANUMERIC,
									length: seg.length
								},
								{
									data: seg.data,
									mode: Mode.BYTE,
									length: seg.length
								}
							]);
							break;
						case Mode.ALPHANUMERIC:
							nodes.push([seg, {
								data: seg.data,
								mode: Mode.BYTE,
								length: seg.length
							}]);
							break;
						case Mode.KANJI:
							nodes.push([seg, {
								data: seg.data,
								mode: Mode.BYTE,
								length: getStringByteLength(seg.data)
							}]);
							break;
						case Mode.BYTE: nodes.push([{
							data: seg.data,
							mode: Mode.BYTE,
							length: getStringByteLength(seg.data)
						}]);
					}
				}
				return nodes;
			}
			/**
			* Builds a graph from a list of nodes.
			* All segments in each node group will be connected with all the segments of
			* the next group and so on.
			*
			* At each connection will be assigned a weight depending on the
			* segment's byte length.
			*
			* @param  {Array} nodes    Array of object with segments data
			* @param  {Number} version QR Code version
			* @return {Object}         Graph of all possible segments
			*/
			function buildGraph(nodes, version) {
				const table = {};
				const graph = { start: {} };
				let prevNodeIds = ["start"];
				for (let i = 0; i < nodes.length; i++) {
					const nodeGroup = nodes[i];
					const currentNodeIds = [];
					for (let j = 0; j < nodeGroup.length; j++) {
						const node = nodeGroup[j];
						const key = "" + i + j;
						currentNodeIds.push(key);
						table[key] = {
							node,
							lastCount: 0
						};
						graph[key] = {};
						for (let n = 0; n < prevNodeIds.length; n++) {
							const prevNodeId = prevNodeIds[n];
							if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
								graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
								table[prevNodeId].lastCount += node.length;
							} else {
								if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
								graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
							}
						}
					}
					prevNodeIds = currentNodeIds;
				}
				for (let n = 0; n < prevNodeIds.length; n++) graph[prevNodeIds[n]].end = 0;
				return {
					map: graph,
					table
				};
			}
			/**
			* Builds a segment from a specified data and mode.
			* If a mode is not specified, the more suitable will be used.
			*
			* @param  {String} data             Input data
			* @param  {Mode | String} modesHint Data mode
			* @return {Segment}                 Segment
			*/
			function buildSingleSegment(data, modesHint) {
				let mode;
				const bestMode = Mode.getBestModeForData(data);
				mode = Mode.from(modesHint, bestMode);
				if (mode !== Mode.BYTE && mode.bit < bestMode.bit) throw new Error("\"" + data + "\" cannot be encoded with mode " + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
				if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) mode = Mode.BYTE;
				switch (mode) {
					case Mode.NUMERIC: return new NumericData(data);
					case Mode.ALPHANUMERIC: return new AlphanumericData(data);
					case Mode.KANJI: return new KanjiData(data);
					case Mode.BYTE: return new ByteData(data);
				}
			}
			/**
			* Builds a list of segments from an array.
			* Array can contain Strings or Objects with segment's info.
			*
			* For each item which is a string, will be generated a segment with the given
			* string and the more appropriate encoding mode.
			*
			* For each item which is an object, will be generated a segment with the given
			* data and mode.
			* Objects must contain at least the property "data".
			* If property "mode" is not present, the more suitable mode will be used.
			*
			* @param  {Array} array Array of objects with segments data
			* @return {Array}       Array of Segments
			*/
			exports.fromArray = function fromArray(array) {
				return array.reduce(function(acc, seg) {
					if (typeof seg === "string") acc.push(buildSingleSegment(seg, null));
					else if (seg.data) acc.push(buildSingleSegment(seg.data, seg.mode));
					return acc;
				}, []);
			};
			/**
			* Builds an optimized sequence of segments from a string,
			* which will produce the shortest possible bitstream.
			*
			* @param  {String} data    Input string
			* @param  {Number} version QR Code version
			* @return {Array}          Array of segments
			*/
			exports.fromString = function fromString(data, version) {
				const graph = buildGraph(buildNodes(getSegmentsFromString(data, Utils.isKanjiModeEnabled())), version);
				const path = dijkstra.find_path(graph.map, "start", "end");
				const optimizedSegs = [];
				for (let i = 1; i < path.length - 1; i++) optimizedSegs.push(graph.table[path[i]].node);
				return exports.fromArray(mergeSegments(optimizedSegs));
			};
			/**
			* Splits a string in various segments with the modes which
			* best represent their content.
			* The produced segments are far from being optimized.
			* The output of this function is only used to estimate a QR Code version
			* which may contain the data.
			*
			* @param  {string} data Input string
			* @return {Array}       Array of segments
			*/
			exports.rawSplit = function rawSplit(data) {
				return exports.fromArray(getSegmentsFromString(data, Utils.isKanjiModeEnabled()));
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/core/qrcode.js
		var require_qrcode = /* @__PURE__ */ __commonJSMin(((exports) => {
			const Utils = require_utils$1();
			const ECLevel = require_error_correction_level();
			const BitBuffer = require_bit_buffer();
			const BitMatrix = require_bit_matrix();
			const AlignmentPattern = require_alignment_pattern();
			const FinderPattern = require_finder_pattern();
			const MaskPattern = require_mask_pattern();
			const ECCode = require_error_correction_code();
			const ReedSolomonEncoder = require_reed_solomon_encoder();
			const Version = require_version();
			const FormatInfo = require_format_info();
			const Mode = require_mode();
			const Segments = require_segments();
			/**
			* QRCode for JavaScript
			*
			* modified by Ryan Day for nodejs support
			* Copyright (c) 2011 Ryan Day
			*
			* Licensed under the MIT license:
			*   http://www.opensource.org/licenses/mit-license.php
			*
			//---------------------------------------------------------------------
			// QRCode for JavaScript
			//
			// Copyright (c) 2009 Kazuhiko Arase
			//
			// URL: http://www.d-project.com/
			//
			// Licensed under the MIT license:
			//   http://www.opensource.org/licenses/mit-license.php
			//
			// The word "QR Code" is registered trademark of
			// DENSO WAVE INCORPORATED
			//   http://www.denso-wave.com/qrcode/faqpatent-e.html
			//
			//---------------------------------------------------------------------
			*/
			/**
			* Add finder patterns bits to matrix
			*
			* @param  {BitMatrix} matrix  Modules matrix
			* @param  {Number}    version QR Code version
			*/
			function setupFinderPattern(matrix, version) {
				const size = matrix.size;
				const pos = FinderPattern.getPositions(version);
				for (let i = 0; i < pos.length; i++) {
					const row = pos[i][0];
					const col = pos[i][1];
					for (let r = -1; r <= 7; r++) {
						if (row + r <= -1 || size <= row + r) continue;
						for (let c = -1; c <= 7; c++) {
							if (col + c <= -1 || size <= col + c) continue;
							if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) matrix.set(row + r, col + c, true, true);
							else matrix.set(row + r, col + c, false, true);
						}
					}
				}
			}
			/**
			* Add timing pattern bits to matrix
			*
			* Note: this function must be called before {@link setupAlignmentPattern}
			*
			* @param  {BitMatrix} matrix Modules matrix
			*/
			function setupTimingPattern(matrix) {
				const size = matrix.size;
				for (let r = 8; r < size - 8; r++) {
					const value = r % 2 === 0;
					matrix.set(r, 6, value, true);
					matrix.set(6, r, value, true);
				}
			}
			/**
			* Add alignment patterns bits to matrix
			*
			* Note: this function must be called after {@link setupTimingPattern}
			*
			* @param  {BitMatrix} matrix  Modules matrix
			* @param  {Number}    version QR Code version
			*/
			function setupAlignmentPattern(matrix, version) {
				const pos = AlignmentPattern.getPositions(version);
				for (let i = 0; i < pos.length; i++) {
					const row = pos[i][0];
					const col = pos[i][1];
					for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) matrix.set(row + r, col + c, true, true);
					else matrix.set(row + r, col + c, false, true);
				}
			}
			/**
			* Add version info bits to matrix
			*
			* @param  {BitMatrix} matrix  Modules matrix
			* @param  {Number}    version QR Code version
			*/
			function setupVersionInfo(matrix, version) {
				const size = matrix.size;
				const bits = Version.getEncodedBits(version);
				let row, col, mod;
				for (let i = 0; i < 18; i++) {
					row = Math.floor(i / 3);
					col = i % 3 + size - 8 - 3;
					mod = (bits >> i & 1) === 1;
					matrix.set(row, col, mod, true);
					matrix.set(col, row, mod, true);
				}
			}
			/**
			* Add format info bits to matrix
			*
			* @param  {BitMatrix} matrix               Modules matrix
			* @param  {ErrorCorrectionLevel}    errorCorrectionLevel Error correction level
			* @param  {Number}    maskPattern          Mask pattern reference value
			*/
			function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
				const size = matrix.size;
				const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
				let i, mod;
				for (i = 0; i < 15; i++) {
					mod = (bits >> i & 1) === 1;
					if (i < 6) matrix.set(i, 8, mod, true);
					else if (i < 8) matrix.set(i + 1, 8, mod, true);
					else matrix.set(size - 15 + i, 8, mod, true);
					if (i < 8) matrix.set(8, size - i - 1, mod, true);
					else if (i < 9) matrix.set(8, 15 - i - 1 + 1, mod, true);
					else matrix.set(8, 15 - i - 1, mod, true);
				}
				matrix.set(size - 8, 8, 1, true);
			}
			/**
			* Add encoded data bits to matrix
			*
			* @param  {BitMatrix}  matrix Modules matrix
			* @param  {Uint8Array} data   Data codewords
			*/
			function setupData(matrix, data) {
				const size = matrix.size;
				let inc = -1;
				let row = size - 1;
				let bitIndex = 7;
				let byteIndex = 0;
				for (let col = size - 1; col > 0; col -= 2) {
					if (col === 6) col--;
					while (true) {
						for (let c = 0; c < 2; c++) if (!matrix.isReserved(row, col - c)) {
							let dark = false;
							if (byteIndex < data.length) dark = (data[byteIndex] >>> bitIndex & 1) === 1;
							matrix.set(row, col - c, dark);
							bitIndex--;
							if (bitIndex === -1) {
								byteIndex++;
								bitIndex = 7;
							}
						}
						row += inc;
						if (row < 0 || size <= row) {
							row -= inc;
							inc = -inc;
							break;
						}
					}
				}
			}
			/**
			* Create encoded codewords from data input
			*
			* @param  {Number}   version              QR Code version
			* @param  {ErrorCorrectionLevel}   errorCorrectionLevel Error correction level
			* @param  {ByteData} data                 Data input
			* @return {Uint8Array}                    Buffer containing encoded codewords
			*/
			function createData(version, errorCorrectionLevel, segments) {
				const buffer = new BitBuffer();
				segments.forEach(function(data) {
					buffer.put(data.mode.bit, 4);
					buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
					data.write(buffer);
				});
				const dataTotalCodewordsBits = (Utils.getSymbolTotalCodewords(version) - ECCode.getTotalCodewordsCount(version, errorCorrectionLevel)) * 8;
				if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) buffer.put(0, 4);
				while (buffer.getLengthInBits() % 8 !== 0) buffer.putBit(0);
				const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
				for (let i = 0; i < remainingByte; i++) buffer.put(i % 2 ? 17 : 236, 8);
				return createCodewords(buffer, version, errorCorrectionLevel);
			}
			/**
			* Encode input data with Reed-Solomon and return codewords with
			* relative error correction bits
			*
			* @param  {BitBuffer} bitBuffer            Data to encode
			* @param  {Number}    version              QR Code version
			* @param  {ErrorCorrectionLevel} errorCorrectionLevel Error correction level
			* @return {Uint8Array}                     Buffer containing encoded codewords
			*/
			function createCodewords(bitBuffer, version, errorCorrectionLevel) {
				const totalCodewords = Utils.getSymbolTotalCodewords(version);
				const dataTotalCodewords = totalCodewords - ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
				const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
				const blocksInGroup1 = ecTotalBlocks - totalCodewords % ecTotalBlocks;
				const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
				const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
				const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
				const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
				const rs = new ReedSolomonEncoder(ecCount);
				let offset = 0;
				const dcData = new Array(ecTotalBlocks);
				const ecData = new Array(ecTotalBlocks);
				let maxDataSize = 0;
				const buffer = new Uint8Array(bitBuffer.buffer);
				for (let b = 0; b < ecTotalBlocks; b++) {
					const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
					dcData[b] = buffer.slice(offset, offset + dataSize);
					ecData[b] = rs.encode(dcData[b]);
					offset += dataSize;
					maxDataSize = Math.max(maxDataSize, dataSize);
				}
				const data = new Uint8Array(totalCodewords);
				let index = 0;
				let i, r;
				for (i = 0; i < maxDataSize; i++) for (r = 0; r < ecTotalBlocks; r++) if (i < dcData[r].length) data[index++] = dcData[r][i];
				for (i = 0; i < ecCount; i++) for (r = 0; r < ecTotalBlocks; r++) data[index++] = ecData[r][i];
				return data;
			}
			/**
			* Build QR Code symbol
			*
			* @param  {String} data                 Input string
			* @param  {Number} version              QR Code version
			* @param  {ErrorCorretionLevel} errorCorrectionLevel Error level
			* @param  {MaskPattern} maskPattern     Mask pattern
			* @return {Object}                      Object containing symbol data
			*/
			function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
				let segments;
				if (Array.isArray(data)) segments = Segments.fromArray(data);
				else if (typeof data === "string") {
					let estimatedVersion = version;
					if (!estimatedVersion) {
						const rawSegments = Segments.rawSplit(data);
						estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
					}
					segments = Segments.fromString(data, estimatedVersion || 40);
				} else throw new Error("Invalid data");
				const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
				if (!bestVersion) throw new Error("The amount of data is too big to be stored in a QR Code");
				if (!version) version = bestVersion;
				else if (version < bestVersion) throw new Error("\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n");
				const dataBits = createData(version, errorCorrectionLevel, segments);
				const moduleCount = Utils.getSymbolSize(version);
				const modules = new BitMatrix(moduleCount);
				setupFinderPattern(modules, version);
				setupTimingPattern(modules);
				setupAlignmentPattern(modules, version);
				setupFormatInfo(modules, errorCorrectionLevel, 0);
				if (version >= 7) setupVersionInfo(modules, version);
				setupData(modules, dataBits);
				if (isNaN(maskPattern)) maskPattern = MaskPattern.getBestMask(modules, setupFormatInfo.bind(null, modules, errorCorrectionLevel));
				MaskPattern.applyMask(maskPattern, modules);
				setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
				return {
					modules,
					version,
					errorCorrectionLevel,
					maskPattern,
					segments
				};
			}
			/**
			* QR Code
			*
			* @param {String | Array} data                 Input data
			* @param {Object} options                      Optional configurations
			* @param {Number} options.version              QR Code version
			* @param {String} options.errorCorrectionLevel Error correction level
			* @param {Function} options.toSJISFunc         Helper func to convert utf8 to sjis
			*/
			exports.create = function create(data, options) {
				if (typeof data === "undefined" || data === "") throw new Error("No input text");
				let errorCorrectionLevel = ECLevel.M;
				let version;
				let mask;
				if (typeof options !== "undefined") {
					errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
					version = Version.from(options.version);
					mask = MaskPattern.from(options.maskPattern);
					if (options.toSJISFunc) Utils.setToSJISFunction(options.toSJISFunc);
				}
				return createSymbol(data, version, errorCorrectionLevel, mask);
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/renderer/utils.js
		var require_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
			function hex2rgba(hex) {
				if (typeof hex === "number") hex = hex.toString();
				if (typeof hex !== "string") throw new Error("Color should be defined as hex string");
				let hexCode = hex.slice().replace("#", "").split("");
				if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) throw new Error("Invalid hex color: " + hex);
				if (hexCode.length === 3 || hexCode.length === 4) hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
					return [c, c];
				}));
				if (hexCode.length === 6) hexCode.push("F", "F");
				const hexValue = parseInt(hexCode.join(""), 16);
				return {
					r: hexValue >> 24 & 255,
					g: hexValue >> 16 & 255,
					b: hexValue >> 8 & 255,
					a: hexValue & 255,
					hex: "#" + hexCode.slice(0, 6).join("")
				};
			}
			exports.getOptions = function getOptions(options) {
				if (!options) options = {};
				if (!options.color) options.color = {};
				const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
				const width = options.width && options.width >= 21 ? options.width : void 0;
				const scale = options.scale || 4;
				return {
					width,
					scale: width ? 4 : scale,
					margin,
					color: {
						dark: hex2rgba(options.color.dark || "#000000ff"),
						light: hex2rgba(options.color.light || "#ffffffff")
					},
					type: options.type,
					rendererOpts: options.rendererOpts || {}
				};
			};
			exports.getScale = function getScale(qrSize, opts) {
				return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
			};
			exports.getImageWidth = function getImageWidth(qrSize, opts) {
				const scale = exports.getScale(qrSize, opts);
				return Math.floor((qrSize + opts.margin * 2) * scale);
			};
			exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
				const size = qr.modules.size;
				const data = qr.modules.data;
				const scale = exports.getScale(size, opts);
				const symbolSize = Math.floor((size + opts.margin * 2) * scale);
				const scaledMargin = opts.margin * scale;
				const palette = [opts.color.light, opts.color.dark];
				for (let i = 0; i < symbolSize; i++) for (let j = 0; j < symbolSize; j++) {
					let posDst = (i * symbolSize + j) * 4;
					let pxColor = opts.color.light;
					if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
						const iSrc = Math.floor((i - scaledMargin) / scale);
						const jSrc = Math.floor((j - scaledMargin) / scale);
						pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
					}
					imgData[posDst++] = pxColor.r;
					imgData[posDst++] = pxColor.g;
					imgData[posDst++] = pxColor.b;
					imgData[posDst] = pxColor.a;
				}
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/renderer/canvas.js
		var require_canvas = /* @__PURE__ */ __commonJSMin(((exports) => {
			const Utils = require_utils();
			function clearCanvas(ctx, canvas, size) {
				ctx.clearRect(0, 0, canvas.width, canvas.height);
				if (!canvas.style) canvas.style = {};
				canvas.height = size;
				canvas.width = size;
				canvas.style.height = size + "px";
				canvas.style.width = size + "px";
			}
			function getCanvasElement() {
				try {
					return document.createElement("canvas");
				} catch (e) {
					throw new Error("You need to specify a canvas element");
				}
			}
			exports.render = function render(qrData, canvas, options) {
				let opts = options;
				let canvasEl = canvas;
				if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
					opts = canvas;
					canvas = void 0;
				}
				if (!canvas) canvasEl = getCanvasElement();
				opts = Utils.getOptions(opts);
				const size = Utils.getImageWidth(qrData.modules.size, opts);
				const ctx = canvasEl.getContext("2d");
				const image = ctx.createImageData(size, size);
				Utils.qrToImageData(image.data, qrData, opts);
				clearCanvas(ctx, canvasEl, size);
				ctx.putImageData(image, 0, 0);
				return canvasEl;
			};
			exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
				let opts = options;
				if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
					opts = canvas;
					canvas = void 0;
				}
				if (!opts) opts = {};
				const canvasEl = exports.render(qrData, canvas, opts);
				const type = opts.type || "image/png";
				const rendererOpts = opts.rendererOpts || {};
				return canvasEl.toDataURL(type, rendererOpts.quality);
			};
		}));
		//#endregion
		//#region node_modules/qrcode/lib/renderer/svg-tag.js
		var require_svg_tag = /* @__PURE__ */ __commonJSMin(((exports) => {
			const Utils = require_utils();
			function getColorAttrib(color, attrib) {
				const alpha = color.a / 255;
				const str = attrib + "=\"" + color.hex + "\"";
				return alpha < 1 ? str + " " + attrib + "-opacity=\"" + alpha.toFixed(2).slice(1) + "\"" : str;
			}
			function svgCmd(cmd, x, y) {
				let str = cmd + x;
				if (typeof y !== "undefined") str += " " + y;
				return str;
			}
			function qrToPath(data, size, margin) {
				let path = "";
				let moveBy = 0;
				let newRow = false;
				let lineLength = 0;
				for (let i = 0; i < data.length; i++) {
					const col = Math.floor(i % size);
					const row = Math.floor(i / size);
					if (!col && !newRow) newRow = true;
					if (data[i]) {
						lineLength++;
						if (!(i > 0 && col > 0 && data[i - 1])) {
							path += newRow ? svgCmd("M", col + margin, .5 + row + margin) : svgCmd("m", moveBy, 0);
							moveBy = 0;
							newRow = false;
						}
						if (!(col + 1 < size && data[i + 1])) {
							path += svgCmd("h", lineLength);
							lineLength = 0;
						}
					} else moveBy++;
				}
				return path;
			}
			exports.render = function render(qrData, options, cb) {
				const opts = Utils.getOptions(options);
				const size = qrData.modules.size;
				const data = qrData.modules.data;
				const qrcodesize = size + opts.margin * 2;
				const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + " d=\"M0 0h" + qrcodesize + "v" + qrcodesize + "H0z\"/>";
				const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + " d=\"" + qrToPath(data, size, opts.margin) + "\"/>";
				const viewBox = "viewBox=\"0 0 " + qrcodesize + " " + qrcodesize + "\"";
				const svgTag = "<svg xmlns=\"http://www.w3.org/2000/svg\" " + (!opts.width ? "" : "width=\"" + opts.width + "\" height=\"" + opts.width + "\" ") + viewBox + " shape-rendering=\"crispEdges\">" + bg + path + "</svg>\n";
				if (typeof cb === "function") cb(null, svgTag);
				return svgTag;
			};
		}));
		//#endregion
		//#region src/pairing-qr.ts
		var import_browser = /* @__PURE__ */ __toESM((/* @__PURE__ */ __commonJSMin(((exports) => {
			const canPromise = require_can_promise();
			const QRCode = require_qrcode();
			const CanvasRenderer = require_canvas();
			const SvgRenderer = require_svg_tag();
			function renderCanvas(renderFunc, canvas, text, opts, cb) {
				const args = [].slice.call(arguments, 1);
				const argsNum = args.length;
				const isLastArgCb = typeof args[argsNum - 1] === "function";
				if (!isLastArgCb && !canPromise()) throw new Error("Callback required as last argument");
				if (isLastArgCb) {
					if (argsNum < 2) throw new Error("Too few arguments provided");
					if (argsNum === 2) {
						cb = text;
						text = canvas;
						canvas = opts = void 0;
					} else if (argsNum === 3) {
						if (canvas.getContext && typeof cb === "undefined") {
							cb = opts;
							opts = void 0;
						} else {
							cb = opts;
							opts = text;
							text = canvas;
							canvas = void 0;
						}
					}
				} else {
					if (argsNum < 1) throw new Error("Too few arguments provided");
					if (argsNum === 1) {
						text = canvas;
						canvas = opts = void 0;
					} else if (argsNum === 2 && !canvas.getContext) {
						opts = text;
						text = canvas;
						canvas = void 0;
					}
					return new Promise(function(resolve, reject) {
						try {
							resolve(renderFunc(QRCode.create(text, opts), canvas, opts));
						} catch (e) {
							reject(e);
						}
					});
				}
				try {
					const data = QRCode.create(text, opts);
					cb(null, renderFunc(data, canvas, opts));
				} catch (e) {
					cb(e);
				}
			}
			exports.create = QRCode.create;
			exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
			exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
			exports.toString = renderCanvas.bind(null, function(data, _, opts) {
				return SvgRenderer.render(data, opts);
			});
		})))(), 1);
		/**
		* Protocol-v1 compatibility identifier used by the TestFlight build currently
		* under review. This is wire data, not the plugin or product display name.
		*/
		const PAIRING_QR_TYPE = "dsh-pocket-pairing";
		function isLoopbackHostname(hostname) {
			const normalized = hostname.toLowerCase();
			return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "[::1]" || normalized === "::1" || normalized.startsWith("127.");
		}
		/** Prefer an online Funnel; otherwise turn the current web origin into a LAN target. */
		function selectPairingTarget(remote, lanAddresses, currentOrigin) {
			let origin;
			try {
				if (currentOrigin) origin = new URL(currentOrigin);
			} catch {}
			if (remote.publicURL && origin?.origin === remote.publicURL) return {
				host: remote.publicURL,
				kind: "public"
			};
			if (remote.phase === "online" && remote.publicURL) return {
				host: remote.publicURL,
				kind: "public"
			};
			if (origin && ["http:", "https:"].includes(origin.protocol) && !isLoopbackHostname(origin.hostname)) return {
				host: origin.origin,
				kind: "lan"
			};
			const address = lanAddresses[0];
			if (!address) return null;
			return {
				host: `${origin?.protocol === "https:" ? "https:" : "http:"}//${address}${origin?.port ? `:${origin.port}` : ""}`,
				kind: "lan"
			};
		}
		/** Encode an out-of-band pairing payload without putting the token in a URL. */
		function encodePairingQRPayload(host, token) {
			const normalizedHost = host.trim();
			const parsed = new URL(normalizedHost);
			if (![
				"http:",
				"https:",
				"ws:",
				"wss:"
			].includes(parsed.protocol) || parsed.hostname === "" || parsed.username !== "" || parsed.password !== "") throw new TypeError("pairing QR requires a valid HTTP(S)/WS(S) host");
			if (token.trim().length < 32) throw new TypeError("pairing token is invalid");
			const payload = {
				v: 1,
				type: PAIRING_QR_TYPE,
				host: normalizedHost,
				token: token.trim()
			};
			return JSON.stringify(payload);
		}
		function normalizeFunnelConnectionLimit(value) {
			return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 16 ? value : 8;
		}
		//#endregion
		//#region src/client/settings-page.ts
		async function writeClipboard(t, value) {
			try {
				await navigator.clipboard.writeText(value);
				return;
			} catch {}
			const textarea = document.createElement("textarea");
			textarea.value = value;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			const copied = document.execCommand("copy");
			textarea.remove();
			if (!copied) throw new Error(t("clipboard.rejected"));
		}
		/** Visual state of the embedded Funnel: a colored dot plus its spoken label.
		*  The label is a function because the surrounding constant lives at module
		*  scope where the locale-bound t() is not in scope; the page resolves the
		*  label at render time via t(props.t, ...). */
		const REMOTE_PHASE_META = {
			disabled: {
				dot: "",
				labelKey: "phase.disabled"
			},
			starting: {
				dot: " pbb-dotWarn",
				labelKey: "phase.starting"
			},
			login_required: {
				dot: " pbb-dotWarn",
				labelKey: "phase.login_required"
			},
			online: {
				dot: " pbb-dotOk",
				labelKey: "phase.online"
			},
			error: {
				dot: " pbb-dotBad",
				labelKey: "phase.error"
			},
			unavailable: {
				dot: " pbb-dotBad",
				labelKey: "phase.unavailable"
			},
			stopped: {
				dot: "",
				labelKey: "phase.stopped"
			}
		};
		/** Slot component: hooks come from the slot renderer, named use<Key>. */
		function DeepPilotSettingsPage(props) {
			const [revealedToken, setRevealedToken] = (0, react.useState)(null);
			const [tokenBusy, setTokenBusy] = (0, react.useState)(false);
			const [tokenMessage, setTokenMessage] = (0, react.useState)("");
			const [rotateArmed, setRotateArmed] = (0, react.useState)(false);
			const [remoteMessage, setRemoteMessage] = (0, react.useState)("");
			const [remoteLimitDraft, setRemoteLimitDraft] = (0, react.useState)(String(8));
			const [remoteLimitMessage, setRemoteLimitMessage] = (0, react.useState)("");
			const [qrDataURL, setQRDataURL] = (0, react.useState)(null);
			const [qrBusy, setQRBusy] = (0, react.useState)(false);
			const [qrMessage, setQRMessage] = (0, react.useState)("");
			const [relayTestBusy, setRelayTestBusy] = (0, react.useState)(false);
			const [relayTestResult, setRelayTestResult] = (0, react.useState)(null);
			const [relayTestError, setRelayTestError] = (0, react.useState)("");
			const [pushTestBusy, setPushTestBusy] = (0, react.useState)(false);
			const [pushTestResult, setPushTestResult] = (0, react.useState)(null);
			const [pushTestError, setPushTestError] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				if (typeof props.refresh !== "function") return;
				props.refresh();
				const timer = globalThis.setInterval(() => props.refresh(), 3e3);
				return () => globalThis.clearInterval(timer);
			}, [props.refresh]);
			const sendPushTest = () => {
				if (pushTestBusy) return;
				if (typeof props.testPush !== "function") {
					setPushTestError(translateWith(props.t, "push.staleHost"));
					return;
				}
				setPushTestBusy(true);
				setPushTestError("");
				props.testPush().then((result) => {
					setPushTestResult(result);
					setPushTestBusy(false);
				}, (error) => {
					setPushTestError(error instanceof Error ? error.message : String(error));
					setPushTestBusy(false);
				});
			};
			const runRelayTest = () => {
				if (relayTestBusy) return;
				if (typeof props.testRelay !== "function") {
					setRelayTestError(translateWith(props.t, "push.staleHostRelay"));
					return;
				}
				setRelayTestBusy(true);
				setRelayTestError("");
				props.testRelay().then((result) => {
					setRelayTestResult(result);
					setRelayTestBusy(false);
				}, (error) => {
					setRelayTestError(error instanceof Error ? error.message : String(error));
					setRelayTestBusy(false);
				});
			};
			(0, react.useEffect)(() => {
				if (revealedToken === null) return;
				const timer = globalThis.setTimeout(() => {
					setRevealedToken(null);
					setTokenMessage(translateWith(props.t, "panel.tokenAutoHidden"));
				}, 3e4);
				return () => globalThis.clearTimeout(timer);
			}, [revealedToken]);
			(0, react.useEffect)(() => {
				if (!tokenMessage) return;
				const timer = globalThis.setTimeout(() => setTokenMessage(""), 4e3);
				return () => globalThis.clearTimeout(timer);
			}, [tokenMessage]);
			(0, react.useEffect)(() => {
				if (!rotateArmed) return;
				const timer = globalThis.setTimeout(() => setRotateArmed(false), 5e3);
				return () => globalThis.clearTimeout(timer);
			}, [rotateArmed]);
			(0, react.useEffect)(() => {
				if (!remoteMessage) return;
				const timer = globalThis.setTimeout(() => setRemoteMessage(""), 2500);
				return () => globalThis.clearTimeout(timer);
			}, [remoteMessage]);
			(0, react.useEffect)(() => {
				if (!remoteLimitMessage) return;
				const timer = globalThis.setTimeout(() => setRemoteLimitMessage(""), 4e3);
				return () => globalThis.clearTimeout(timer);
			}, [remoteLimitMessage]);
			(0, react.useEffect)(() => {
				if (qrDataURL === null) return;
				const timer = globalThis.setTimeout(() => {
					setQRDataURL(null);
					setQRMessage(translateWith(props.t, "pair.qrAutoHidden"));
				}, 6e4);
				return () => globalThis.clearTimeout(timer);
			}, [qrDataURL]);
			(0, react.useEffect)(() => {
				if (!qrMessage) return;
				const timer = globalThis.setTimeout(() => setQRMessage(""), 2500);
				return () => globalThis.clearTimeout(timer);
			}, [qrMessage]);
			const diag = [];
			let report = null;
			let enabled = true;
			let switchReady = false;
			let remoteEnabled = false;
			let remoteSwitchReady = false;
			let remoteConnectionLimit = 8;
			let remoteConnectionLimitReady = false;
			let failed = false;
			try {
				if (typeof props.useDeepPilotReport !== "function") {
					diag.push(translateWith(props.t, "diag.missingReportHook"));
					failed = true;
				} else {
					const state = props.useDeepPilotReport((s) => s);
					report = state.report;
					if (state.status === "error" && state.message) {
						diag.push(state.message);
						failed = true;
					}
				}
				if (typeof props.useDeepPilotEnabled === "function") {
					const state = props.useDeepPilotEnabled((s) => s);
					enabled = state.enabled;
					switchReady = state.status === "ready";
					if (state.status === "unavailable") diag.push(translateWith(props.t, "diag.settingsUnavailable"));
				} else diag.push(translateWith(props.t, "diag.missingEnabledHook"));
				if (typeof props.refresh !== "function") diag.push(translateWith(props.t, "diag.missingRefresh"));
				if (typeof props.revealPairingToken !== "function") diag.push(translateWith(props.t, "diag.missingReveal"));
				if (typeof props.rotatePairingToken !== "function") diag.push(translateWith(props.t, "diag.missingRotate"));
				if (typeof props.testRelay !== "function") diag.push(translateWith(props.t, "diag.missingTestRelay"));
				if (typeof props.testPush !== "function") diag.push(translateWith(props.t, "diag.missingTestPush"));
				if (typeof props.setDeepPilotEnabled !== "function") diag.push(translateWith(props.t, "diag.missingSetEnabled"));
				if (typeof props.useDeepPilotRemoteEnabled === "function") {
					const state = props.useDeepPilotRemoteEnabled((s) => s);
					remoteEnabled = state.enabled;
					remoteSwitchReady = state.status === "ready";
				} else diag.push(translateWith(props.t, "diag.missingRemoteEnabledHook"));
				if (typeof props.setDeepPilotRemoteEnabled !== "function") diag.push(translateWith(props.t, "diag.missingSetRemote"));
				if (typeof props.useDeepPilotRemoteConnectionLimit === "function") {
					const state = props.useDeepPilotRemoteConnectionLimit((s) => s);
					remoteConnectionLimit = state.value;
					remoteConnectionLimitReady = state.status === "ready";
				} else diag.push(translateWith(props.t, "diag.missingRemoteLimitHook"));
				if (typeof props.setDeepPilotRemoteConnectionLimit !== "function") diag.push(translateWith(props.t, "diag.missingSetRemoteLimit"));
			} catch (error) {
				diag.push(translateWith(props.t, "diag.renderError") + (error instanceof Error ? error.message : String(error)));
				failed = true;
			}
			(0, react.useEffect)(() => {
				setRemoteLimitDraft(String(remoteConnectionLimit));
			}, [remoteConnectionLimit]);
			const parsedRemoteLimit = Number(remoteLimitDraft);
			const remoteLimitValid = Number.isInteger(parsedRemoteLimit) && parsedRemoteLimit >= 1 && parsedRemoteLimit <= 16;
			const applyRemoteLimit = () => {
				if (!remoteLimitValid || typeof props.setDeepPilotRemoteConnectionLimit !== "function") {
					setRemoteLimitMessage(translateWith(props.t, "remote.limitInvalid"));
					return;
				}
				setRemoteLimitMessage("");
				props.setDeepPilotRemoteConnectionLimit(parsedRemoteLimit).then(() => {
					setRemoteLimitMessage(translateWith(props.t, "remote.limitApplied"));
				}, (error) => {
					setRemoteLimitMessage(translateWith(props.t, "remote.limitFailed") + (error instanceof Error ? error.message : String(error)));
				});
			};
			const pairingTarget = report === null ? null : selectPairingTarget(report.remote, report.lanAddresses, typeof window === "undefined" ? void 0 : window.location.origin);
			(0, react.useEffect)(() => {
				setQRDataURL(null);
			}, [pairingTarget?.host]);
			const toggleToken = () => {
				if (revealedToken !== null) {
					setRevealedToken(null);
					setTokenMessage("");
					return;
				}
				if (typeof props.revealPairingToken !== "function") return;
				setTokenBusy(true);
				setTokenMessage("");
				props.revealPairingToken().then((token) => {
					setRevealedToken(token);
				}, (error) => {
					setTokenMessage(translateWith(props.t, "panel.tokenRevealFailed") + (error instanceof Error ? error.message : String(error)));
				}).finally(() => setTokenBusy(false));
			};
			const copyToken = () => {
				if (typeof props.revealPairingToken !== "function") return;
				setTokenBusy(true);
				setTokenMessage("");
				(revealedToken !== null ? Promise.resolve(revealedToken) : props.revealPairingToken()).then((value) => writeClipboard(props.t, value)).then(() => setTokenMessage(translateWith(props.t, "panel.tokenCopied")), (error) => {
					setTokenMessage(translateWith(props.t, "pair.publicCopyFailed") + (error instanceof Error ? error.message : String(error)));
				}).finally(() => setTokenBusy(false));
			};
			const rotateToken = () => {
				if (typeof props.rotatePairingToken !== "function") return;
				if (!rotateArmed) {
					setRotateArmed(true);
					setRevealedToken(null);
					setQRDataURL(null);
					setTokenMessage(translateWith(props.t, "panel.tokenRotateWarning"));
					return;
				}
				setRotateArmed(false);
				setTokenBusy(true);
				setTokenMessage("");
				props.rotatePairingToken().then((token) => {
					setRevealedToken(token);
					setTokenMessage(translateWith(props.t, "panel.tokenRotated"));
				}, (error) => {
					setTokenMessage(translateWith(props.t, "panel.tokenRotateFailed") + (error instanceof Error ? error.message : String(error)));
				}).finally(() => setTokenBusy(false));
			};
			const copyRemoteURL = (url) => {
				setRemoteMessage("");
				writeClipboard(props.t, url).then(() => {
					setRemoteMessage(translateWith(props.t, "pair.publicCopyDone"));
				}, (error) => {
					setRemoteMessage(translateWith(props.t, "pair.publicCopyFailed") + (error instanceof Error ? error.message : String(error)));
				});
			};
			const showPairingQR = () => {
				if (typeof props.revealPairingToken !== "function" || pairingTarget === null) return;
				setQRBusy(true);
				setQRMessage("");
				setQRDataURL(null);
				props.revealPairingToken().then((pairingToken) => import_browser.toString(encodePairingQRPayload(pairingTarget.host, pairingToken), {
					type: "svg",
					errorCorrectionLevel: "M",
					margin: 2,
					width: 512
				})).then((svg) => setQRDataURL("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)), (error) => {
					setQRMessage(translateWith(props.t, "pair.qrFailed") + (error instanceof Error ? error.message : String(error)));
				}).finally(() => setQRBusy(false));
			};
			const primaryRows = [];
			const advancedRows = [];
			if (report !== null) {
				primaryRows.push((0, react.createElement)("div", {
					className: "pbb-field",
					key: "conn"
				}, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "panel.activeConnections")), (0, react.createElement)("span", { className: "pbb-value" }, String(report.activeConnections)))), (0, react.createElement)("div", {
					className: "pbb-field",
					key: "token"
				}, (0, react.createElement)("div", { className: "pbb-row pbb-tokenRow" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "panel.token")), (0, react.createElement)("code", { className: "pbb-token " + (report.tokenReady ? "pbb-ok" : "pbb-bad") }, report.tokenReady ? revealedToken ?? "••••••••••••" : translateWith(props.t, "panel.tokenNotReady")), report.tokenReady ? (0, react.createElement)("span", { className: "pbb-tokenActions" }, (0, react.createElement)("button", {
					type: "button",
					className: "pbb-action",
					disabled: tokenBusy,
					onClick: toggleToken
				}, tokenBusy ? translateWith(props.t, "panel.tokenAction.showing") : revealedToken === null ? translateWith(props.t, "panel.tokenAction.show") : translateWith(props.t, "panel.tokenAction.hide")), (0, react.createElement)("button", {
					type: "button",
					className: "pbb-action",
					disabled: tokenBusy,
					onClick: copyToken
				}, translateWith(props.t, "panel.tokenAction.copy")), (0, react.createElement)("button", {
					type: "button",
					className: "pbb-action" + (rotateArmed ? " pbb-actionDanger" : ""),
					disabled: tokenBusy,
					onClick: rotateToken
				}, rotateArmed ? translateWith(props.t, "panel.tokenAction.rotateConfirm") : tokenBusy ? translateWith(props.t, "panel.tokenAction.rotating") : translateWith(props.t, "panel.tokenAction.rotate"))) : null), tokenMessage ? (0, react.createElement)("p", { className: "pbb-diag" }, tokenMessage) : null));
				advancedRows.push((0, react.createElement)("div", {
					className: "pbb-field",
					key: "proto"
				}, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "advanced.protocolVersion")), (0, react.createElement)("span", { className: "pbb-value" }, "v" + String(report.protocolVersion)))), (0, react.createElement)("div", {
					className: "pbb-field",
					key: "server"
				}, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "advanced.serverVersion")), (0, react.createElement)("span", { className: "pbb-value" }, report.serverVersion))), (0, react.createElement)("div", {
					className: "pbb-field",
					key: "path"
				}, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "advanced.tokenPath")), (0, react.createElement)("span", { className: "pbb-value" }, report.tokenPath))), (0, react.createElement)("div", {
					className: "pbb-field",
					key: "buffer"
				}, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "advanced.bufferMax")), (0, react.createElement)("span", { className: "pbb-value" }, String(report.historyBufferMax) + translateWith(props.t, "advanced.frames")))));
			}
			const deviceTable = report !== null && report.devices.length > 0 ? (0, react.createElement)("table", { className: "pbb-table" }, (0, react.createElement)("thead", null, (0, react.createElement)("tr", null, (0, react.createElement)("th", null, translateWith(props.t, "devices.col.name")), (0, react.createElement)("th", null, translateWith(props.t, "devices.col.appVersion")), (0, react.createElement)("th", null, translateWith(props.t, "devices.col.push")), (0, react.createElement)("th", null, translateWith(props.t, "devices.col.lastSeen")))), (0, react.createElement)("tbody", null, report.devices.map((d) => (0, react.createElement)("tr", { key: d.deviceId }, (0, react.createElement)("td", null, d.deviceName), (0, react.createElement)("td", null, d.appVersion), (0, react.createElement)("td", null, d.apns ? translateWith(props.t, "devices.pushRegistered") + (d.apns.environment === "production" ? translateWith(props.t, "devices.pushEnvProduction") : translateWith(props.t, "devices.pushEnvDevelopment")) + "）" : translateWith(props.t, "devices.pushNotRegistered")), (0, react.createElement)("td", null, new Date(d.lastSeenTs).toLocaleString()))))) : (0, react.createElement)("p", { className: "pbb-empty" }, translateWith(props.t, "devices.empty"));
			const switchTitle = translateWith(props.t, "master.title");
			const switchDesc = switchReady ? enabled ? translateWith(props.t, "master.on") : translateWith(props.t, "master.off") : translateWith(props.t, "master.loading");
			return (0, react.createElement)("div", { className: "pbb-section" }, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("h2", { className: "pbb-title" }, "DeepPilot"), (0, react.createElement)("div", { style: { flex: "1" } }), (0, react.createElement)("button", {
				className: "pbb-refresh",
				onClick: () => {
					if (typeof props.refresh === "function") props.refresh();
				}
			}, translateWith(props.t, "meta.refresh"))), (0, react.createElement)("p", { className: "pbb-intro" }, translateWith(props.t, "meta.intro")), (0, react.createElement)("div", { className: "pbb-card" }, (0, react.createElement)("div", { className: "pbb-switchRow" }, (0, react.createElement)("div", { className: "pbb-switchText" }, (0, react.createElement)("span", { className: "pbb-switchTitle" }, switchTitle), (0, react.createElement)("span", { className: "pbb-switchDesc" }, switchDesc)), (0, react.createElement)("button", {
				type: "button",
				role: "switch",
				"aria-checked": enabled,
				"aria-label": switchTitle,
				disabled: !switchReady,
				className: "pbb-switch" + (enabled ? " pbb-switchOn" : ""),
				onClick: () => {
					if (typeof props.setDeepPilotEnabled === "function") props.setDeepPilotEnabled(!enabled);
				}
			})), (0, react.createElement)("div", { className: "pbb-switchRow" }, (0, react.createElement)("div", { className: "pbb-switchText" }, (0, react.createElement)("span", { className: "pbb-switchTitle pbb-dotRow" }, (0, react.createElement)("span", {
				className: "pbb-dot" + (report !== null ? REMOTE_PHASE_META[report.remote.phase].dot : ""),
				role: "img",
				"aria-label": report !== null ? translateWith(props.t, REMOTE_PHASE_META[report.remote.phase].labelKey) : translateWith(props.t, "phase.unknown"),
				title: report !== null ? translateWith(props.t, REMOTE_PHASE_META[report.remote.phase].labelKey) : void 0
			}), translateWith(props.t, "remote.title")), (0, react.createElement)("span", { className: "pbb-switchDesc" }, remoteSwitchReady ? remoteEnabled ? translateWith(props.t, "remote.on") : translateWith(props.t, "remote.off") : translateWith(props.t, "master.loading")), report !== null && report.remote.phase === "login_required" && typeof report.remote.authURL === "string" && report.remote.authURL.startsWith("https://") ? (0, react.createElement)("div", { className: "pbb-rowAction" }, (0, react.createElement)("a", {
				className: "pbb-action",
				href: report.remote.authURL,
				target: "_blank",
				rel: "noreferrer"
			}, translateWith(props.t, "remote.openAuth"))) : null, report !== null && report.remote.message && (report.remote.phase === "error" || report.remote.phase === "unavailable") ? (0, react.createElement)("p", { className: "pbb-diag pbb-diagBad" }, report.remote.message) : null, remoteMessage ? (0, react.createElement)("p", { className: "pbb-diag" }, remoteMessage) : null), (0, react.createElement)("button", {
				type: "button",
				role: "switch",
				"aria-checked": remoteEnabled,
				"aria-label": translateWith(props.t, "remote.title"),
				disabled: !remoteSwitchReady,
				className: "pbb-switch" + (remoteEnabled ? " pbb-switchOn" : ""),
				onClick: () => {
					if (typeof props.setDeepPilotRemoteEnabled === "function") props.setDeepPilotRemoteEnabled(!remoteEnabled);
				}
			})), (0, react.createElement)("div", { className: "pbb-limitRow" }, (0, react.createElement)("div", { className: "pbb-switchText" }, (0, react.createElement)("label", {
				className: "pbb-switchTitle",
				htmlFor: "deeppilot-funnel-source-limit"
			}, translateWith(props.t, "remote.limitTitle")), (0, react.createElement)("span", { className: "pbb-switchDesc" }, translateWith(props.t, "remote.limitDescription")), !remoteLimitValid ? (0, react.createElement)("p", { className: "pbb-diag pbb-diagBad" }, translateWith(props.t, "remote.limitInvalid")) : remoteLimitMessage ? (0, react.createElement)("p", { className: "pbb-diag" + (remoteLimitMessage.startsWith(translateWith(props.t, "remote.limitFailed")) ? " pbb-diagBad" : "") }, remoteLimitMessage) : null), (0, react.createElement)("div", { className: "pbb-limitControl" }, (0, react.createElement)("input", {
				id: "deeppilot-funnel-source-limit",
				className: "pbb-numberInput",
				type: "number",
				min: 1,
				max: 16,
				step: 1,
				inputMode: "numeric",
				value: remoteLimitDraft,
				disabled: !remoteConnectionLimitReady,
				"aria-label": translateWith(props.t, "remote.limitTitle"),
				onChange: (event) => setRemoteLimitDraft(event.currentTarget.value),
				onKeyDown: (event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						applyRemoteLimit();
					}
				}
			}), (0, react.createElement)("button", {
				type: "button",
				className: "pbb-action",
				disabled: !remoteConnectionLimitReady || !remoteLimitValid || parsedRemoteLimit === remoteConnectionLimit,
				onClick: applyRemoteLimit
			}, translateWith(props.t, "remote.limitApply")))), (0, react.createElement)("details", { className: "pbb-help" }, (0, react.createElement)("summary", null, translateWith(props.t, "help.remoteTitle")), (0, react.createElement)("div", { className: "pbb-helpBody" }, (0, react.createElement)("div", { className: "pbb-helpSection" }, (0, react.createElement)("div", { className: "pbb-helpHeading" }, translateWith(props.t, "help.recommended")), (0, react.createElement)("ol", { className: "pbb-helpList" }, (0, react.createElement)("li", null, translateWith(props.t, "help.step1")), (0, react.createElement)("li", null, translateWith(props.t, "help.step2")), (0, react.createElement)("li", null, translateWith(props.t, "help.step3")), (0, react.createElement)("li", null, translateWith(props.t, "help.step4"))), (0, react.createElement)("p", { className: "pbb-helpText" }, translateWith(props.t, "help.funnelHint"))), (0, react.createElement)("div", { className: "pbb-helpSection" }, (0, react.createElement)("div", { className: "pbb-helpHeading" }, translateWith(props.t, "help.httpsTitle")), (0, react.createElement)("ol", { className: "pbb-helpList" }, (0, react.createElement)("li", null, translateWith(props.t, "help.httpsStep1")), (0, react.createElement)("li", null, translateWith(props.t, "help.httpsStep2")), (0, react.createElement)("li", null, translateWith(props.t, "help.httpsStep3"))), (0, react.createElement)("p", { className: "pbb-helpText" }, translateWith(props.t, "help.httpsHint"))), (0, react.createElement)("div", { className: "pbb-helpSection" }, (0, react.createElement)("div", { className: "pbb-helpHeading" }, translateWith(props.t, "help.allowTitle")), (0, react.createElement)("p", { className: "pbb-helpText" }, translateWith(props.t, "help.allowBody")), (0, react.createElement)("code", { className: "pbb-helpCode" }, "\"nodeAttrs\": [\n  {\n    \"target\": [\"autogroup:member\"],\n    \"attr\": [\"funnel\"],\n  },\n],"), (0, react.createElement)("p", { className: "pbb-helpText" }, translateWith(props.t, "help.allowHint"))), (0, react.createElement)("div", { className: "pbb-helpSection" }, (0, react.createElement)("div", { className: "pbb-helpHeading" }, translateWith(props.t, "help.faqTitle")), (0, react.createElement)("ul", { className: "pbb-helpList" }, (0, react.createElement)("li", null, translateWith(props.t, "help.faq1")), (0, react.createElement)("li", null, translateWith(props.t, "help.faq2")), (0, react.createElement)("li", null, translateWith(props.t, "help.faq3")), (0, react.createElement)("li", null, translateWith(props.t, "help.faq4")))), (0, react.createElement)("div", { className: "pbb-helpSection" }, (0, react.createElement)("div", { className: "pbb-helpHeading" }, translateWith(props.t, "help.securityTitle")), (0, react.createElement)("ul", { className: "pbb-helpList" }, (0, react.createElement)("li", null, translateWith(props.t, "help.security1")), (0, react.createElement)("li", null, translateWith(props.t, "help.security2")), (0, react.createElement)("li", null, translateWith(props.t, "help.security3")), (0, react.createElement)("li", null, translateWith(props.t, "help.security4")), (0, react.createElement)("li", null, translateWith(props.t, "help.security5"))), (0, react.createElement)("p", { className: "pbb-helpText" }, translateWith(props.t, "help.docsPrefix"), (0, react.createElement)("a", {
				className: "pbb-helpLink",
				href: "https://tailscale.com/docs/features/tailscale-funnel",
				target: "_blank",
				rel: "noreferrer"
			}, translateWith(props.t, "help.funnelDocs"))))))), report === null ? null : (0, react.createElement)("div", { className: "pbb-card" }, (0, react.createElement)("div", { className: "pbb-field" }, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "pair.qrPanelTitle")), pairingTarget === null ? (0, react.createElement)("span", { className: "pbb-value pbb-bad" }, translateWith(props.t, "pair.noAddress")) : (0, react.createElement)("span", { className: "pbb-tokenActions" }, (0, react.createElement)("span", { className: "pbb-badge" }, pairingTarget.kind === "public" ? translateWith(props.t, "pair.kind.public") : translateWith(props.t, "pair.kind.lan")), (0, react.createElement)("button", {
				type: "button",
				className: "pbb-action",
				disabled: qrBusy || !report.tokenReady,
				onClick: () => {
					if (qrDataURL === null) showPairingQR();
					else setQRDataURL(null);
				}
			}, qrBusy ? translateWith(props.t, "pair.qrGenerating") : qrDataURL === null ? translateWith(props.t, "pair.qrShow") : translateWith(props.t, "pair.qrHide")))), pairingTarget === null ? (0, react.createElement)("p", { className: "pbb-diag pbb-diagBad" }, translateWith(props.t, "pair.noAddressHelp")) : null, qrMessage ? (0, react.createElement)("p", { className: "pbb-diag" }, qrMessage) : null, pairingTarget === null || qrDataURL === null ? null : (0, react.createElement)("div", { className: "pbb-qrPanel" }, (0, react.createElement)("img", {
				className: "pbb-qrImage",
				src: qrDataURL,
				alt: translateWith(props.t, "pair.qrAlt")
			}), (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("code", { className: "pbb-token" }, pairingTarget.host), (0, react.createElement)("button", {
				type: "button",
				className: "pbb-action",
				onClick: () => copyRemoteURL(pairingTarget.host)
			}, translateWith(props.t, "panel.tokenAction.copy"))), (0, react.createElement)("p", { className: "pbb-qrHint" }, translateWith(props.t, "pair.qrHint", { kind: pairingTarget.kind === "public" ? translateWith(props.t, "pair.kind.public") : translateWith(props.t, "pair.kind.lan") }))))), (0, react.createElement)("div", { className: "pbb-card" }, (0, react.createElement)("div", { className: "pbb-field" }, primaryRows, advancedRows.length > 0 ? (0, react.createElement)("details", { className: "pbb-help" }, (0, react.createElement)("summary", null, translateWith(props.t, "advanced.summary")), (0, react.createElement)("div", { className: "pbb-helpBody" }, advancedRows)) : null)), (0, react.createElement)("div", { className: "pbb-card" }, (0, react.createElement)("div", { className: "pbb-field" }, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "push.relayTitle")), (0, react.createElement)("span", { className: "pbb-tokenActions" }, (0, react.createElement)("button", {
				type: "button",
				className: "pbb-action",
				disabled: relayTestBusy,
				onClick: runRelayTest
			}, relayTestBusy ? translateWith(props.t, "push.relayTesting") : translateWith(props.t, "push.testRelay")), (0, react.createElement)("button", {
				type: "button",
				className: "pbb-action",
				disabled: pushTestBusy,
				onClick: sendPushTest
			}, pushTestBusy ? translateWith(props.t, "push.pushSending") : translateWith(props.t, "push.testPush")))), relayTestError ? (0, react.createElement)("p", { className: "pbb-diag pbb-diagBad" }, relayTestError) : null, relayTestResult === null ? (0, react.createElement)("p", { className: "pbb-diag" }, translateWith(props.t, "push.relayDefault")) : (0, react.createElement)("div", { className: "pbb-helpBody" }, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, relayTestResult.url || translateWith(props.t, "push.relayUrlEmpty")), (0, react.createElement)("code", { className: "pbb-token " + (relayTestResult.overall === "ok" ? "pbb-ok" : "pbb-bad") }, relayTestResult.overall === "ok" ? translateWith(props.t, "push.relayOk") : translateWith(props.t, "push.relayBad"))), relayTestResult.steps.map((step, index) => (0, react.createElement)("p", {
				className: "pbb-diag",
				key: String(index)
			}, (step.ok ? "✓ " : "✗ ") + (step.id === "health" ? translateWith(props.t, "push.relayStep.health") : translateWith(props.t, "push.relayStep.enroll")) + (step.latencyMs !== void 0 ? ` (${String(step.latencyMs)}ms)` : "") + " — " + step.message))), pushTestError ? (0, react.createElement)("p", { className: "pbb-diag pbb-diagBad" }, pushTestError) : null, pushTestResult === null ? (0, react.createElement)("p", { className: "pbb-diag" }, translateWith(props.t, "push.pushDefault")) : (0, react.createElement)("div", { className: "pbb-helpBody" }, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("code", { className: "pbb-token " + (pushTestResult.overall === "sent" ? "pbb-ok" : pushTestResult.overall === "failed" ? "pbb-bad" : "") }, pushTestResult.overall === "sent" ? translateWith(props.t, "push.pushSent") : pushTestResult.overall === "failed" ? translateWith(props.t, "push.pushFailed") : pushTestResult.overall === "no-targets" ? translateWith(props.t, "push.pushNoTargets") : translateWith(props.t, "push.pushNotEnabled"))), pushTestResult.message ? (0, react.createElement)("p", { className: "pbb-diag" }, pushTestResult.message) : null, pushTestResult.results.map((r, index) => (0, react.createElement)("p", {
				className: "pbb-diag",
				key: String(index)
			}, (r.outcome === "sent" ? "✓ " : "✗ ") + r.name + " [" + r.environment + "] — " + r.outcome + (r.reason ? "（" + r.reason + "）" : "") + (r.tokenFingerprint ? "　token:" + r.tokenFingerprint + "…" : "")))))), (0, react.createElement)("div", { className: "pbb-card" }, (0, react.createElement)("div", { className: "pbb-field" }, (0, react.createElement)("div", { className: "pbb-row" }, (0, react.createElement)("span", { className: "pbb-label" }, translateWith(props.t, "devices.title")), (0, react.createElement)("span", { className: "pbb-badge" }, String(report !== null ? report.devices.length : 0))), deviceTable)), report === null ? null : (0, react.createElement)("div", { className: "pbb-versionFooter" }, (0, react.createElement)("span", null, "DeepPilot v" + report.pluginVersion), report.updateAvailable === true ? (0, react.createElement)("a", {
				href: typeof report.releaseUrl === "string" && /^https:\/\//.test(report.releaseUrl) ? report.releaseUrl : "https://github.com/Mars-Sea/dsh-deeppilot/releases",
				target: "_blank",
				rel: "noreferrer"
			}, translateWith(props.t, "update.badge")) : null), diag.length > 0 ? (0, react.createElement)("p", { className: "pbb-diag" + (failed ? " pbb-diagBad" : "") }, translateWith(props.t, "diag.prefix") + diag.join(" | ")) : null);
		}
		//#endregion
		//#region src/client/index.ts
		/** Polls the report remote and owns the page state transitions. */
		var ReportController = class {
			fetchReport;
			t;
			listeners = /* @__PURE__ */ new Set();
			snap = {
				status: "loading",
				report: null,
				message: ""
			};
			constructor(fetchReport, t) {
				this.fetchReport = fetchReport;
				this.t = t;
			}
			state() {
				return this.snap;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			}
			dispose() {
				this.listeners.clear();
			}
			async refresh() {
				try {
					const report = await this.fetchReport();
					this.snap = report !== null ? {
						status: "ready",
						report,
						message: ""
					} : {
						status: "error",
						report: null,
						message: this.t("diag.mountFailed")
					};
				} catch (error) {
					this.snap = {
						status: "error",
						report: null,
						message: error instanceof Error ? error.message : String(error)
					};
				}
				this.emit();
			}
			emit() {
				for (const listener of [...this.listeners]) try {
					listener();
				} catch {}
			}
		};
		const inject = [
			"slots",
			"locale",
			"remote",
			"settingsScope"
		];
		function apply(ctx) {
			if (typeof document !== "undefined") injectCss();
			const anyCtx = ctx;
			ctx.effect(() => registerLocale(ctx), "dsh-deeppilot: locale dictionaries");
			let namespace;
			let mountError;
			const fetchReport = async () => {
				if (namespace === void 0) throw new Error(mountError !== void 0 ? t(ctx, "diag.mountFailedShort") + mountError : t(ctx, "diag.remoteUnmounted"));
				const result = await namespace.report();
				if (!result.ok) throw new Error(result.error.message ?? t(ctx, "diag.callFailed"));
				return result.value;
			};
			const tPage = (key, vars) => t(ctx, key, vars);
			const controller = new ReportController(fetchReport, tPage);
			ctx.effect(() => () => controller.dispose(), "dsh-deeppilot: report controller");
			const store = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)(controller.state());
			controller.subscribe(() => store.set(controller.state()));
			ctx.effect(() => {
				let cancelled = false;
				let unmount;
				if (anyCtx.remote === void 0) {
					mountError = t(ctx, "diag.remoteUnavailable");
					controller.refresh();
					return () => {};
				}
				mountReportRemote(anyCtx.remote, () => ctx.get("remote.deeppilot")).then((mounted) => {
					if (cancelled) {
						mounted.dispose();
						return;
					}
					namespace = mounted.namespace;
					unmount = mounted.dispose;
					mountError = void 0;
					controller.refresh();
				}, (error) => {
					mountError = error instanceof Error ? error.message : String(error);
					controller.refresh();
				});
				return () => {
					cancelled = true;
					namespace = void 0;
					if (unmount !== void 0) unmount();
				};
			}, "dsh-deeppilot: report remote mount");
			const revealPairingToken = async () => {
				if (namespace === void 0) throw new Error(mountError !== void 0 ? t(ctx, "diag.mountFailedShort") + mountError : t(ctx, "diag.remoteUnmounted"));
				const result = await namespace.revealToken();
				if (!result.ok) throw new Error(result.error.message ?? t(ctx, "panel.tokenRevealFailed"));
				return result.value;
			};
			const sendTestPush = async () => {
				if (namespace === void 0) throw new Error(mountError !== void 0 ? t(ctx, "diag.mountFailedShort") + mountError : t(ctx, "diag.remoteUnmounted"));
				if (typeof namespace.testPush !== "function") throw new Error(t(ctx, "push.staleHostPush"));
				const result = await namespace.testPush();
				if (!result.ok) throw new Error(result.error.message ?? t(ctx, "push.pushFailed"));
				return result.value;
			};
			const testRelayConnection = async () => {
				if (namespace === void 0) throw new Error(mountError !== void 0 ? t(ctx, "diag.mountFailedShort") + mountError : t(ctx, "diag.remoteUnmounted"));
				if (typeof namespace.testRelay !== "function") throw new Error(t(ctx, "push.staleHostPushRelay"));
				const result = await namespace.testRelay();
				if (!result.ok) throw new Error(result.error.message ?? t(ctx, "push.relayBad"));
				return result.value;
			};
			const rotatePairingToken = async () => {
				if (namespace === void 0) throw new Error(mountError !== void 0 ? t(ctx, "diag.mountFailedShort") + mountError : t(ctx, "diag.remoteUnmounted"));
				const result = await namespace.rotateToken();
				if (!result.ok) throw new Error(result.error.message ?? t(ctx, "panel.tokenRotateFailed"));
				return result.value;
			};
			const enabledStore = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				status: "loading",
				enabled: true
			});
			const scope = anyCtx.settingsScope?.bind({ namespace: "deeppilot" });
			const adoptEnabled = () => {
				if (scope === void 0) return;
				const snap = scope.getSnapshot();
				if (snap.status === "ready" && snap.value !== void 0) enabledStore.set({
					status: "ready",
					enabled: snap.value.enabled !== false
				});
				else if (snap.status === "unavailable") enabledStore.set({
					status: "unavailable",
					enabled: true
				});
			};
			if (scope !== void 0) {
				scope.subscribe(adoptEnabled);
				adoptEnabled();
			}
			const lastConfirmedEnabled = () => {
				const snap = scope?.getSnapshot();
				if (snap?.status === "ready" && snap.value !== void 0) return snap.value.enabled !== false;
				return enabledStore.getSnapshot().enabled;
			};
			const lastConfirmedRemoteEnabled = () => {
				const snap = scope?.getSnapshot();
				if (snap?.status === "ready") return snap.value?.remote?.enabled === true;
				return remoteEnabledStore.getSnapshot().enabled;
			};
			const lastConfirmedRemoteConnectionLimit = () => {
				const snap = scope?.getSnapshot();
				if (snap?.status === "ready") return normalizeFunnelConnectionLimit(snap.value?.remote?.maxConnectionsPerSource);
				return remoteConnectionLimitStore.getSnapshot().value;
			};
			const setDeepPilotEnabled = (value) => {
				const previous = lastConfirmedEnabled();
				enabledStore.set({
					status: "ready",
					enabled: value
				});
				if (scope === void 0) return;
				scope.set("enabled", value).then(() => {}, (error) => {
					enabledStore.set({
						status: "ready",
						enabled: previous
					});
					const message = error instanceof Error ? error.message : String(error);
					console.error("[deeppilot] failed to persist enabled=" + String(value) + ": " + message);
				});
			};
			const remoteEnabledStore = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				status: "loading",
				enabled: false
			});
			const remoteConnectionLimitStore = (0, _deepseek_ai_dsh_client_runtime_client.createSnapshotStore)({
				status: "loading",
				value: 8
			});
			const adoptRemoteEnabled = () => {
				if (scope === void 0) return;
				const snap = scope.getSnapshot();
				if (snap.status === "ready") {
					remoteEnabledStore.set({
						status: "ready",
						enabled: snap.value?.remote?.enabled === true
					});
					remoteConnectionLimitStore.set({
						status: "ready",
						value: normalizeFunnelConnectionLimit(snap.value?.remote?.maxConnectionsPerSource)
					});
				} else if (snap.status === "unavailable") {
					remoteEnabledStore.set({
						status: "unavailable",
						enabled: false
					});
					remoteConnectionLimitStore.set({
						status: "unavailable",
						value: 8
					});
				}
			};
			if (scope !== void 0) {
				scope.subscribe(adoptRemoteEnabled);
				adoptRemoteEnabled();
			}
			const setDeepPilotRemoteEnabled = (value) => {
				const previous = lastConfirmedRemoteEnabled();
				remoteEnabledStore.set({
					status: "ready",
					enabled: value
				});
				if (scope === void 0) return;
				const currentRemote = scope.getSnapshot().value?.remote ?? {};
				scope.set("remote", {
					...currentRemote,
					enabled: value
				}).then(() => {}, (error) => {
					remoteEnabledStore.set({
						status: "ready",
						enabled: previous
					});
					const message = error instanceof Error ? error.message : String(error);
					console.error("[deeppilot] failed to persist remote.enabled=" + String(value) + ": " + message);
				});
			};
			const setDeepPilotRemoteConnectionLimit = async (value) => {
				const next = normalizeFunnelConnectionLimit(value);
				if (next !== value) throw new RangeError("maxConnectionsPerSource must be an integer between 1 and 16");
				if (scope === void 0) throw new Error("settings scope unavailable");
				const previous = lastConfirmedRemoteConnectionLimit();
				remoteConnectionLimitStore.set({
					status: "ready",
					value: next
				});
				const currentRemote = scope.getSnapshot().value?.remote ?? {};
				try {
					await scope.set("remote", {
						...currentRemote,
						maxConnectionsPerSource: next
					});
				} catch (error) {
					remoteConnectionLimitStore.set({
						status: "ready",
						value: previous
					});
					const message = error instanceof Error ? error.message : String(error);
					console.error("[deeppilot] failed to persist remote.maxConnectionsPerSource=" + String(next) + ": " + message);
					throw error;
				}
			};
			if (anyCtx.slots === void 0) console.error("[deeppilot] settings slots service unavailable; the DeepPilot section will not appear");
			anyCtx.slots?.inject("settings.section", () => anyCtx.slots.register({
				name: "settings.section",
				id: "deeppilot",
				order: 13,
				label: () => {
					const bind = anyCtx.locale?.bind("settings.deeppilot");
					return bind ? bind("nav") : "DeepPilot";
				},
				locale: "settings.deeppilot",
				inject: () => ({
					hooks: {
						deepPilotReport: store,
						deepPilotEnabled: enabledStore,
						deepPilotRemoteEnabled: remoteEnabledStore,
						deepPilotRemoteConnectionLimit: remoteConnectionLimitStore
					},
					refresh: () => {
						controller.refresh();
					},
					revealPairingToken,
					rotatePairingToken,
					testRelay: testRelayConnection,
					testPush: sendTestPush,
					setDeepPilotEnabled,
					setDeepPilotRemoteEnabled,
					setDeepPilotRemoteConnectionLimit,
					t: (key, vars) => t(ctx, key, vars)
				})
			}, DeepPilotSettingsPage));
		}
		//#endregion
		exports.DeepPilotSettingsPage = DeepPilotSettingsPage;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map