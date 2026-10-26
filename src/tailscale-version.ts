/**
 * 内嵌 helper 上报的 tailscale.com 模块版本。
 *
 * 版本的唯一来源是 helper 启动事件（`helper/main.go` 读 Go 构建信息里的
 * `tailscale.com` 依赖版本），不是 go.mod、也不是插件常量：用户可能通过
 * `remote.helperPath` 换成自己编译的 helper，界面必须显示实际在跑的那一个。
 *
 * 两条边界都要守卫：
 * - 宿主侧 `parseHelperEvent` 把 helper 的 stdout 当成不可信输入，格式不对
 *   就丢弃，避免把任意文本渲染进设置页；
 * - 设置页侧 `reportSchema` 同样校验 Host RPC 返回值，旧 Host 不带该字段
 *   时保持 undefined（页面显示「未获取」），不当作错误。
 *
 * 接受 Go 模块版本形态：`v1.104.2`、`v1.104.2-pre.1`、
 * `v0.0.0-20260101000000-abcdef123456`。长度上限防止异常输入撑爆界面。
 */
export const TAILSCALE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,64})?$/

const MAX_TAILSCALE_VERSION_LENGTH = 80

/** 判断外部输入是否是合法的 Tailscale 模块版本字符串。 */
export function isTailscaleVersion(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= MAX_TAILSCALE_VERSION_LENGTH &&
    TAILSCALE_VERSION_PATTERN.test(value)
}
