/**
 * 本机预览（能力 `localPreview`）的准入规则：哪些 URL、哪些端口允许手机经预览连接访问。
 *
 * 为什么单独成模块：转发本身（preview-tunnel.ts）只搬字节；「能不能连」是安全判定，
 * 必须是纯函数、逐条有测试。规则见 PROTOCOL.md「本机预览扩展」：
 * - 只认带显式端口的 `http://127.0.0.1`、`http://localhost`、`http://[::1]`；
 * - 插件自身端口与 DSH Web 默认端口永远拒绝（手机拿到它们等于绕过设备认证面）；
 * - 端口必须在该会话的消息里出现过（由调用方查历史，这里只给出要找的文本）。
 */

/** DSH Web 默认端口。插件拿不到宿主实际监听的端口，按默认值保守拒绝。 */
export const DSH_WEB_DEFAULT_PORT = 3080

/** 规范化后的本机预览目标。 */
export interface LoopbackTarget {
  /** URL 原文里的主机名（`[::1]` 保留方括号），也是会话消息里要找的写法。 */
  hostname: '127.0.0.1' | 'localhost' | '[::1]'
  port: number
  /** `http://<hostname>:<port>`，回给手机，作为网页视图要打开的源。 */
  origin: string
  /** 会话消息里必须出现的文本：`<hostname>:<port>`。 */
  mention: string
  /** 电脑上实际连接的地址，按顺序尝试（localhost 先 IPv4 后 IPv6）。 */
  connectHosts: readonly string[]
}

const CONNECT_HOSTS: Record<LoopbackTarget['hostname'], readonly string[]> = {
  '127.0.0.1': ['127.0.0.1'],
  localhost: ['127.0.0.1', '::1'],
  '[::1]': ['::1'],
}

/**
 * 解析手机发来的 URL。不是 http、主机名不是三种回环写法之一、没有显式端口、
 * 带用户名密码时一律返回 undefined（对应 reason `bad-url`）。
 */
export function parseLoopbackUrl(raw: string): LoopbackTarget | undefined {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:') return undefined
  if (url.username !== '' || url.password !== '') return undefined
  const hostname = url.hostname.toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return undefined
  // URL 会把默认端口 80 归一成空串；本机预览要求链接写明端口，避免把「80」误当成显式授权。
  if (url.port === '') return undefined
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  const host = hostname as LoopbackTarget['hostname']
  return {
    hostname: host,
    port,
    origin: `http://${host}:${port}`,
    mention: `${host}:${port}`,
    connectHosts: CONNECT_HOSTS[host],
  }
}

/** 端口是否在保留名单里（插件自身端口、DSH Web 默认端口）。 */
export function isReservedPreviewPort(port: number, reserved: Iterable<number>): boolean {
  if (port === DSH_WEB_DEFAULT_PORT) return true
  for (const value of reserved) if (value === port) return true
  return false
}
