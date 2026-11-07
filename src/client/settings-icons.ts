import { createElement as h } from 'react'

type IconName = 'phone' | 'wifi' | 'globe' | 'window' | 'refresh' | 'plus' | 'more' | 'activity' | 'info' | 'ready' | 'attention'

/** 设置页的小图标共用线宽与 currentColor，随宿主主题变色，不额外引入图标包。 */
export function settingsIcon(name: IconName, size = 18): any {
  const path = (d: string): any => h('path', { d })
  const circle = (cx: number, cy: number, r: number): any => h('circle', { cx, cy, r })
  const shapes: Record<IconName, () => any[]> = {
    phone: () => [h('rect', { x: 6.5, y: 2.5, width: 11, height: 19, rx: 2.2 }), path('M10 5h4M11 18.5h2')],
    wifi: () => [path('M2 8.8a16 16 0 0 1 20 0M5 12.1a11 11 0 0 1 14 0M8.3 15.5a6 6 0 0 1 7.4 0'), circle(12, 19, .7)],
    globe: () => [circle(12, 12, 9), path('M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18')],
    window: () => [h('rect', { x: 3, y: 4.5, width: 18, height: 15, rx: 2.2 }), path('M3 9h18M6.5 6.8h.01M9 6.8h.01')],
    refresh: () => [path('M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17')],
    plus: () => [path('M12 5v14M5 12h14')],
    more: () => [circle(5, 12, 1.2), circle(12, 12, 1.2), circle(19, 12, 1.2)],
    activity: () => [path('M3 12h4l3-7 4 14 3-7h4')],
    info: () => [circle(12, 12, 9), path('M12 11v6M12 7h.01')],
    ready: () => [circle(12, 12, 9), path('m8 12 3 3 5-6')],
    attention: () => [circle(12, 12, 9), path('M12 7v6M12 17h.01')],
  }
  return h('svg', {
    className: 'pbb-icon', viewBox: '0 0 24 24', width: size, height: size,
    fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  }, ...shapes[name]())
}
