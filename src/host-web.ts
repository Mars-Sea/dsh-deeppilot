/**
 * 电脑端网页（能力 `hostWeb`）：算出手机要打开的 DSH 网页端登录地址。
 *
 * 为什么能这样做（PROTOCOL.md「电脑端网页」）：DSH 网页端先校验 Host 必须是回环地址，
 * 再凭进程启动令牌换一个按 `主机:端口` 隔离的 Cookie。预览连接让手机在自己的回环地址上
 * 监听同一个端口，Host / Origin 与电脑本机访问完全一致；令牌则由宿主 `connection`
 * 服务在进程内生成，用户不必手动复制。
 *
 * 数据来源：宿主 `webServer`（实际监听地址、端口与协议）与 `connection`
 * （`authenticatedUrl`，给地址加上进程令牌）。两者都可能缺失（旧宿主或别的 profile），
 * 任一缺失、或网页端不在回环明文 HTTP 上监听（`--host`、TLS 部署），都视为不可用：
 * 那种部署下手机经预览隧道拿到的 Host 与 Cookie 作用域都对不上。
 *
 * 返回的 `url` 带登录令牌，属于凭据：调用方只能把它经已认证的预览连接下发，不得写日志。
 */

import { parseLoopbackUrl, type LoopbackTarget } from './preview-policy.ts'

/** 宿主 webServer 服务里本模块用到的部分。 */
export interface HostWebServerLike {
  /** 实际监听的端口；监听前为 undefined。无论协议与地址，都进本机预览的保留端口名单。 */
  readonly port?: number
  /** 监听的根地址，如 `http://127.0.0.1:3080`；监听前或地址无法写成 URL 时抛错。 */
  getOrigin?(): string
}

/** 宿主 connection 服务里本模块用到的部分。 */
export interface HostWebConnectionLike {
  /** 给网页端根地址加上进程登录令牌（`?token=…`）。 */
  authenticatedUrl?(baseUrl: string): string
}

export interface HostWebEntry {
  /** 网页端的回环目标：端口、手机要打开的源、电脑上实际连接的地址。 */
  readonly target: LoopbackTarget
  /** 带登录令牌的根地址；凭据，不得记录。 */
  readonly url: string
}

/** 网页端的回环目标；宿主不支持或不在回环明文 HTTP 上监听时为 undefined。 */
export function hostWebTarget(webServer: HostWebServerLike | undefined): LoopbackTarget | undefined {
  if (typeof webServer?.getOrigin !== 'function') return undefined
  let origin: string
  try {
    origin = webServer.getOrigin()
  } catch {
    return undefined
  }
  // parseLoopbackUrl 只认带显式端口的 http 回环地址：https、非回环监听在这里一并排除。
  return parseLoopbackUrl(origin + '/')
}

/** 生成登录地址；任一前提不满足时返回 undefined（对应 reason `hostweb-unavailable`）。 */
export function resolveHostWeb(
  webServer: HostWebServerLike | undefined,
  connection: HostWebConnectionLike | undefined,
): HostWebEntry | undefined {
  const target = hostWebTarget(webServer)
  if (target === undefined || typeof connection?.authenticatedUrl !== 'function') return undefined
  let url: string
  try {
    url = connection.authenticatedUrl(`${target.origin}/`)
  } catch {
    return undefined
  }
  return { target, url }
}
