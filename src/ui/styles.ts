/**
 * All widget CSS, injected once into the shadow root. `:host { all: initial }`
 * isolates us from host-page styles.
 *
 * Design language: "the inspection mark" — a semantic token system on :host
 * (ink/paper/surface2/line/accent), light + dark values switched by a
 * tk-light / tk-dark class on the host element, two type voices (mono for
 * machine facts, sans for human words), and reticle-style pins. The accent is
 * parameterised; text ON the accent always uses the auto-contrast ink.
 */

/**
 * Auto-contrast: pick the text colour to use ON the accent from its relative
 * luminance (simple sRGB weighting). Light accents get dark ink, dark accents
 * get white. Non-hex colours fall back to white (previous behaviour).
 */
export function accentInk(accent: string): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(accent.trim());
  if (!m) return "#FFFFFF";
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#16181D" : "#FFFFFF";
}

export function styles(accent: string): string {
  return `
:host{all:initial;--tk-accent:${accent};--tk-accent-ink:${accentInk(accent)};--tk-ok:#2F9E6E;--tk-flag:#DE4B43;--tk-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--tk-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--tk-z:2147483000;--tk-ink:#16181D;--tk-paper:#FFFFFF;--tk-surface2:#F6F6F4;--tk-line:#E4E4DF;font-family:var(--tk-sans);font-size:13px;font-weight:450;line-height:1.4}
:host(.tk-dark){--tk-ink:#F2F3F5;--tk-paper:#1C1E24;--tk-surface2:#26292F;--tk-line:#33363D}
:host *{box-sizing:border-box}
button{cursor:pointer;font:inherit;color:inherit}
button:focus-visible,textarea:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--tk-accent);outline-offset:2px}
.trigger{position:fixed;width:48px;height:48px;border-radius:50%;border:none;background:var(--tk-accent);color:var(--tk-accent-ink);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.35);z-index:var(--tk-z)}
.trigger svg{width:24px;height:24px;display:block}
.pos-bottom-right{right:20px;bottom:20px}
.pos-bottom-left{left:20px;bottom:20px}
.capture{position:fixed;inset:0;cursor:crosshair;background:transparent;z-index:calc(var(--tk-z) + 1)}
.hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 24px);display:flex;gap:10px;align-items:center;background:var(--tk-ink);color:var(--tk-paper);padding:8px 14px;border-radius:8px;font-size:13px;box-shadow:0 2px 12px rgba(0,0,0,.35);z-index:calc(var(--tk-z) + 3)}
.hint button{background:transparent;border:1px solid var(--tk-line);color:var(--tk-paper);border-radius:6px;padding:2px 10px;font-size:12px}
.pin{position:fixed;width:36px;height:36px;margin:-18px 0 0 -18px;padding:0;border:0;background:transparent;opacity:.65;cursor:pointer;z-index:calc(var(--tk-z) + 2)}
.pin:not(.sent):not(.failed){pointer-events:none}
.pin::before{content:"";position:absolute;inset:6px;background:linear-gradient(var(--tk-ink),var(--tk-ink)) 0 0/8px 2px,linear-gradient(var(--tk-ink),var(--tk-ink)) 0 0/2px 8px,linear-gradient(var(--tk-ink),var(--tk-ink)) 100% 0/8px 2px,linear-gradient(var(--tk-ink),var(--tk-ink)) 100% 0/2px 8px,linear-gradient(var(--tk-ink),var(--tk-ink)) 0 100%/8px 2px,linear-gradient(var(--tk-ink),var(--tk-ink)) 0 100%/2px 8px,linear-gradient(var(--tk-ink),var(--tk-ink)) 100% 100%/8px 2px,linear-gradient(var(--tk-ink),var(--tk-ink)) 100% 100%/2px 8px;background-repeat:no-repeat}
.pin span{position:absolute;right:-1px;bottom:-1px;min-width:15px;height:15px;padding:0 3px;border-radius:4px;background:var(--tk-accent);color:var(--tk-accent-ink);font:600 10px/15px var(--tk-mono);letter-spacing:-.01em;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35)}
.pin.sent{opacity:1}
.pin.failed{opacity:1}
.pin.failed span{background:var(--tk-flag);color:#fff}
:host(:not(.tk-engaged)) .pin{opacity:.45}
.pin:hover,.pin:focus-visible,:host(:not(.tk-engaged)) .pin:hover,:host(:not(.tk-engaged)) .pin:focus-visible{opacity:1}
.pin.ring,:host(:not(.tk-engaged)) .pin.ring{opacity:1;border-radius:10px;box-shadow:0 0 0 2px var(--tk-accent)}
.tip{position:fixed;max-width:260px;background:var(--tk-ink);color:var(--tk-paper);padding:6px 9px;border-radius:6px;font-size:12px;line-height:1.35;box-shadow:0 2px 12px rgba(0,0,0,.35);pointer-events:none;white-space:pre-wrap;word-break:break-word;z-index:calc(var(--tk-z) + 5)}
.panel{position:fixed;width:300px;max-width:calc(100vw - 24px);background:var(--tk-paper);color:var(--tk-ink);border:1px solid var(--tk-line);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.28);padding:14px;font-size:13px;z-index:calc(var(--tk-z) + 4)}
.chip{display:block;max-width:100%;margin-bottom:8px;padding:4px 8px;background:var(--tk-surface2);border:1px solid var(--tk-line);border-radius:6px;font-family:var(--tk-mono);font-size:11px;letter-spacing:-.01em;color:var(--tk-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.panel textarea{width:100%;min-height:86px;resize:vertical;border:1px solid var(--tk-line);border-radius:8px;padding:8px;font-family:var(--tk-sans);font-size:14px;color:var(--tk-ink);background:var(--tk-paper)}
.panel input{width:100%;border:1px solid var(--tk-line);border-radius:8px;padding:8px;font-size:14px;color:var(--tk-ink);background:var(--tk-paper);margin-top:8px}
.panel textarea::placeholder,.panel input::placeholder{color:var(--tk-ink);opacity:.55}
.counter{margin-top:4px;font-family:var(--tk-mono);font-size:11px;letter-spacing:-.01em;color:var(--tk-ink);opacity:.45;text-align:right}
.counter.warn{color:var(--tk-flag);opacity:1}
.row{display:flex;gap:8px;margin-top:10px}
.row button{flex:1;border-radius:8px;padding:9px;border:1px solid transparent;font-weight:600;font-size:13px}
.btn-submit{background:var(--tk-accent);color:var(--tk-accent-ink)}
.btn-submit:disabled{opacity:.5;cursor:not-allowed}
.btn-cancel{background:var(--tk-surface2);color:var(--tk-ink);border-color:var(--tk-line)}
.status{margin-top:10px;min-height:18px;font-size:13px}
.status.err{color:var(--tk-flag)}
.status.ok{color:var(--tk-ok);font-weight:600}
.foot{margin-top:10px;font-size:11px;color:var(--tk-ink);opacity:.6;text-align:center}
.foot a{color:inherit}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;opacity:.8;vertical-align:middle}
.list-toggle{position:fixed;width:38px;height:38px;border-radius:50%;border:1px solid var(--tk-line);background:var(--tk-paper);color:var(--tk-ink);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.25);z-index:calc(var(--tk-z) + 3)}
.list-toggle svg{width:20px;height:20px;display:block}
.list-toggle .count{position:absolute;top:-5px;right:-5px;min-width:17px;height:17px;line-height:17px;padding:0 4px;border-radius:5px;background:var(--tk-accent);color:var(--tk-accent-ink);font-family:var(--tk-mono);font-size:10px;font-weight:600;letter-spacing:-.01em;text-align:center}
.list-toggle.failed .count{background:var(--tk-flag);color:#fff}
.list-toggle.pos-bottom-right{right:25px;bottom:80px}
.list-toggle.pos-bottom-left{left:25px;bottom:80px}
.drawer{position:fixed;top:0;right:0;bottom:0;width:320px;max-width:85vw;background:var(--tk-paper);color:var(--tk-ink);border-left:1px solid var(--tk-line);box-shadow:-6px 0 26px rgba(0,0,0,.22);display:flex;flex-direction:column;font-size:13px;z-index:calc(var(--tk-z) + 3)}
.drawer-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--tk-line);font-weight:600}
.drawer-head button{background:var(--tk-surface2);color:var(--tk-ink);border:1px solid var(--tk-line);border-radius:6px;padding:3px 10px;font-size:12px}
.drawer-controls{display:flex;gap:6px}
.thread{position:fixed;width:280px;max-width:calc(100vw - 24px);max-height:60vh;display:flex;flex-direction:column;background:var(--tk-paper);color:var(--tk-ink);border:1px solid var(--tk-line);border-radius:12px;box-shadow:0 10px 34px rgba(0,0,0,.28);font-size:13px;z-index:calc(var(--tk-z) + 4)}
.thread-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--tk-line);font-weight:600}
.thread-head button{background:var(--tk-surface2);color:var(--tk-ink);border:1px solid var(--tk-line);border-radius:6px;padding:3px 10px;font-size:12px}
.thread-list{flex:1;overflow-y:auto;padding:8px}
.thread-list .entry{margin-bottom:6px}
.thread-list .entry.reply{margin-left:14px}
.entry-go:disabled{cursor:default}
.drawer-list{flex:1;overflow-y:auto;padding:10px}
.drawer-empty{padding:18px 10px;color:var(--tk-ink);opacity:.6;font-size:13px;text-align:center}
.entry{display:flex;flex-direction:column;background:var(--tk-paper);border:1px solid var(--tk-line);border-radius:10px;padding:10px;margin-bottom:8px;color:var(--tk-ink)}
.entry:hover{background:var(--tk-surface2)}
.entry.reply{margin-left:22px}
.entry-go{display:flex;gap:10px;width:100%;text-align:left;background:transparent;border:0;padding:0;font:inherit;font-size:13px;color:var(--tk-ink)}
.entry .n{flex:none;width:22px;height:22px;border-radius:4px;background:var(--tk-accent);color:var(--tk-accent-ink);font-family:var(--tk-mono);font-size:11px;font-weight:600;letter-spacing:-.01em;display:flex;align-items:center;justify-content:center}
.entry.failed .n{background:var(--tk-flag);color:#fff}
.entry-main{min-width:0}
.entry .body{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;word-break:break-word}
.entry .meta{display:block;margin-top:4px;font-family:var(--tk-mono);font-size:11px;letter-spacing:-.01em;color:var(--tk-ink);opacity:.65}
.entry.failed .meta{color:var(--tk-flag);opacity:1}
.entry-actions{display:flex;gap:6px;align-self:flex-end;margin-top:8px}
.entry-actions button{padding:2px 8px;background:var(--tk-surface2);border:1px solid var(--tk-line);border-radius:5px;font-family:var(--tk-mono);font-size:11px;letter-spacing:-.01em;color:var(--tk-ink)}
.entry-actions .retry{background:var(--tk-accent);color:var(--tk-accent-ink);border-color:transparent;font-weight:600}
.entry-actions .retry:disabled{opacity:.6;cursor:default}
@media (prefers-reduced-motion: no-preference){
.spinner{animation:tk-spin .7s linear infinite}
.pin.pulse{animation:tk-pulse 1s ease-out 2}
.pin.drop{animation:tk-drop .14s ease-out}
.panel{animation:tk-rise .16s ease-out}
.thread{animation:tk-rise .16s ease-out}
.tip{animation:tk-fade .12s ease-out}
}
@keyframes tk-spin{to{transform:rotate(360deg)}}
@keyframes tk-pulse{0%{box-shadow:0 0 0 0 var(--tk-accent)}70%{box-shadow:0 0 0 12px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes tk-drop{0%{transform:scale(1.4);opacity:0}100%{transform:scale(1)}}
@keyframes tk-rise{0%{transform:translateY(8px);opacity:0}100%{transform:none;opacity:1}}
@keyframes tk-fade{0%{opacity:0}100%{opacity:1}}
@media (max-width:640px){
.panel{left:0;right:0;bottom:0;top:auto;width:auto;max-width:none;border-radius:16px 16px 0 0;padding-bottom:calc(14px + env(safe-area-inset-bottom));animation-name:tk-fade}
.drawer{width:100vw;max-width:100vw}
}
.hidden{display:none!important}
`;
}
