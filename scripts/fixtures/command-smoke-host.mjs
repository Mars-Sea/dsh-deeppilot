import http from 'node:http'

export const name = 'command-smoke-host'
export const inject = ['deeppilotReport']

/** 只为隔离主机提供固定模型响应和正常单次配对码，不替代任何指令服务。 */
export function apply(ctx) {
  if (process.env.DEEPPILOT_COMMAND_SMOKE !== '1') throw new Error('仅允许在显式启用的隔离验收主机挂载')
  let requests = 0
  const model = http.createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return }
    try {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const base = { id: `chatcmpl-smoke-${++requests}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model }
      const content = '合成会话验收完成。用户仅要求检查移动端指令和缓存。此前已读取测试附件并记录结果；没有待执行工具或外部操作。保留这段背景作为后续会话摘要。'
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const choice of [{ delta: { role: 'assistant', content }, finish_reason: null }, { delta: {}, finish_reason: 'stop' }]) {
        res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, ...choice }] }) + '\n\n')
      }
      res.write('data: ' + JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 } }) + '\n\n')
      res.end('data: [DONE]\n\n')
    } catch { res.writeHead(400); res.end() }
  }).listen(3188, '127.0.0.1')
  const pairing = http.createServer(async (req, res) => {
    if (req.url !== '/pair') { res.writeHead(404); res.end(); return }
    try {
      const service = ctx.get('deeppilotReport')
      const grant = await service.beginPairing()
      const report = await service.report()
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ...grant, tlsFingerprint: report.local.tlsFingerprint }))
    } catch { res.writeHead(500); res.end() }
  }).listen(3199, '127.0.0.1')
  ctx.on('dispose', () => { model.close(); pairing.close() })
}
