import { createElement as h, useEffect, useRef } from 'react'
import type { Translate } from './i18n.ts'
import { settingsIcon } from './settings-icons.ts'

interface DeviceActionsProps {
  name: string
  fingerprint: string
  customName?: string
  canRename: boolean
  canRevoke: boolean
  onRename: () => void
  onRevoke: () => void
  t: Translate
}

/**
 * 原生 disclosure（折叠控件）负责 Enter/Space 与焦点顺序；操作仍是普通按钮，
 * 不冒充需要方向键导航的 ARIA menu。详情只在展开时进入无障碍读取顺序。
 */
export function DeviceActions(props: DeviceActionsProps): any {
  const ref = useRef<HTMLDetailsElement>(null)
  const close = (restoreFocus = false): void => {
    const details = ref.current
    if (details === null) return
    details.open = false
    if (restoreFocus) details.querySelector('summary')?.focus()
  }
  useEffect(() => {
    const outside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [])
  const act = (action: () => void): void => { close(); action() }
  return h('details', {
    ref, className: 'pbb-deviceMenu',
    onKeyDown: (event: { key: string; preventDefault: () => void; stopPropagation: () => void }) => {
      if (event.key !== 'Escape' || !ref.current?.open) return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    },
  },
    h('summary', {
      className: 'pbb-iconButton',
      'aria-label': props.t('devices.moreAria', { name: props.name }),
    }, settingsIcon('more', 16)),
    h('div', { className: 'pbb-deviceMenuBody', 'aria-label': props.t('devices.col.actions') },
      h('div', { className: 'pbb-deviceMenuInfo' },
        props.customName ? h('span', { className: 'pbb-diag' }, props.t('devices.customBadge')) : null,
        h('span', { className: 'pbb-diag' }, props.t('devices.col.fingerprint')),
        h('code', { className: 'pbb-token' }, props.fingerprint || '—')),
      h('button', {
        type: 'button', className: 'pbb-menuAction', disabled: !props.canRename,
        'aria-label': props.t('devices.renameAria', { name: props.name }),
        onClick: () => act(props.onRename),
      }, props.t('devices.rename')),
      h('button', {
        type: 'button', className: 'pbb-menuAction pbb-menuDanger', disabled: !props.canRevoke,
        'aria-label': props.t('devices.revokeAria', { name: props.name }),
        onClick: () => act(props.onRevoke),
      }, props.t('devices.revoke'))))
}
