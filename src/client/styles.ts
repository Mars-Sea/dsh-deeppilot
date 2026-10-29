const EASE = 'cubic-bezier(0.22,1,0.36,1)'
const CSS = [
  // Page shell + entry stagger (transform/opacity only, ≤240ms, 40ms steps).
  '.pbb-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:16px}',
  '.pbb-section>*{animation:pbb-cardIn 240ms ' + EASE + ' backwards}',
  '.pbb-section>*:nth-child(2){animation-delay:40ms}',
  '.pbb-section>*:nth-child(3){animation-delay:80ms}',
  '.pbb-section>*:nth-child(4){animation-delay:120ms}',
  '.pbb-section>*:nth-child(5){animation-delay:160ms}',
  '.pbb-section>*:nth-child(6){animation-delay:200ms}',
  '.pbb-section>*:nth-child(7){animation-delay:240ms}',
  '.pbb-section>*:nth-child(n+8){animation-delay:240ms}',
  '@keyframes pbb-cardIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}',
  '.pbb-pageHeader{display:flex;align-items:flex-start;gap:16px;padding:2px 2px 4px}',
  '.pbb-title{margin:0;font-size:18px;font-weight:600;letter-spacing:-.01em}',
  '.pbb-intro{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;margin:4px 0 0;max-width:560px}',
  '.pbb-refresh{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;padding:3px 0;margin-left:auto;white-space:nowrap;transition:transform 160ms ' + EASE + ',color 160ms ' + EASE + '}',
  '.pbb-refresh:active{transform:scale(0.97)}',
  '.pbb-refresh:disabled{cursor:default;opacity:.5}',
  // Status overview strip: four glanceable cells.
  '.pbb-statusStrip{display:grid;grid-template-columns:repeat(4,1fr);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;overflow:hidden}',
  '.pbb-statusCell{padding:14px 16px;min-width:0}',
  '.pbb-statusCell+.pbb-statusCell{border-left:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-statusLabel{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
  '.pbb-statusValue{margin-top:2px;font-size:15px;font-weight:600;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.pbb-statusValue .pbb-dot{margin-right:6px}',
  '.pbb-statusSub{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  // Cards: 16px grouping, button heads for the collapsible ones.
  '.pbb-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:16px;overflow:hidden}',
  '.pbb-cardHeader{display:flex;align-items:flex-start;gap:16px;padding:15px 18px 13px}',
  '.pbb-cardHeader>div:first-child{min-width:0;flex:1}',
  '.pbb-cardTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.pbb-cardDescription{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.45}',
  '.pbb-cardHead{display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:0 18px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background-color 160ms ' + EASE + '}',
  '.pbb-cardHead:active{background:var(--dsw-alias-bg-module-platform)}',
  '.pbb-cardSummary{flex:1;min-width:0;text-align:right;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.pbb-chev{flex:none;color:var(--dsw-alias-label-tertiary);font-size:16px;line-height:1;transition:transform 200ms ' + EASE + '}',
  '.pbb-cardHead[aria-expanded="false"] .pbb-chev,.pbb-expand[aria-expanded="false"] .pbb-chev{transform:rotate(-90deg)}',
  '.pbb-cardBody{display:flex;flex-direction:column;gap:12px;padding:4px 18px 16px}',
  '.pbb-pairingBody{display:flex;flex-direction:column;gap:10px;padding:0 18px 15px}',
  '.pbb-sectionIntro{padding-bottom:2px}',
  // Fold: grid-rows 0fr→1fr, 240ms ease-out (the Command Code precedent).
  '.pbb-fold{display:grid;grid-template-rows:1fr;transition:grid-template-rows 240ms ' + EASE + ',opacity 200ms ' + EASE + ';opacity:1}',
  '.pbb-foldClosed{grid-template-rows:0fr;opacity:0}',
  '.pbb-fold>div{overflow:hidden;min-height:0}',
  // Shared rows, labels, badges.
  '.pbb-row{display:flex;align-items:center;gap:8px}',
  '.pbb-label{flex:1;font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary);min-width:0}',
  '.pbb-value{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all;text-align:right}',
  '.pbb-badge,.pbb-countBadge{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 8px;font-size:11px;font-weight:500;white-space:nowrap}',
  '.pbb-badgeOk{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22a06b) 12%,transparent);color:var(--dsw-alias-state-success-primary,#22a06b)}',
  '.pbb-badgeWarn{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#e2b203) 14%,transparent);color:var(--dsw-alias-state-warning-primary,#e2b203)}',
  '.pbb-countBadge{min-width:24px;text-align:center}',
  '.pbb-statusBadge{display:inline-flex;align-items:center;gap:6px;flex:none;padding:3px 8px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;white-space:nowrap}',
  '.pbb-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary));font-weight:500}',
  '.pbb-bad{color:var(--dsw-alias-label-error);font-weight:500}',
  '.pbb-diag{font-size:11px;color:var(--dsw-alias-label-tertiary);margin:0;line-height:1.5;overflow-wrap:anywhere}',
  '.pbb-diagBad{color:var(--dsw-alias-label-error)}',
  '.pbb-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;margin:0;padding:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}',
  '.pbb-token{max-width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
  // Buttons: press feedback on every pressable, with named properties only.
  '.pbb-action{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:5px 9px;line-height:1.2;white-space:nowrap;transition:transform 160ms ' + EASE + ',color 160ms ' + EASE + ',background-color 160ms ' + EASE + ',border-color 160ms ' + EASE + '}',
  '.pbb-action:active{transform:scale(0.97)}',
  '.pbb-action:disabled{cursor:default;opacity:.5}',
  '.pbb-buttonPrimary{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-success-primary,#3b82f6);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3b82f6) 12%,transparent)}',
  '.pbb-actionDangerGhost{color:#dc2626;border-color:rgba(220,38,38,.38);background:transparent;line-height:1.35;padding:4px 9px}',
  '.pbb-actionDangerGhost:active{transform:scale(0.97)}',
  '.pbb-actionDangerGhost:disabled{cursor:default;opacity:.62}',
  '.pbb-actionIcon{flex:none;display:inline-block;vertical-align:-2px;margin-right:5px;pointer-events:none}',
  '.pbb-actionBusy{display:inline-flex;align-items:center;gap:6px}',
  '.pbb-actionBusy::before{content:"";width:9px;height:9px;border-radius:50%;border:1.5px solid rgba(220,38,38,.35);border-top-color:currentColor;animation:pbb-spin .7s linear infinite}',
  '@keyframes pbb-spin{to{transform:rotate(360deg)}}',
  // Switches: 40x24, knob 18px, 16px travel.
  '.pbb-masterRow{display:flex;align-items:center;gap:14px}',
  '.pbb-switchText{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}',
  '.pbb-switchTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.pbb-switchDesc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4}',
  '.pbb-switch{appearance:none;-webkit-appearance:none;width:40px;height:24px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);position:relative;cursor:pointer;padding:0;flex:none;transition:background-color 160ms ' + EASE + ',border-color 160ms ' + EASE + ',transform 160ms ' + EASE + '}',
  '.pbb-switch::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform 160ms ' + EASE + ',background-color 160ms ' + EASE + '}',
  '.pbb-switchOn{background:var(--dsw-alias-state-success-primary,#22a06b);border-color:transparent}',
  '.pbb-switchOn::after{transform:translateX(16px);background:#fff}',
  '.pbb-switch:active{transform:scale(0.97)}',
  '.pbb-switch:disabled{opacity:.5;cursor:default}',
  '.pbb-switch:focus-visible,.pbb-action:focus-visible,.pbb-targetButton:focus-visible,.pbb-cardHead:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#3b82f6) 55%,transparent);outline-offset:2px}',
  // Dots (class names come from settings-view-models).
  '.pbb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}',
  '.pbb-dotOk{background:var(--dsw-alias-state-success-primary,#22a06b)}',
  '.pbb-dotWarn{background:var(--dsw-alias-state-warning-primary,#e2b203)}',
  '.pbb-dotBad{background:var(--dsw-alias-label-error)}',
  '.pbb-switchTitle .pbb-dot{margin-right:6px;vertical-align:1px}',
  // Channels: full-width rows, options fold inside each channel.
  '.pbb-channel{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:10px}',
  '.pbb-expand{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:0;display:flex;align-items:center;gap:6px;align-self:flex-start;transition:color 160ms ' + EASE + ',transform 160ms ' + EASE + '}',
  '.pbb-expand:active{transform:scale(0.97)}',
  '.pbb-channelBody{display:flex;flex-direction:column;gap:12px;padding-top:2px}',
  '.pbb-limitRow{display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-limitRow:first-child{border-top:0;padding-top:2px}',
  '.pbb-limitControl{display:flex;align-items:center;gap:8px;flex:none}',
  '.pbb-numberInput{width:72px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:5px 8px}',
  '.pbb-numberInput:focus{outline:2px solid var(--dsw-alias-state-success-primary,#22a06b);outline-offset:1px}',
  '.pbb-numberInput:disabled{opacity:.5}',
  // Pairing hero: segmented targets, QR + info grid, expiry countdown.
  '.pbb-targetList{display:inline-flex;flex-wrap:wrap;gap:2px;background:var(--dsw-alias-bg-module-platform);border-radius:999px;padding:2px;align-self:flex-start}',
  '.pbb-targetButton{font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:0;border-radius:999px;padding:6px 9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:transform 160ms ' + EASE + ',color 160ms ' + EASE + ',background-color 160ms ' + EASE + ',box-shadow 160ms ' + EASE + '}',
  '.pbb-targetButton:active{transform:scale(0.97)}',
  '.pbb-targetButton:disabled{cursor:default;opacity:.5}',
  '.pbb-targetSelected{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);box-shadow:0 1px 3px rgba(0,0,0,.12);font-weight:500}',
  '.pbb-qrPanel{display:grid;grid-template-columns:224px 1fr;gap:20px;align-items:start;padding:14px 0 4px;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-qrImage{width:224px;height:224px;max-width:100%;background:#fff;border-radius:12px;padding:8px;box-sizing:border-box}',
  '.pbb-countdown{margin-top:10px;display:flex;flex-direction:column;gap:6px}',
  '.pbb-countdownBar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);overflow:hidden}',
  '.pbb-countdownBar i{display:block;height:100%;background:var(--dsw-alias-state-success-primary,#22a06b);border-radius:999px;transition:width 1s linear}',
  '.pbb-countdownText{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
  '.pbb-pairInfo{display:flex;flex-direction:column;gap:10px;min-width:0}',
  '.pbb-pairCodeBlock{width:100%;display:flex;flex-direction:column;gap:6px}',
  '.pbb-pairCodeLabel{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
  '.pbb-pairCodeRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.pbb-pairCode{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.4;letter-spacing:.03em;color:var(--dsw-alias-label-primary);word-break:break-all;user-select:all}',
  '.pbb-qrHint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);margin:0}',
  '.pbb-rowAction{display:flex;gap:8px;margin-top:4px}',
  // Devices: one card per device.
  '.pbb-deviceCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;transition:opacity 200ms ' + EASE + ',transform 200ms ' + EASE + '}',
  '.pbb-deviceNameRow{display:flex;align-items:center;gap:6px;min-width:0}',
  '.pbb-deviceName{display:block;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pbb-deviceMeta{display:flex;flex-wrap:wrap;gap:6px 14px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;min-width:0}',
  '.pbb-deviceMeta code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pbb-deviceActions{display:flex;gap:8px;flex-wrap:wrap}',
  '.pbb-deviceConfirm{display:flex;flex-direction:column;gap:8px}',
  '.pbb-deviceRenameForm{display:flex;gap:8px;flex-wrap:wrap;min-width:0}',
  '.pbb-deviceNameInput{flex:1;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 8px}',
  '.pbb-deviceNameInput:focus{outline:2px solid var(--dsw-alias-state-success-primary,#22a06b);outline-offset:1px}',
  '.pbb-deviceNameInput:disabled{opacity:.5}',
  '.pbb-deviceRenameActions{display:flex;align-items:center;gap:5px;flex:none}',
  // Help, tests, runtime list, disclosures.
  '.pbb-helpBody{display:flex;flex-direction:column;gap:14px}',
  '.pbb-helpSection{display:flex;flex-direction:column;gap:6px}',
  '.pbb-helpHeading{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
  '.pbb-helpList{margin:0;padding-left:20px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}',
  '.pbb-helpList li+li{margin-top:4px}',
  '.pbb-helpText{margin:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.6}',
  '.pbb-helpCode{display:block;margin:2px 0 0;padding:10px;overflow:auto;white-space:pre-wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}',
  '.pbb-helpLink{color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px}',
  '.pbb-testGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
  '.pbb-testItem{display:flex;align-items:center;gap:12px;padding:11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-module-platform)}',
  '.pbb-testTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}',
  '.pbb-testDescription{font-size:10px;color:var(--dsw-alias-label-tertiary);line-height:1.45}',
  '.pbb-runtimeList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}',
  '.pbb-runtimeList>.pbb-runtimeRow,.pbb-runtimeRow{display:flex;align-items:center;gap:10px;padding:9px 10px;border-top:1px solid var(--dsw-alias-border-l2)}',
  '.pbb-runtimeList>.pbb-runtimeRow:first-child{border-top:0}',
  '.pbb-runtimeList>.pbb-runtimeRow>.pbb-row{flex:1;min-width:0}',
  '.pbb-updateRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#22a06b) 35%,var(--dsw-alias-border-l2));border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px}',
  '.pbb-disclosure{padding:0}',
  '.pbb-disclosure>summary{list-style:none;display:flex;align-items:center;gap:12px;padding:13px 18px;cursor:pointer;color:var(--dsw-alias-label-primary)}',
  '.pbb-disclosure>summary::-webkit-details-marker{display:none}',
  '.pbb-disclosure>summary::after{content:"›";color:var(--dsw-alias-label-tertiary);font-size:17px;line-height:1;transform:rotate(90deg);transition:transform 200ms ' + EASE + '}',
  '.pbb-disclosure[open]>summary::after{transform:rotate(-90deg)}',
  '.pbb-disclosureTitle{font-size:12px;font-weight:500;flex:1}',
  '.pbb-disclosureMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.pbb-disclosureBody{display:flex;flex-direction:column;gap:12px;padding:2px 18px 16px}',
  '.pbb-diagnostics>summary{color:var(--dsw-alias-label-secondary)}',
  // Hover only on precise pointers; reduced motion keeps state changes, drops movement.
  '@media (hover:hover) and (pointer:fine){.pbb-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}.pbb-cardHead:hover{background:var(--dsw-alias-bg-module-platform)}.pbb-action:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform)}.pbb-buttonPrimary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3b82f6) 18%,transparent)}.pbb-actionDangerGhost:hover:not(:disabled){color:#b91c1c;background:rgba(220,38,38,.09);border-color:rgba(185,28,28,.5)}.pbb-expand:hover{color:var(--dsw-alias-label-primary)}}',
  '@media (prefers-reduced-motion:reduce){.pbb-section *{animation-duration:.01ms!important;animation-delay:0s!important;transition-duration:.01ms!important;transition-delay:0s!important}}',
  '@media (max-width:620px){.pbb-statusStrip{grid-template-columns:repeat(2,1fr)}.pbb-statusCell:nth-child(3){border-left:0}.pbb-statusCell:nth-child(n+3){border-top:1px solid var(--dsw-alias-border-l2)}.pbb-testGrid{grid-template-columns:1fr}.pbb-qrPanel{grid-template-columns:1fr}.pbb-limitRow{align-items:flex-start;flex-direction:column}.pbb-limitControl{align-self:flex-end}}',
].join('\n')

/**
 * Client bundle id, identical to the `window.__ModuleLoader__.load({ id })`
 * identity emitted by tsdown.config.ts. DSH's module system owns style
 * teardown by package id, so this tag must carry the same value.
 */
const PLUGIN_ID = 'dsh-deeppilot'

/**
 * Claim this plugin's page stylesheet against DSH's style ownership.
 *
 * `ClientModuleSystem` tags untagged `<style>` elements only during factory
 * materialization; this sheet is injected from `apply()`, which runs after
 * that point, so it would never be attributed to us. Stamping `data-plugin`
 * ourselves lets the module system's `removeOwnedStyles(id)` delete the sheet
 * when the plugin is unloaded at runtime — the rc.2 Plugin Manager and client
 * entry reconciler both support live removal, and an
 * orphaned sheet would otherwise keep styling a page we no longer own.
 */
export function injectCss(): void {
  if (typeof document === 'undefined') return
  const id = 'dsh-deeppilot/page.css'
  if (document.querySelector('style[data-plugin-css="' + id + '"]') !== null) return
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin', PLUGIN_ID)
  tag.setAttribute('data-plugin-css', id)
  tag.textContent = CSS
  document.head.appendChild(tag)
}
