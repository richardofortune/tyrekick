/**
 * All widget CSS, injected once into the shadow root. `:host { all: initial }`
 * isolates us from host-page styles; the accent colour is parameterised.
 * Focus rings are always visible and text/background pairs clear 4.5:1.
 */
export function styles(accent: string): string {
  return `
:host{all:initial;--fl-accent:${accent};--fl-z:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.4}
:host *{box-sizing:border-box}
button{cursor:pointer;font:inherit;color:inherit}
button:focus-visible,textarea:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #111;outline-offset:2px}
.trigger{position:fixed;width:48px;height:48px;border-radius:50%;border:none;background:var(--fl-accent);color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.35);z-index:var(--fl-z)}
.trigger svg{width:24px;height:24px;display:block}
.pos-bottom-right{right:20px;bottom:20px}
.pos-bottom-left{left:20px;bottom:20px}
.capture{position:fixed;inset:0;cursor:crosshair;background:transparent;z-index:calc(var(--fl-z) + 1)}
.hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 24px);display:flex;gap:10px;align-items:center;background:#111;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 2px 12px rgba(0,0,0,.35);z-index:calc(var(--fl-z) + 3)}
.hint button{background:transparent;border:1px solid #888;color:#fff;border-radius:6px;padding:2px 10px;font-size:12px}
.pin{position:fixed;width:26px;height:26px;margin:-26px 0 0 -13px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:var(--fl-accent);color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;box-shadow:0 1px 5px rgba(0,0,0,.45);opacity:.65;pointer-events:none;z-index:calc(var(--fl-z) + 2)}
.pin span{transform:rotate(45deg)}
.pin.sent{opacity:1}
.pin.failed{background:#dc2626;opacity:1}
.panel{position:fixed;width:300px;max-width:calc(100vw - 24px);background:#fff;color:#111;border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.28);padding:14px;font-size:14px;z-index:calc(var(--fl-z) + 4)}
.panel textarea{width:100%;min-height:86px;resize:vertical;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:14px;color:#111;background:#fff}
.panel input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:14px;color:#111;background:#fff;margin-top:8px}
.panel textarea::placeholder,.panel input::placeholder{color:#64748b}
.counter{margin-top:4px;font-size:12px;color:#475569;text-align:right}
.row{display:flex;gap:8px;margin-top:10px}
.row button{flex:1;border-radius:8px;padding:9px;border:1px solid transparent;font-weight:600}
.btn-submit{background:var(--fl-accent);color:#fff}
.btn-submit:disabled{opacity:.5;cursor:not-allowed}
.btn-cancel{background:#f1f5f9;color:#111;border-color:#cbd5e1}
.status{margin-top:10px;min-height:18px;font-size:13px}
.status.err{color:#b91c1c}
.status.ok{color:#15803d;font-weight:600}
.foot{margin-top:10px;font-size:11px;color:#475569;text-align:center}
.foot a{color:#475569}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.5);border-top-color:#fff;border-radius:50%;animation:fl-spin .7s linear infinite;vertical-align:middle}
@keyframes fl-spin{to{transform:rotate(360deg)}}
.list-toggle{position:fixed;width:38px;height:38px;border-radius:50%;border:1px solid #cbd5e1;background:#fff;color:#111;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.25);z-index:calc(var(--fl-z) + 3)}
.list-toggle svg{width:20px;height:20px;display:block}
.list-toggle .count{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;line-height:17px;padding:0 4px;border-radius:9px;background:var(--fl-accent);color:#fff;font-size:10px;font-weight:700;text-align:center}
.list-toggle.pos-bottom-right{right:25px;bottom:80px}
.list-toggle.pos-bottom-left{left:25px;bottom:80px}
.drawer{position:fixed;top:0;right:0;bottom:0;width:320px;max-width:85vw;background:#fff;color:#111;box-shadow:-6px 0 26px rgba(0,0,0,.22);display:flex;flex-direction:column;font-size:14px;z-index:calc(var(--fl-z) + 3)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #e2e8f0;font-weight:700}
.drawer-head button{background:#f1f5f9;color:#111;border:1px solid #cbd5e1;border-radius:6px;padding:3px 10px;font-size:12px}
.drawer-list{flex:1;overflow-y:auto;padding:10px}
.drawer-empty{padding:18px 10px;color:#475569;font-size:13px;text-align:center}
.entry{display:flex;gap:10px;width:100%;text-align:left;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px;margin-bottom:8px;font:inherit;font-size:13px;color:#111}
.entry:hover{background:#f8fafc}
.entry .n{flex:none;width:22px;height:22px;border-radius:50%;background:var(--fl-accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center}
.entry.failed .n{background:#dc2626}
.entry-main{min-width:0}
.entry .body{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.entry .meta{display:block;margin-top:4px;font-size:11px;color:#475569}
.entry.failed .meta{color:#b91c1c}
.pin.pulse{animation:fl-pulse 1s ease-out 2}
@keyframes fl-pulse{0%{box-shadow:0 0 0 0 rgba(17,17,17,.5)}70%{box-shadow:0 0 0 14px rgba(17,17,17,0)}100%{box-shadow:0 0 0 0 rgba(17,17,17,0)}}
.hidden{display:none!important}
`;
}
