export const PANEL_CSS = `
:host {
  all: initial;
}
* {
  box-sizing: border-box;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
.cfpt-fab {
  position: fixed;
  right: 20px;
  bottom: 88px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: none;
  background: #10a37f;
  color: #fff;
  font-size: 20px;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  z-index: 2147483000;
}
.cfpt-fab:hover { filter: brightness(1.1); }
.cfpt-fab[data-state="run"] { animation: cfpt-pulse 1.6s ease-in-out infinite; }
.cfpt-fab[data-state="attention"] { background: #d97706; }
.cfpt-fab[data-state="error"] { background: #dc2626; }
.cfpt-fab[data-state="done"] { background: #2563eb; }
@keyframes cfpt-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(16, 163, 127, 0.55); }
  50% { box-shadow: 0 0 0 12px rgba(16, 163, 127, 0); }
}
.cfpt-panel {
  position: fixed;
  right: 20px;
  bottom: 148px;
  width: 380px;
  max-height: min(72vh, 640px);
  display: flex;
  flex-direction: column;
  background: #202123;
  color: #ececf1;
  border: 1px solid #444654;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  z-index: 2147483001;
  overflow: hidden;
}
.cfpt-panel.cfpt-hidden { display: none; }
.cfpt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: #2a2b32;
  border-bottom: 1px solid #444654;
}
.cfpt-title { font-weight: 700; font-size: 14px; flex: 1; }
.cfpt-chip {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: #444654;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.cfpt-chip[data-phase="planning"] { background: #0e7490; }
.cfpt-chip[data-phase="plan_ready"] { background: #a16207; }
.cfpt-chip[data-phase="developing"] { background: #15803d; }
.cfpt-chip[data-phase="complete"] { background: #2563eb; }
.cfpt-body { padding: 14px; overflow-y: auto; font-size: 13px; line-height: 1.45; }
.cfpt-body h3 { margin: 0 0 8px; font-size: 13px; }
.cfpt-warn {
  background: #78350f;
  color: #fde68a;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
  margin-bottom: 10px;
}
.cfpt-note { color: #b4b4bc; font-size: 12px; margin: 8px 0; }
.cfpt-field { margin-bottom: 10px; }
.cfpt-field label { display: block; font-size: 12px; color: #b4b4bc; margin-bottom: 4px; }
textarea, input[type="text"] {
  width: 100%;
  background: #343541;
  color: #ececf1;
  border: 1px solid #565869;
  border-radius: 8px;
  padding: 8px;
  font-size: 13px;
  resize: vertical;
}
textarea:focus, input:focus { outline: 1px solid #10a37f; }
.cfpt-radio-row { display: flex; gap: 14px; margin-bottom: 8px; font-size: 13px; }
.cfpt-radio-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.cfpt-btn {
  display: inline-block;
  border: none;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  background: #444654;
  color: #ececf1;
  margin-right: 8px;
  margin-top: 6px;
}
.cfpt-btn:hover { filter: brightness(1.15); }
.cfpt-btn-primary { background: #10a37f; color: #fff; }
.cfpt-btn-danger { background: #7f1d1d; }
.cfpt-status-line { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cfpt-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #565869;
  border-top-color: #10a37f;
  border-radius: 50%;
  animation: cfpt-spin 0.9s linear infinite;
}
@keyframes cfpt-spin { to { transform: rotate(360deg); } }
.cfpt-counters { color: #b4b4bc; font-size: 12px; margin-bottom: 8px; }
.cfpt-log {
  background: #16171a;
  border: 1px solid #343541;
  border-radius: 8px;
  padding: 8px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-height: 150px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.cfpt-log .warn { color: #fbbf24; }
.cfpt-log .error { color: #f87171; }
.cfpt-log .marker { color: #34d399; }
.cfpt-link { color: #58a6ff; text-decoration: none; }
.cfpt-link:hover { text-decoration: underline; }
.cfpt-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483002;
}
.cfpt-modal {
  width: min(440px, 92vw);
  background: #202123;
  color: #ececf1;
  border: 1px solid #444654;
  border-radius: 16px;
  padding: 28px;
  text-align: center;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
}
.cfpt-modal .big { font-size: 44px; margin-bottom: 8px; }
.cfpt-modal h2 { margin: 0 0 8px; font-size: 20px; }
.cfpt-modal p { color: #b4b4bc; font-size: 13px; margin: 0 0 16px; }
`;
