# DSH 0.2.2 能力接入

本轮在既有协议 v2 上增加三个可选能力。正式 wire 契约以 [PROTOCOL.md](../PROTOCOL.md) 为准；[TypeScript 镜像](../src/protocol.ts) 与私有 App 的 Swift 镜像同步。能力缺失时保留原有行为，不要求重新配对。DSH 版本兼容性审计另见 [发布记忆](./DSH_RELEASE_MEMORY.md)。

## 实际接口与阅读范围

已扫描此次发布的能力清单，精读下列实际调用面。其余新 Web 插件、推荐、共享与工作树模块未接入，也不作为本次兼容性声明依据。

| 上游接口 | 方法或来源 | 本次阅读 | 桥接用途 |
|---|---|---|---|
| `/api/session.markdown` | GET，经 `connection.createSharedFetchHandler('/api')` 的 owner 调用 | 已读路由注册、处理器和依赖 | 复用现有导出分块，返回正文 `.md` |
| `/api/session.export` | GET，`includeDescendants=true` | 已读 | 缺省 ZIP 原 URL、分块及回执保持不变 |
| `connection.fetchRoutes` / `sessionQuery.readSession` | 已注册路由及非激活读取 | 已读 | 真正有 Markdown 路由和读取依赖时才声明能力 |
| `agent/assistant-stream` | `{agent,frame}`；start / chunk / end | 已读类型与实际发射次序 | 生成独立、无重放序号的 `s2c.session.delta` |
| `session/event` | 持久事件先于 committed stream end | 已读 | final 前发出窗口尾部，以 `streamId` 替换临时输出 |
| `typert.getPackage` | 公开 host face 类型反射 | 已读 | 识别 `SessionAssistantStreamFrame`；缺反射只降级流能力 |
| `pluginManager.listVersions` / `registries` | 公开版本目录及软件源配置 | 已读 | 显示候选版本，读取精确协议声明，确定实际候选源 |
| `pluginManager.updateBundle` / `listBundles` | 精确版本更新、实际安装清单 | 已读 | 由宿主完成 HMR 替换和失败回滚，再核对安装与运行版本 |
| `plugin-manager/registry.registryPlan` | 公开软件源选择规则 | 已读并建立对照测试 | 预检宿主可能回退到的全部来源，禁止不同协议或完整性摘要绕过闸门 |
| npm 精确版本 manifest | GET `{registry}/dsh-deeppilot/{version}` | 已读并限制响应大小及超时 | 核对包名、精确版本、bundle、`deepPilot.protocolVersion` 与强 SRI |
| 其他新模块 | 新增包及发布清单 | 仅盘点 | 未接入，不引入额外产品行为 |

## 差异对照

| 类别 | 本轮范围内的状态 |
|---|---|
| 双方都有 | ZIP/Markdown 导出、瞬时流生命周期与正式事件关联、明确确认的更新及状态查询、兼容性闸门、宿主 HMR/回滚、断线后日志对账 |
| 上游有、我方未接 | 自动化任务批量清理、Web 引用交互、插件富文本详情及其他 Web 专属入口；本轮未扩展手机对应功能 |
| 我方有、上游没有 | 手机专用分块传输、独立瞬时 wire 帧、设备隔离的持久更新日志、App 协议版本闸门 |
| 双方都没有 | 不支持的宿主上强制重启进程、手机静默安装、替用户发布 npm/GitHub 版本 |

## 关键默认值与边界

- 导出缺省仍是 ZIP。Markdown 需要 `sessionMarkdown`，不会把旧桥接忽略 `format` 后返回的 ZIP 当作正文。Markdown 不含思考过程、系统指令及注入上下文。
- 流能力使用 `assistantStream`。50 ms 窗口只合并相邻同类文字，正文与推理保持到达顺序；容量满时提前发出。瞬时帧不占重放序号、不进入 APNs 或持久缓存；断线、弃置尝试及取消均丢弃未完成临时输出。
- 自更新使用 `pluginUpdate`；check 需要 `sessions.read`，apply 需要 `sessions.manage`，widget 均不可使用。查询不会安装，安装只由手机确认触发，不随断线取消或自动重试。
- 候选来源使用宿主真正的回退规则。所有可达源的精确目标必须具有相同协议和强完整性摘要；不可核验或不一致时拒绝受理。不会修改用户全局软件源配置。
- 更新接受回执在目标校验和日志耐久写入后发送。最近结果保留供重连对账；同请求编号不能更换目标，也不能重复安装。日志不保存凭据或会话内容，设备归属仅保存摘要并只向所属设备返回。
- “恢复”指 HMR 后重连并恢复当前会话。宿主无 HMR 时返回 `restart-required`；不会强杀宿主，不能声称已经自动重启。安装失败由宿主恢复旧版本，桥接只核验并呈现结果。

## 验证入口

插件用例：`tests/markdown-export.test.ts`、`tests/assistant-stream.test.ts`、`tests/plugin-update.test.ts`，以及 wire 注册表、历史适配和命令回归。iOS 测试及实机边界见私有项目的对接说明。真机、实际 npm 安装和 Funnel 验证不得由模拟或语法检查替代。
