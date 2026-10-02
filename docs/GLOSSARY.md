# GLOSSARY.md

> 架构评审与后续设计的共同词汇。域名词来自代码与 PROTOCOL.md；架构词来自
> `/codebase-design`，这里不重复登记。新增条目按章节各自独立编号，跨章引用带章节号。

## 一、域名（phone wire 协议）

### 1. wire 帧（wire frame）

手机与 Bridge 之间的一个协议消息，类型形如 `c2s.*` / `s2c.*`，以 `PROTOCOL.md`
为规范。帧的 TS 字面量住在 `src/wire-registry.ts`（`C2SType` / `S2CType`）。

### 2. phone wire 缝（phone wire seam）

Bridge 与手机之间的那条协议缝。host 侧的属主是 `src/wire-registry.ts`：所有帧的
事实（阶段、scope、widget 策略、能力门、校验、处理）都在那一行里。

### 3. wire 注册表（wire registry）

一帧一行的 module：`wire-registry.ts` 持表的形状、检查与 `dispatch`，handler 体按
特性住在 `wire-session` / `wire-schedule` / `wire-interaction` / `wire-push` /
`wire-device`。`connection.ts` 只保留传输、鉴权与 sink 接线。

### 4. 宿主能力探测（host capability probe）

判断 `ctx.apiProxy` 上某个方法是否存在的表达式，决定 `welcome.capabilities` 的
一位。属主是 `src/host-capabilities.ts` 的 `HOST_CAPABILITY_PROBES` 表；每位取
「该位所闸的帧真正需要的最小依赖」。`push` 位由推送出口就绪状态决定，且门禁必须
留在 handler 内（零配置注册先于能力门）。

### 5. 错误词表（error vocabulary）

Host 控制器错误码、Bridge 结果、wire `E_*` 码三种词之间的一一对应。唯一属主是
`src/wire-errors.ts`：每个域一张「Host code -> wire code」表，Bridge 失败结果直接
携带 wire 码。`E_BUSY` 与 `E_PROTOCOL` 决定客户端是否重试。

## 二、既有关联词

| 词 | 含义 | 属主 |
|---|---|---|
| journal | 持久 at-most-once 投递/变更记录 | `src/prompt-delivery.ts`、`src/mutation-journal.ts` |
| report Remote | 设置页读取的 Bridge 事实快照 | `src/report-wire.ts`、`src/report-service.ts` |
| Funnel / Relay | 两条对外传输：Tailscale Funnel 与自建中继 | `src/remote-supervisor.ts`、`src/relay-client.ts` |
