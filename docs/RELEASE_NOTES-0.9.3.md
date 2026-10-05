# DeepPilot 0.9.3 — tailnet pairing targets and journal fsync tolerance

## English

Two independent fixes. **The phone protocol is unchanged**: no frame type was
added or removed, the protocol version stays at **2**, and already-paired phones
need no re-pairing.

### Fixed: a tailnet address could never become a pairing target

`localLANIPv4Addresses()` only kept RFC 1918 addresses, so an address in
`100.64.0.0/10` — the RFC 6598 shared address space that Tailscale and Headscale
both allocate node addresses from — was filtered out before it could ever be
advertised. The pairing QR was then pinned to the physical LAN address, and
stopped working as soon as the phone left that network. Tailscale was running on
both ends and the route was already there; the address simply never made it into
the QR.

The manual workaround did not exist either. The settings page already had a
target selector, but it only renders when there are two or more candidates
(`pairingTargets.length < 2 ? null : …`). With exactly one candidate it stayed
permanently hidden.

`isSharedAddressSpaceIPv4()` handles RFC 6598 rather than widening
`isPrivateIPv4()`, so that function's name stays honest about what it accepts.
`localLANIPv4Addresses()` now collects both classes, which means a tailnet
address becomes a candidate and the existing selector appears on its own.

**Ordering is deliberately unchanged.** Physical `en*` interfaces still sort
ahead of tunnel interfaces, so the default address in the pairing QR is still
your physical LAN address. What changed is only that the tailnet address is now
*selectable* — the existing selector handles the rest.

This is the case that makes self-hosted control planes work: **Headscale has no
Funnel** (unimplemented in its feature matrix, [#1040](https://github.com/juanfont/headscale/issues/1040)
closed `not_planned`), so a tailnet address is the only private remote option
available there. ([#24](https://github.com/Mars-Sea/dsh-deeppilot/issues/24))

### Fixed: one disk error disabled delivery on Windows

The dispatch journal treated a failing directory `fsync` as fatal, and the one
hard failure it raised disabled delivery entirely. Directory `fsync` is now
tolerated — best effort, as on every other platform — and a single non-fatal
error no longer takes delivery down.

### Not changed

Protocol v2 is unchanged and already-paired phones need no action. The Funnel
helpers, the relay client, push, widgets, live activities, and the pairing target
ordering are untouched.

### Verified before publishing

`npm ci`, unit tests (537 passing), TypeScript typecheck, production build, and
the config-schema check against a real `0.2.0-rc.2` CLI all pass locally. Go
helper tests and the helper binary checksums also pass; the helper binaries
themselves are unchanged in this release. `lib/` regenerates with no diff.

---

## 简体中文

两个互相独立的修复。**手机协议未变**：没有新增或移除任何帧类型，协议版本仍为
**2**，已配对的手机无需重新配对。

### 修复：tailnet 地址此前永远无法成为配对目标

`localLANIPv4Addresses()` 只保留 RFC 1918 地址，因此 `100.64.0.0/10`（RFC 6598
共享地址空间，Tailscale 与 Headscale 都从这里给节点分配地址）里的地址在进入
候选之前就被过滤掉了。配对二维码因此被钉死在物理局域网地址上，手机一离开那个
网络就连不上了——而此时 Tailscale 两端都在跑、路由本来就是通的，地址只是从来没
进过二维码。

手动绕过的方法同样不存在。设置页本来就有地址选择器，但它只在候选 ≥2 时才渲染
（`pairingTargets.length < 2 ? null : …`），候选恒为 1 个的时候它就永远不出现。

新增 `isSharedAddressSpaceIPv4()` 处理 RFC 6598，而不是去放宽
`isPrivateIPv4()`，好让后者的名字对它实际接受的输入保持诚实。
`localLANIPv4Addresses()` 现在同时收集两类地址，tailnet 地址因此成为候选，现成的
选择器会自己出现。

**排序刻意保持不变。** 物理 `en*` 接口仍然排在隧道接口之前，配对二维码里默认的
地址仍然是物理局域网地址。改变的只是「tailnet 地址现在可以被选中」这件事本身，
其余交给已有的选择器处理。

这正是自建控制平面能用的那一档：**Headscale 没有 Funnel**（其功能矩阵未实现，
[#1040](https://github.com/juanfont/headscale/issues/1040) 以 `not_planned`
关闭），tailnet 地址是那里唯一可用的私有远程方案。
（[#24](https://github.com/Mars-Sea/dsh-deeppilot/issues/24)）

### 修复：Windows 上一次磁盘错误会停用投递

派发日志此前把目录 `fsync` 失败当作致命错误，而它抛出的那一个硬失败会直接停用
整条投递。现在目录 `fsync` 被容忍——尽力而为，与其他所有平台一致——并且单次
非致命错误不再让投递停摆。

### 未变更

协议 v2 没有变化，已配对的手机无需任何操作。Funnel helper、relay 客户端、推送、
桌面小组件、实时活动，以及配对目标的排序均未改动。

### 发布前已验证

`npm ci`、单元测试（537 例通过）、TypeScript 类型检查、生产构建，以及针对真实
`0.2.0-rc.2` CLI 的 config schema 检查，均已本地通过。Go helper 测试与 helper
校验和同样通过；本版本没有改动 helper 二进制本身。`lib/` 重新生成后无差异。