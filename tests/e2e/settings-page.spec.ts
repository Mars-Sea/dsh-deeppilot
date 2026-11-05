import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const addPhone = (page: Page) => page.getByRole('button', { name: '添加手机', exact: true })
const more = (page: Page, name = 'iPhone 17 Pro') => page.getByLabel(`设备“${name}”的更多操作`, { exact: true })
const operations = async (page: Page): Promise<Record<string, number>> =>
  JSON.parse((await page.getByTestId('fixture-operations').textContent())!)

for (const theme of ['light', 'dark']) {
  for (const width of [1000, 390, 320]) {
    test(`${theme} / ${width}px：字号、图标、布局与默认层级`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/?theme=${theme}`)
      await expect(page.getByRole('heading', { name: '已配对设备', exact: true })).toBeVisible()
      await expect(page.locator('.pbb-deviceRow')).toHaveCount(4)
      await expect(page.locator('.pbb-statusStrip')).toHaveCount(0)
      await expect(page.getByLabel('局域网端口', { exact: true })).toBeHidden()
      await expect(page.getByRole('button', { name: '发送测试通知', exact: true })).toBeHidden()
      await expect(page.getByText('设备身份认证', { exact: true })).toBeHidden()
      await expect(addPhone(page)).toHaveCSS('height', '30px')
      await expect(addPhone(page)).toHaveCSS('font-size', '14px')
      await expect(addPhone(page)).toHaveCSS('border-style', 'solid')
      await expect(page.locator('.pbb-refresh')).toHaveCSS('height', '28px')
      const metrics = await page.locator('.pbb-section').evaluate((root) => {
        const textElements = [...root.querySelectorAll('*')].filter((el) =>
          el.getClientRects().length > 0 && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()))
        const problems = textElements.filter((el) => Number.parseFloat(getComputedStyle(el).fontSize) < 12)
          .map((el) => el.textContent)
        const color = (value: string): number[] => {
          const values = (value.match(/[\d.]+/g) ?? []).map(Number)
          return value.startsWith('color(') ? values.slice(0, 3).map((n) => n * 255) : values.slice(0, 3)
        }
        const luminance = (rgb: number[]): number => rgb.map((n) => {
          const v = n / 255
          return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
        }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i]!, 0)
        const contrastProblems = textElements.filter((el) => {
          let bg: Element | null = el
          while (bg && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(bg).backgroundColor)) bg = bg.parentElement
          if (!bg) return false
          const foreground = luminance(color(getComputedStyle(el).color))
          const background = luminance(color(getComputedStyle(bg).backgroundColor))
          return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05) < 4.5
        }).map((el) => el.textContent)
        const text = (root as HTMLElement).innerText
        return { overflow: root.scrollWidth > root.clientWidth, smallText: problems, contrastProblems,
          characterIcons: /[\p{Extended_Pictographic}\u2713\u2717]/u.test(text),
          documentCopy: /README|SKILL\.md|章节|文档名称/.test(text),
          allLinearIcons: [...root.querySelectorAll('svg')].every((svg) => svg.getAttribute('fill') === 'none'),
          height: root.getBoundingClientRect().height }
      })
      expect(metrics.overflow).toBe(false)
      expect(metrics.smallText).toEqual([])
      expect(metrics.contrastProblems).toEqual([])
      expect(metrics.characterIcons).toBe(false)
      expect(metrics.documentCopy).toBe(false)
      expect(metrics.allLinearIcons).toBe(true)
      if (width === 1000) expect(metrics.height).toBeLessThan(710)
      expect((await operations(page)).grants).toBe(0)
      if (process.env.SETTINGS_SCREENSHOT_DIR) {
        await mkdir(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true })
        await page.locator('.fixture-window').screenshot({ path: join(process.env.SETTINGS_SCREENSHOT_DIR, `settings-${theme}-${width}.png`) })
      }
    })
  }
}

test('折叠区退出焦点顺序，重新展开保留参数草稿，应用才保存', async ({ page }) => {
  await page.goto('/')
  const options = page.getByRole('button', { name: '局域网连接选项', exact: true })
  const port = page.getByLabel('局域网端口', { exact: true })
  await options.click()
  await port.fill('4000')
  await options.click()
  await expect(port).toBeHidden()
  await options.press('Tab')
  await expect(page.getByRole('switch', { name: '远程连接', exact: true })).toBeFocused()
  expect((await operations(page)).ports).toBe(0)
  await options.click()
  await expect(port).toHaveValue('4000')
  await page.getByRole('button', { name: '应用', exact: true }).filter({ visible: true }).click()
  await expect(page.getByText('局域网端口已保存，监听器正在重新加载。')).toBeVisible()
  expect((await operations(page)).ports).toBe(1)
  await port.fill('1')
  await expect(page.getByRole('button', { name: '应用', exact: true }).filter({ visible: true })).toBeDisabled()
  await port.press('Enter')
  expect((await operations(page)).ports).toBe(1)
})

test('连接上限与帮助分别展开，保存沿用原回调', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '远程连接选项', exact: true }).click()
  await expect(page.getByText('推荐设置流程', { exact: true })).toBeHidden()
  await page.getByLabel('每个公网来源的连接上限', { exact: true }).fill('12')
  await page.getByRole('button', { name: '应用', exact: true }).filter({ visible: true }).click()
  expect((await operations(page)).limits).toBe(1)
  await page.getByText('远程连接帮助', { exact: true }).click()
  await expect(page.getByText('推荐设置流程', { exact: true })).toBeVisible()
})

test('设备详情按需显示，Escape 和点击外部关闭，重命名可取消和保存', async ({ page }) => {
  await page.goto('/')
  await more(page).click()
  await expect(page.getByText('1'.repeat(64), { exact: true })).toBeVisible()
  await more(page).press('Escape')
  await expect(page.getByText('1'.repeat(64), { exact: true })).toBeHidden()
  await expect(more(page)).toBeFocused()
  await more(page).click()
  await page.getByRole('heading', { name: 'DeepPilot', exact: true }).click()
  await expect(page.getByText('1'.repeat(64), { exact: true })).toBeHidden()
  await more(page).click()
  await page.getByRole('button', { name: '重命名设备“iPhone 17 Pro”', exact: true }).click()
  const input = page.getByRole('textbox', { name: '设备名称', exact: true })
  await expect(input).toBeFocused()
  await input.fill('取消的名称')
  await input.press('Escape')
  expect((await operations(page)).renames).toBe(0)
  await more(page).click()
  await page.getByRole('button', { name: '重命名设备“iPhone 17 Pro”', exact: true }).click()
  await input.fill('工作手机')
  await input.press('Enter')
  await expect(page.getByText('工作手机', { exact: true })).toBeVisible()
  expect((await operations(page)).renames).toBe(1)
})

test('删除必须先确认，取消不调用撤销，确认只删除目标设备', async ({ page }) => {
  await page.goto('/')
  const remove = page.getByRole('button', { name: '删除设备“iPhone 17 Pro”', exact: true })
  await more(page).click()
  await remove.click()
  await expect(page.getByRole('alert')).toContainText('iPhone 17 Pro')
  expect((await operations(page)).revokes).toBe(0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.pbb-deviceRow')).toHaveCount(4)
  await more(page).click()
  await remove.click()
  await remove.filter({ visible: true }).click()
  await expect(page.locator('.pbb-deviceRow')).toHaveCount(3)
  await expect(page.getByText('iPhone 18 Pro', { exact: true })).toBeVisible()
  expect((await operations(page)).revokes).toBe(1)
})

test('配对按需生成，切换网络仍展开并使用新凭据，复制及关闭有效', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/?scenario=dual')
  expect((await operations(page)).grants).toBe(0)
  await addPhone(page).click()
  await expect(page.getByRole('img', { name: 'DeepPilot 配对二维码' })).toBeVisible()
  const info = page.locator('.pbb-pairCode')
  await expect(info).toContainText('192.168.1.20')
  await page.getByRole('button', { name: '公网 · https://fixture.example.test', exact: true }).click()
  await expect(info).toContainText('fixture.example.test')
  await expect(page.getByRole('img', { name: 'DeepPilot 配对二维码' })).toBeVisible()
  expect((await operations(page)).grants).toBe(2)
  await page.getByTestId('pairingInfoCopy').click()
  await expect(page.getByRole('status')).toContainText('配对信息已复制')
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  expect(copied).toBe(await info.textContent())
  await page.getByRole('button', { name: '收起', exact: true }).click()
  await expect(page.getByRole('img', { name: 'DeepPilot 配对二维码' })).toHaveCount(0)
})

test('配对失败可重试，过期后不能继续显示旧码', async ({ page }) => {
  await page.clock.install()
  await page.goto('/?scenario=pair-error')
  await addPhone(page).click()
  await expect(page.getByRole('alert')).toContainText('二维码生成失败')
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('img', { name: 'DeepPilot 配对二维码' })).toBeVisible()
  await page.clock.fastForward(300001)
  await expect(page.getByRole('img', { name: 'DeepPilot 配对二维码' })).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('配对码已过期')
})

test('关闭连接时添加入口给出恢复提示，不签发配对码', async ({ page }) => {
  await page.goto('/?scenario=unavailable')
  await addPhone(page).click()
  await expect(page.getByText('请先开启“允许手机连接”，再添加手机。')).toBeVisible()
  expect((await operations(page)).grants).toBe(0)
})

test('错误与历史记录使用中文结论，保留括号内原码，诊断工具可正常使用', async ({ page }) => {
  await page.goto('/?scenario=error')
  await expect(page.getByRole('alert').filter({ hasText: '局域网连接异常' })).toContainText('（EADDRINUSE）')
  await expect(page.getByRole('alert').filter({ hasText: '远程连接异常' })).toContainText('（ECONNREFUSED）')
  await expect(page.getByText('3 条历史失败记录', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /诊断工具/ }).click()
  await expect(page.getByText(/连接异常断开.*（connection-closed \/ abnormal-close）/).first()).toBeVisible()
  await page.getByRole('button', { name: '测试访问与注册', exact: true }).click()
  await expect(page.getByText('通过', { exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '发送测试通知', exact: true }).click()
  expect((await operations(page)).pushes).toBe(1)
})

test('长设备名、空列表、报告加载、待授权与英文界面可用', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 })
  await page.goto('/?scenario=long')
  expect(await page.locator('.pbb-section').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await more(page, '工作手机用于跨设备测试的超长名称'.repeat(8)).click()
  await expect(page.getByText('密钥指纹', { exact: true }).first()).toBeVisible()
  await page.goto('/?scenario=empty')
  await expect(page.locator('.pbb-empty')).toBeVisible()
  await expect(addPhone(page)).toBeEnabled()
  await page.goto('/?scenario=loading')
  await expect(addPhone(page)).toBeDisabled()
  await expect(page.getByText('正在读取状态…', { exact: true })).toBeVisible()
  await page.goto('/?scenario=report-error')
  await expect(page.locator('.pbb-diagnostics')).toContainText('读取连接状态失败（E_FIXTURE_REPORT）')
  await page.goto('/?scenario=login')
  await expect(page.getByRole('link', { name: '打开授权页面', exact: true })).toHaveAttribute('href', 'https://login.example.test/authorize')
  await page.goto('/?locale=en')
  await expect(page.getByRole('button', { name: 'Add phone', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Paired devices', exact: true })).toBeVisible()
})

test('重命名失败保留编辑内容，中文说明包含原始错误码', async ({ page }) => {
  await page.goto('/?scenario=rename-error')
  await more(page).click()
  await page.getByRole('button', { name: '重命名设备“iPhone 17 Pro”', exact: true }).click()
  const input = page.getByRole('textbox', { name: '设备名称', exact: true })
  await input.fill('需要保留的名称')
  await input.press('Enter')
  await expect(page.getByRole('status')).toContainText('（E_FIXTURE_RENAME）')
  await expect(input).toHaveValue('需要保留的名称')
  expect((await operations(page)).renames).toBe(0)
})

test('触屏操作维持 44px 点击区域，减少动态效果时没有移动动画', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:4781/')
  await expect(addPhone(page)).toHaveCSS('min-height', '44px')
  await expect(page.locator('.pbb-section')).toHaveCSS('animation-name', 'none')
  await context.close()
})
