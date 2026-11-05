/**
 * 设置页左侧导航里 DeepPilot 一行的图标。
 *
 * DSH 0.2.2 的设置壳为每个 `settings.section` 渲染
 * `renderSlot('settings.section.icon', { size, active }, { only: id, fallback })`：
 * 有同 id 的图标贡献就用它，否则画默认齿轮。壳负责按钮、文字和装饰性外框
 * （外框已 `aria-hidden`），图标只需按 `size` 画一个随文字颜色变化的线性 SVG。
 *
 * 不用 `icon.svg`：那是插件管理页的彩色品牌图（渐变填充、白底），放进导航行
 * 会和内置单色线性图标格格不入，也违反「图标统一用线性单色 SVG」的要求。
 * 这里画一部手机（DeepPilot 的职责是把手机接到这台电脑的 DSH），描边沿用
 * 设置页其他图标的 16×16 视图框和 1.5 线宽。
 */
import { createElement as h } from 'react'

/** 壳传入的图标属性（`SettingsSectionIconOwnerProps`）。`active` 由壳的样式
 *  体现（文字颜色经 currentColor 传到描边），图标本身不需要分支。 */
export interface NavIconProps {
  size?: number
  active?: boolean
}

/** 导航行默认边长；壳当前固定传 16。 */
const DEFAULT_NAV_ICON_SIZE = 16

export const DeepPilotNavIcon = ({ size }: NavIconProps): any => {
  const edge = typeof size === 'number' && size > 0 ? size : DEFAULT_NAV_ICON_SIZE
  return h('svg', {
    viewBox: '0 0 16 16',
    width: edge,
    height: edge,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: 'false',
  },
    // 机身
    h('rect', { x: 4.25, y: 1.75, width: 7.5, height: 12.5, rx: 1.75 }),
    // 底部指示条
    h('path', { d: 'M7 11.75h2' }),
  )
}
