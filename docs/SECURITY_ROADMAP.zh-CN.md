# 协议 v2 安全状态

[English](./SECURITY_ROADMAP.md)

状态：已在开发分支实现，`PROTOCOL.md` 为规范来源。不保留协议 v1，所有设备都需要重新配对。

## 已实现

- 5 分钟有效、单次使用的高熵配对码；
- P-256 设备身份；iOS 真机使用 Secure Enclave，模拟器使用钥匙串回退；
- 每次连接使用 nonce、audience 和时间戳完成挑战签名；
- 主机侧公钥指纹、单设备 scope 和即时撤销；
- 匿名入口限速、来源封禁、未认证连接并发上限和设备表容量上限；
- 最小化匿名探活响应，不接受 Bearer 或 URL 凭据；
- 隐私化审计标识、全局连接开关和逐设备删除入口；scope 继续由协议层强制执行。

- TypeScript 与 Swift 测试共用的固定规范化编码/签名向量（`tests/fixtures/auth-vectors.json`），签名分别来自 Node 与 CryptoKit；
- 畸形请求、连接抖动、重放、挑战过期/被篡改和多来源压力的滥用测试（`tests/auth-hardening.test.ts`）；
- `devices-v2.json` 丢失后的本机恢复流程（[DEVICE_REGISTRY_RECOVERY.zh-CN.md](./DEVICE_REGISTRY_RECOVERY.zh-CN.md)）。

## 已决定

- 高影响审批响应**不**要求新的本地生物识别/用户在场确认（2026-10-12 决定）。如威胁模型变化（例如手机多人共用）再重新评估。

## 发布前剩余验证

- 通过真实 LAN 与 Funnel 验证配对、重连/恢复和逐设备删除；
- 已认证的 socket 仍会接受第二次 `c2s.auth.prove`，并再回一次 welcome 与重放；门应改为回 `E_PROTOCOL`（以 `todo` 测试跟踪）；
- 保持依赖扫描与 CodeQL 通过，并在宣称生产可用前签名、公证所有分发 helper。
