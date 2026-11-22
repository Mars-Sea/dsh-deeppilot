import test from 'node:test'
import assert from 'node:assert/strict'
import { bootApply } from './apply-harness.ts'
import { QUIET_COMPLETION_TOOL_NAME } from '../src/quiet-completion.ts'

// apply() 层面的注册门槛：只有宿主级计划任务（schedulesHost）才注册工具，
// 卸载时撤销注册。轮次与抑制逻辑见 quiet-completion.test.ts。

function fakeTools() {
  const registered: Array<{ name: string; when?: unknown }> = []
  let disposed = 0
  return {
    registered,
    disposedCount: () => disposed,
    service: {
      register(definition: { name: string }, options?: { when?: unknown }) {
        registered.push({ name: definition.name, when: options?.when })
        return () => { disposed += 1 }
      },
    },
  }
}

const hostSchedule = {
  edit: async () => ({}),
  list: async () => ({ tasks: [], shown: 0, total: 0, limit: 500, offset: 0 }),
}
test('宿主级计划任务：注册带 when 条件的工具，卸载时撤销', async (t) => {
  const tools = fakeTools()
  const harness = await bootApply({ services: { tools: tools.service, schedule: hostSchedule } })
  t.after(() => harness.dispose())
  assert.deepEqual(tools.registered.map((entry) => entry.name), [QUIET_COMPLETION_TOOL_NAME])
  assert.equal(typeof tools.registered[0].when, 'function')
  await harness.dispose()
  assert.equal(tools.disposedCount(), 1)
})

test('没有 schedule 服务时不注册工具', async (t) => {
  const tools = fakeTools()
  const harness = await bootApply({ services: { tools: tools.service, schedule: undefined } })
  t.after(() => harness.dispose())
  assert.deepEqual(tools.registered, [])
})
