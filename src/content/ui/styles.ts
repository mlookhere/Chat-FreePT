export const PANEL_CSS = `
:host {
  all: initial;
  display: block;
  width: 100%;
  pointer-events: none;
  color-scheme: inherit;
  --cfpt-surface: var(--composer-surface-primary, Canvas);
  --cfpt-text: var(--token-text-primary, CanvasText);
  --cfpt-muted: var(--token-text-secondary, color-mix(in srgb, CanvasText 65%, transparent));
  --cfpt-border: var(--token-border-light, color-mix(in srgb, CanvasText 16%, transparent));
  --cfpt-hover: var(--token-surface-hover, color-mix(in srgb, CanvasText 8%, transparent));
  --cfpt-accent: var(--theme-submit-btn-bg, #10a37f);
}
* {
  box-sizing: border-box;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
button, textarea, input { font: inherit; }
.cfpt-dock {
  pointer-events: auto;
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--cfpt-border);
  border-radius: 18px;
  padding: 6px 10px;
  background: var(--cfpt-surface);
  color: var(--cfpt-text);
  cursor: pointer;
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.08);
  text-align: start;
}
.cfpt-dock:hover { background: var(--cfpt-hover); }
.cfpt-dock:focus-visible { outline: 2px solid var(--cfpt-accent); outline-offset: 2px; }
.cfpt-mark {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  flex: 0 0 24px;
  border-radius: 8px;
  background: var(--cfpt-accent);
  color: #fff;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: -0.2px;
}
.cfpt-dock[data-state="attention"] .cfpt-mark { background: #d97706; }
.cfpt-dock[data-state="error"] .cfpt-mark { background: #dc2626; }
.cfpt-dock[data-state="done"] .cfpt-mark { background: #2563eb; }
.cfpt-dock[data-state="run"] .cfpt-mark { animation: cfpt-pulse 1.6s ease-in-out infinite; }
@keyframes cfpt-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--cfpt-accent) 45%, transparent); }
  50% { box-shadow: 0 0 0 7px transparent; }
}
.cfpt-dock-title { font-size: 13px; font-weight: 650; white-space: nowrap; }
.cfpt-dock-status {
  min-width: 0;
  flex: 1;
  color: var(--cfpt-muted);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cfpt-chip {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 650;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--cfpt-hover);
  color: var(--cfpt-muted);
  text-transform: uppercase;
  letter-spacing: 0.35px;
}
.cfpt-chip[data-phase="planning"] { color: #0891b2; }
.cfpt-chip[data-phase="plan_ready"] { color: #ca8a04; }
.cfpt-chip[data-phase="developing"] { color: #16a34a; }
.cfpt-chip[data-phase="complete"] { color: #2563eb; }
.cfpt-chevron { flex: 0 0 auto; color: var(--cfpt-muted); font-size: 11px; }
.cfpt-panel {
  pointer-events: auto;
  width: 100%;
  max-height: min(52vh, 520px);
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
  background: var(--cfpt-surface);
  color: var(--cfpt-text);
  border: 1px solid var(--cfpt-border);
  border-radius: 18px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16);
  overflow: hidden;
}
.cfpt-panel.cfpt-hidden { display: none; }
.cfpt-body { padding: 14px; overflow-y: auto; font-size: 13px; line-height: 1.45; }
.cfpt-body h3 { margin: 0 0 8px; color: var(--cfpt-text); font-size: 13px; }
.cfpt-warn {
  background: color-mix(in srgb, #d97706 18%, var(--cfpt-surface));
  color: var(--cfpt-text);
  border: 1px solid color-mix(in srgb, #d97706 38%, transparent);
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 12px;
  margin-bottom: 10px;
}
.cfpt-note { color: var(--cfpt-muted); font-size: 12px; margin: 8px 0; }
.cfpt-field { margin-bottom: 10px; }
.cfpt-field label { display: block; font-size: 12px; color: var(--cfpt-muted); margin-bottom: 4px; }
textarea, input[type="text"] {
  width: 100%;
  background: color-mix(in srgb, var(--cfpt-surface) 92%, CanvasText 8%);
  color: var(--cfpt-text);
  border: 1px solid var(--cfpt-border);
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 13px;
  resize: vertical;
}
textarea:focus, input:focus { outline: 2px solid var(--cfpt-accent); outline-offset: 1px; }
.cfpt-radio-row { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; font-size: 13px; }
.cfpt-radio-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.cfpt-btn {
  display: inline-block;
  border: 1px solid var(--cfpt-border);
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: var(--cfpt-hover);
  color: var(--cfpt-text);
  margin-right: 8px;
  margin-top: 6px;
}
.cfpt-btn:hover { filter: brightness(1.06); }
.cfpt-btn:focus-visible { outline: 2px solid var(--cfpt-accent); outline-offset: 2px; }
.cfpt-btn-primary { background: var(--cfpt-accent); color: #fff; border-color: transparent; }
.cfpt-btn-danger {
  background: color-mix(in srgb, #dc2626 18%, var(--cfpt-surface));
  color: #dc2626;
  border-color: color-mix(in srgb, #dc2626 30%, transparent);
}
.cfpt-status-line { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cfpt-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--cfpt-border);
  border-top-color: var(--cfpt-accent);
  border-radius: 50%;
  animation: cfpt-spin 0.9s linear infinite;
}
@keyframes cfpt-spin { to { transform: rotate(360deg); } }
.cfpt-counters { color: var(--cfpt-muted); font-size: 12px; margin-bottom: 8px; }
.cfpt-log {
  background: color-mix(in srgb, var(--cfpt-surface) 90%, #000 10%);
  border: 1px solid var(--cfpt-border);
  border-radius: 10px;
  padding: 8px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-height: 150px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.cfpt-log .warn { color: #d97706; }
.cfpt-log .error { color: #dc2626; }
.cfpt-log .marker { color: #059669; }
.cfpt-link { color: #3b82f6; text-decoration: none; }
.cfpt-link:hover { text-decoration: underline; }
@media (max-width: 520px) {
  .cfpt-dock-title { display: none; }
  .cfpt-chip { display: none; }
  .cfpt-body { padding: 12px; }
  .cfpt-btn { padding-inline: 11px; }
}
`;
