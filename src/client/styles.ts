const CSS = String.raw`
.pbb-section{--pbb-ink:var(--dsw-alias-label-primary,#0f1115);--pbb-secondary:var(--dsw-alias-label-secondary,#61666b);--pbb-line:var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l3,#e4e5e7));--pbb-fill:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-2,#fff));--pbb-soft:var(--dsw-alias-bg-module-platform,#f5f6f8);container:pbb/inline-size;max-width:760px;color:var(--pbb-ink);font-size:14px;line-height:20px;display:flex;flex-direction:column;gap:20px}
.pbb-section *{box-sizing:border-box}
.pbb-section button,.pbb-section input{font-family:inherit}
.pbb-icon{display:block;flex:none;color:inherit}
.pbb-pageHeader{display:flex;align-items:flex-start;gap:12px;min-height:56px}
.pbb-pageHeader>div{min-width:0;flex:1;padding-top:2px}
.pbb-title{margin:0;font-size:20px;line-height:27px;font-weight:600;letter-spacing:-.3px}
.pbb-intro{color:var(--pbb-secondary);font-size:14px;line-height:20px;margin:5px 0 0}
.pbb-refresh{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 7px;flex:none;border:0;border-radius:6px;background:transparent;color:var(--pbb-secondary);font-size:12px;cursor:pointer}
.pbb-card{border:1px solid var(--pbb-line);border-radius:18px;background:var(--pbb-fill)}
.pbb-cardTitle{margin:0;font-size:14px;line-height:20px;font-weight:600;color:var(--pbb-ink)}
.pbb-cardBody{display:flex;flex-direction:column;gap:12px;padding:4px 16px 16px}
.pbb-connections>.pbb-cardBody{padding:0;gap:0}
.pbb-row{display:flex;align-items:center;gap:8px;min-width:0}
.pbb-masterRow{display:flex;align-items:center;gap:12px;min-height:66px;padding:11px 16px}
.pbb-switchText{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}
.pbb-masterRow>.pbb-switchText{gap:4px}
.pbb-switchTitle{font-size:14px;line-height:20px;font-weight:400;color:var(--pbb-ink)}
.pbb-masterRow .pbb-switchTitle{font-weight:600}
.pbb-switchDesc,.pbb-diag,.pbb-label,.pbb-value{font-size:12px;line-height:18px;color:var(--pbb-secondary)}
.pbb-serviceSummary,.pbb-channelState{display:flex;align-items:center;flex-wrap:wrap;gap:6px;font-size:12px;line-height:18px;color:var(--pbb-secondary)}
.pbb-serviceSummary{gap:5px}
.pbb-serviceState{display:inline-flex}
.pbb-metaDivider{height:10px;border-left:1px solid var(--pbb-line);margin:0 2px}
.pbb-channel{position:relative}
.pbb-channel::before{content:"";position:absolute;top:0;left:16px;right:16px;border-top:1px solid var(--pbb-line)}
.pbb-channel+.pbb-channel::before{left:46px}
.pbb-channelRow{gap:12px;min-height:60px;padding:8px 16px}
.pbb-channelRow>.pbb-icon{color:var(--pbb-secondary)}
.pbb-channelBody{display:flex;flex-direction:column;gap:12px;padding:2px 16px 14px 46px}
.pbb-channel>.pbb-diag,.pbb-channel>.pbb-rowAction{margin:0;padding:0 16px 8px 46px}
.pbb-fold[hidden]{display:none}
.pbb-switch{appearance:none;-webkit-appearance:none;position:relative;flex:none;width:36px;height:28px;padding:0;border:0;background:transparent;cursor:pointer}
.pbb-switch::before{content:"";position:absolute;left:1px;top:4px;width:34px;height:20px;border-radius:10px;background:color-mix(in srgb,var(--pbb-ink) 18%,transparent)}
.pbb-switch::after{content:"";position:absolute;left:4px;top:7px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.pbb-switchOn::before{background:var(--dsw-alias-brand-primary,var(--pbb-ink))}
.pbb-switchOn::after{transform:translateX(14px);background:var(--dsw-alias-label-primary-foreground,#fff)}
.pbb-switch:disabled,.pbb-action:disabled,.pbb-refresh:disabled,.pbb-menuAction:disabled,.pbb-targetButton:disabled{opacity:.5;cursor:default}
.pbb-action{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:none;height:28px;max-width:100%;padding:0 9px;border:1px solid var(--pbb-line);border-radius:6px;background:transparent;color:var(--pbb-secondary);font:inherit;font-size:14px;line-height:20px;text-decoration:none;cursor:pointer;white-space:nowrap}
.pbb-addButton{height:30px;margin-left:auto;padding:0 10px;border-radius:7px;color:var(--pbb-ink);font-weight:400;background:var(--pbb-fill)}
.pbb-buttonPrimary{background:var(--dsw-alias-button-primary-fill,var(--pbb-ink));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.pbb-actionDangerGhost{color:var(--dsw-alias-state-error-primary,#bc2222);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#bc2222) 35%,transparent)}
.pbb-iconButton{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--pbb-secondary);cursor:pointer}
.pbb-chev{display:inline-flex;flex:none;color:var(--pbb-secondary)}
.pbb-chevIcon{width:14px;height:14px;display:block}
[aria-expanded="true"]>.pbb-chev,.pbb-helpDisclosure[open]>summary>.pbb-chev,.pbb-disclosure[open]>summary>.pbb-chev{transform:rotate(90deg)}
.pbb-diag{margin:0;overflow-wrap:anywhere}
.pbb-diagBad,.pbb-bad{color:var(--dsw-alias-state-error-primary,#bc2222)}
.pbb-ok{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#287a45) 65%,var(--pbb-ink))}
.pbb-label{flex:1;min-width:0;font-weight:500;color:var(--pbb-ink)}
.pbb-value{text-align:right;overflow-wrap:anywhere}
.pbb-token{max-width:100%;font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--pbb-secondary);overflow-wrap:anywhere}
.pbb-empty{margin:0;padding:16px;font-size:14px;line-height:20px;color:var(--pbb-secondary)}
.pbb-limitRow{display:flex;align-items:center;gap:12px}
.pbb-limitControl{display:flex;align-items:center;gap:8px;flex:none}
.pbb-numberInput,.pbb-deviceNameInput{min-width:0;height:28px;border:1px solid var(--pbb-line);border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--pbb-fill));color:var(--pbb-ink);font:inherit;font-size:14px;line-height:20px;padding:3px 8px;caret-color:var(--pbb-ink)}
.pbb-numberInput{width:72px}
.pbb-numberInput:disabled,.pbb-deviceNameInput:disabled{opacity:.5}
.pbb-endpoint{user-select:all}
.pbb-devicesSection{display:flex;flex-direction:column;gap:8px}
.pbb-devicesHeader{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 2px}
.pbb-deviceCount{font-size:12px;line-height:18px;color:var(--pbb-secondary);white-space:nowrap}
.pbb-devicesCard{overflow:visible}
.pbb-deviceList{display:flex;flex-direction:column}
.pbb-deviceRow{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:12px;row-gap:0;min-height:56px;padding:6px 14px 6px 16px}
.pbb-deviceRow+.pbb-deviceRow::before{content:"";position:absolute;top:0;left:46px;right:16px;border-top:1px solid var(--pbb-line)}
.pbb-deviceRow:has(details[open]){z-index:2}
.pbb-deviceMain{display:flex;align-items:center;gap:12px;min-width:0}
.pbb-deviceMain>.pbb-icon{color:var(--pbb-secondary)}
.pbb-deviceText{display:flex;flex-direction:column;gap:2px;min-width:0}
.pbb-deviceName{font-size:14px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pbb-deviceMeta{display:flex;flex-wrap:wrap;gap:0 6px;color:var(--pbb-secondary);font-size:12px;line-height:18px}
.pbb-deviceMeta>*+*::before{content:"\00B7";margin-right:6px}
.pbb-deviceActions{grid-row:1;grid-column:2;display:flex;align-items:center}
.pbb-deviceRenameForm,.pbb-deviceConfirm{grid-column:1/-1;display:flex;gap:8px;padding:8px 0;min-width:0}
.pbb-deviceRenameForm{flex-wrap:wrap}
.pbb-deviceNameInput{flex:1}
.pbb-deviceRenameActions{display:flex;align-items:center;gap:5px;flex:none}
.pbb-deviceConfirm{flex-direction:column}
.pbb-deviceMessage{padding:10px 16px}
.pbb-deviceMenu{position:relative}
.pbb-deviceMenu>summary{list-style:none}
.pbb-deviceMenu>summary::-webkit-details-marker{display:none}
.pbb-deviceMenuBody{position:absolute;z-index:3;top:34px;right:0;width:250px;max-width:calc(100cqw - 32px);padding:5px;border:1px solid var(--pbb-line);border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--pbb-fill));box-shadow:0 8px 24px color-mix(in srgb,var(--pbb-ink) 12%,transparent)}
.pbb-deviceMenuInfo{display:flex;flex-direction:column;gap:3px;padding:7px 8px 10px;border-bottom:1px solid var(--pbb-line)}
.pbb-menuAction{display:block;width:100%;min-height:32px;padding:5px 8px;border:0;border-radius:5px;background:transparent;color:var(--pbb-ink);text-align:left;font:inherit;font-size:14px;cursor:pointer}
.pbb-menuDanger{color:var(--dsw-alias-state-error-primary,#bc2222)}
.pbb-actionBusy{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--pbb-secondary)}
.pbb-actionBusy::before{content:"";width:10px;height:10px;border:1.5px solid var(--pbb-line);border-top-color:currentColor;border-radius:50%;animation:pbb-spin .7s linear infinite}
@keyframes pbb-spin{to{transform:rotate(360deg)}}
.pbb-rowAction{display:flex;flex-wrap:wrap;gap:8px}
.pbb-pairingPanel{border:1px solid var(--pbb-line);border-radius:16px;padding:16px;background:var(--pbb-fill)}
.pbb-pairingHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px}
.pbb-pairingBody{display:flex;flex-direction:column;gap:10px}
.pbb-targetList{display:flex;flex-wrap:wrap;gap:4px;min-width:0}
.pbb-targetButton{max-width:100%;padding:5px 9px;border:1px solid transparent;border-radius:7px;background:var(--pbb-soft);color:var(--pbb-secondary);font:inherit;font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.pbb-targetSelected{color:var(--pbb-ink);border-color:var(--pbb-line);background:var(--pbb-fill)}
.pbb-qrPanel{display:grid;grid-template-columns:224px minmax(0,1fr);gap:20px;align-items:start}
.pbb-qrImage{display:block;width:224px;height:224px;max-width:100%;padding:8px;border-radius:12px;background:#fff}
.pbb-countdown{margin-top:10px;display:flex;flex-direction:column;gap:6px}
.pbb-countdownBar{height:4px;border-radius:99px;background:var(--pbb-soft);overflow:hidden}
.pbb-countdownBar i{display:block;width:100%;height:100%;transform-origin:left center;background:var(--dsw-alias-state-business-primary,#4176e6);border-radius:99px}
.pbb-countdownText{font-size:12px;line-height:18px;color:var(--pbb-secondary);font-variant-numeric:tabular-nums}
.pbb-pairInfo,.pbb-pairCodeBlock{display:flex;flex-direction:column;gap:8px;min-width:0}
.pbb-pairCodeLabel,.pbb-qrHint{font-size:12px;line-height:18px;color:var(--pbb-secondary);margin:0}
.pbb-pairCodeRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pbb-pairCode{font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;user-select:all}
.pbb-tools{border-radius:16px;overflow:hidden}
.pbb-toolSection+.pbb-toolSection{border-top:1px solid var(--pbb-line)}
.pbb-cardHead{display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:0 16px;border:0;background:transparent;color:var(--pbb-secondary);font:inherit;text-align:left;cursor:pointer}
.pbb-cardHead>.pbb-cardTitle{flex:1;font-weight:400}
.pbb-toolMeta{max-width:50%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--pbb-secondary)}
.pbb-toolMeta.pbb-ok{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#287a45) 65%,var(--pbb-ink))}
.pbb-toolMeta.pbb-bad{color:var(--dsw-alias-state-error-primary,#bc2222)}
.pbb-testGrid{display:flex;flex-direction:column;gap:0}
.pbb-testItem{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--pbb-line)}
.pbb-testTitle{font-size:14px;line-height:20px;font-weight:500;color:var(--pbb-ink)}
.pbb-testDescription{font-size:12px;line-height:18px;color:var(--pbb-secondary)}
.pbb-helpBody,.pbb-disclosureBody{display:flex;flex-direction:column;gap:14px}
.pbb-helpSection{display:flex;flex-direction:column;gap:6px}
.pbb-helpHeading{font-size:14px;line-height:20px;font-weight:500;color:var(--pbb-ink)}
.pbb-helpList{margin:0;padding-left:20px;font-size:14px;line-height:22px;color:var(--pbb-secondary)}
.pbb-helpList li+li{margin-top:4px}
.pbb-helpText{margin:0;font-size:14px;line-height:22px;color:var(--pbb-secondary)}
.pbb-helpCode{display:block;margin:0;padding:10px;border:1px solid var(--pbb-line);border-radius:8px;background:var(--pbb-soft);color:var(--pbb-ink);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.pbb-helpLink{color:var(--pbb-ink);text-decoration:underline;text-underline-offset:3px}
.pbb-helpDisclosure>summary{display:flex;align-items:center;gap:6px;min-height:28px;list-style:none;cursor:pointer;color:var(--pbb-secondary);font-size:12px}
.pbb-helpDisclosure>summary::-webkit-details-marker{display:none}
.pbb-helpDisclosure[open]>.pbb-helpBody{padding-top:10px}
.pbb-runtimeList{display:flex;flex-direction:column}
.pbb-runtimeRow{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--pbb-line)}
.pbb-runtimeRow>.pbb-row{flex:1;min-width:0}
.pbb-updateRow{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;color:var(--pbb-ink);font-size:14px;text-decoration:none}
.pbb-resultRow{display:flex;align-items:flex-start;gap:6px}
.pbb-resultIcon{display:inline-flex;flex:none;margin-top:3px;color:var(--dsw-alias-state-success-primary,#287a45)}
.pbb-resultIconBad{color:var(--dsw-alias-state-error-primary,#bc2222)}
.pbb-disclosure>summary{list-style:none;display:flex;align-items:center;gap:10px;min-height:44px;padding:0 16px;cursor:pointer;font-size:14px}
.pbb-disclosure>summary::-webkit-details-marker{display:none}
.pbb-disclosureBody{padding:2px 16px 16px}
.pbb-disclosureTitle{flex:1}
.pbb-section :is(button,input,summary,a):focus-visible{outline:2px solid var(--dsw-focus-ring-color,#5276b4);outline-offset:2px}
@media (hover:hover) and (pointer:fine){.pbb-refresh:hover:not(:disabled),.pbb-iconButton:hover,.pbb-action:hover:not(:disabled),.pbb-cardHead:hover,.pbb-menuAction:hover:not(:disabled){background:var(--pbb-soft)}.pbb-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#30343b)}.pbb-action:active:not(:disabled),.pbb-refresh:active:not(:disabled),.pbb-iconButton:active{transform:scale(.97)}}
@media (prefers-reduced-motion:reduce){.pbb-section *{animation:none!important;transition:none!important}.pbb-section :active{transform:none!important}}
@container pbb (max-width:480px){.pbb-qrPanel{grid-template-columns:1fr}.pbb-limitRow{align-items:flex-start;flex-direction:column}.pbb-limitControl{align-self:flex-end}.pbb-deviceMeta{column-gap:4px}.pbb-toolMeta{max-width:42%}.pbb-channelRow{gap:8px}.pbb-testItem{flex-wrap:wrap}.pbb-testItem>.pbb-switchText{flex-basis:65%}}
@container pbb (max-width:340px){.pbb-devicesHeader{flex-wrap:wrap}.pbb-deviceRow{column-gap:6px;padding-right:10px}.pbb-channelBody{padding-left:16px}.pbb-toolMeta{max-width:38%}}
@media (pointer:coarse){.pbb-action,.pbb-iconButton,.pbb-refresh,.pbb-switch,.pbb-targetButton,.pbb-menuAction,.pbb-helpDisclosure>summary{min-width:44px;min-height:44px}.pbb-switch::before{left:5px;top:12px}.pbb-switch::after{left:8px;top:15px}.pbb-numberInput,.pbb-deviceNameInput{height:44px;font-size:16px}.pbb-deviceMenuBody{top:48px}}
`

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
