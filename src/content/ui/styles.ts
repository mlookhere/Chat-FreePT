export const PANEL_CSS = `
:host {
  all: initial;
  color-scheme: inherit;
  --cfpt-surface: var(
    --cfpt-native-surface,
    var(--color-background-composer-surface, var(--color-surface, Canvas))
  );
  --cfpt-text: var(--cfpt-native-text, var(--color-text-primary, var(--color-text, CanvasText)));
  --cfpt-muted: var(
    --color-text-secondary,
    color-mix(in srgb, var(--cfpt-text) 62%, transparent)
  );
  --cfpt-border: var(
    --color-border,
    color-mix(in srgb, var(--cfpt-text) 18%, transparent)
  );
  --cfpt-border-strong: var(
    --color-border-strong,
    color-mix(in srgb, var(--cfpt-text) 28%, transparent)
  );
  --cfpt-field-surface: var(
    --color-surface-secondary,
    color-mix(in srgb, var(--cfpt-surface) 82%, var(--cfpt-text) 18%)
  );
  --cfpt-hover: var(
    --color-surface-tertiary,
    color-mix(in srgb, var(--cfpt-text) 9%, transparent)
  );
  --cfpt-accent: var(
    --color-text-composer-reference,
    var(--app-color-border-focus, var(--app-color-accent-blue, var(--accent-blue, #3a83f7)))
  );
  --cfpt-focus: var(--app-color-border-focus, var(--cfpt-accent));
  --cfpt-radius: var(--cfpt-native-radius, var(--composer-border-radius, 26px));
}
:host([data-cfpt-host="launcher"]) {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  width: 36px;
  height: 36px;
  align-items: center;
  justify-content: center;
  align-self: center;
  margin: 0;
  padding: 0;
  pointer-events: auto;
  z-index: 2147482000;
}
:host([data-cfpt-host="launcher"][data-fallback="true"]) {
  position: absolute;
  inset-inline-start: 52px;
  bottom: 8px;
}
:host([data-cfpt-host="overlay"]) {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 20;
}
:host([data-cfpt-host="overlay"][data-expanded="true"]) {
  position: relative;
  inset: auto;
  display: block;
  width: 100%;
  height: auto;
  min-width: 0;
  pointer-events: auto;
}
* {
  box-sizing: border-box;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
button, textarea, input, select { font: inherit; }
.cfpt-hidden { display: none !important; }
.cfpt-launcher {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 999px;
  padding: 0;
  margin: 0;
  background: transparent;
  color: var(--cfpt-muted);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
}
.cfpt-launcher:hover { background: var(--cfpt-hover); color: var(--cfpt-text); }
.cfpt-launcher:active { transform: scale(0.95); }
.cfpt-launcher:focus-visible { outline: 2px solid var(--cfpt-accent); outline-offset: 2px; }
.cfpt-launcher-tooltip {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  z-index: 4;
  padding: 5px 8px;
  border: 1px solid color-mix(in srgb, var(--cfpt-border) 70%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--cfpt-text) 94%, transparent);
  color: var(--cfpt-surface);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transform: translate(-50%, 2px);
  transition: opacity 100ms ease, transform 100ms ease, visibility 100ms ease;
}
.cfpt-launcher:hover + .cfpt-launcher-tooltip,
.cfpt-launcher:focus-visible + .cfpt-launcher-tooltip {
  opacity: 1;
  visibility: visible;
  transform: translate(-50%, 0);
}
.cfpt-airplane { width: 18px; height: 18px; display: block; fill: currentColor; }
.cfpt-launcher[data-state="run"] {
  color: var(--cfpt-accent);
  animation: cfpt-launcher-pulse 1.6s ease-in-out infinite;
}
.cfpt-launcher[data-state="attention"] { color: #d97706; }
.cfpt-launcher[data-state="error"] { color: #dc2626; }
.cfpt-launcher[data-state="done"] { color: #2563eb; }
:host([data-highlighted="true"]) .cfpt-launcher {
  color: var(--cfpt-accent);
  animation: cfpt-onboarding-pulse 1.15s ease-in-out infinite;
}
@keyframes cfpt-launcher-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--cfpt-accent) 35%, transparent); }
  50% { box-shadow: 0 0 0 6px transparent; }
}
@keyframes cfpt-onboarding-pulse {
  0%, 100% {
    transform: scale(1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--cfpt-accent) 28%, transparent);
  }
  50% {
    transform: scale(1.08);
    box-shadow: 0 0 0 8px color-mix(in srgb, var(--cfpt-accent) 8%, transparent);
  }
}
.cfpt-takeover-backdrop {
  position: relative;
  width: 100%;
  height: auto;
  pointer-events: auto;
  background: transparent;
}
.cfpt-panel {
  position: relative;
  width: 100%;
  min-width: 0;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  max-height: min(64vh, 640px);
  color: var(--cfpt-text);
  background: var(--cfpt-surface);
  border: 1px solid var(--cfpt-border-strong);
  border-radius: var(--cfpt-radius);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--cfpt-accent) 18%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.cfpt-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 46px;
  padding: 8px 10px 7px 15px;
  background: color-mix(in srgb, var(--cfpt-accent) 7%, var(--cfpt-surface));
  border-bottom: 1px solid var(--cfpt-border);
}
.cfpt-panel-head strong {
  font-size: 13px;
  letter-spacing: 0.01em;
  color: var(--cfpt-text);
}
.cfpt-panel-close {
  min-width: 72px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  border: 1px solid color-mix(in srgb, var(--cfpt-accent) 45%, var(--cfpt-border));
  border-radius: 999px;
  padding: 0 10px;
  background: color-mix(in srgb, var(--cfpt-accent) 10%, var(--cfpt-surface));
  color: var(--cfpt-accent);
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
}
.cfpt-panel-close .cfpt-airplane { width: 15px; height: 15px; }
.cfpt-panel-close:hover {
  background: color-mix(in srgb, var(--cfpt-accent) 16%, var(--cfpt-surface));
}
.cfpt-panel-close:focus-visible {
  outline: 2px solid var(--cfpt-focus);
  outline-offset: 2px;
}
.cfpt-body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px 16px 16px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.45;
}
.cfpt-body h3 { margin: 0 0 8px; color: var(--cfpt-text); font-size: 14px; }
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
.cfpt-field { margin-bottom: 12px; }
.cfpt-field label {
  display: block;
  margin-bottom: 5px;
  color: color-mix(in srgb, var(--cfpt-text) 78%, var(--cfpt-muted));
  font-size: 12px;
  font-weight: 600;
}
textarea, input[type="text"] {
  width: 100%;
  background: var(--cfpt-field-surface);
  color: var(--cfpt-text);
  border: 1px solid var(--cfpt-border-strong);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 13px;
  caret-color: var(--cfpt-accent);
  resize: vertical;
  transition: border-color 120ms ease, box-shadow 120ms ease, background 120ms ease;
}
textarea:hover, input[type="text"]:hover {
  border-color: color-mix(in srgb, var(--cfpt-accent) 38%, var(--cfpt-border-strong));
}
textarea:focus, input:focus, select:focus {
  outline: none;
  border-color: var(--cfpt-focus);
  box-shadow:
    0 0 0 1px var(--cfpt-focus),
    0 0 0 4px color-mix(in srgb, var(--cfpt-accent) 14%, transparent);
}
.cfpt-radio-row { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 9px; font-size: 13px; }
.cfpt-radio-row label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.cfpt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--cfpt-border-strong);
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 650;
  line-height: 1.2;
  cursor: pointer;
  background: var(--cfpt-field-surface);
  color: var(--cfpt-text);
  margin-right: 8px;
  margin-top: 6px;
  text-decoration: none;
}
.cfpt-btn:hover {
  border-color: color-mix(in srgb, var(--cfpt-accent) 38%, var(--cfpt-border-strong));
  background: color-mix(in srgb, var(--cfpt-accent) 7%, var(--cfpt-field-surface));
}
.cfpt-btn:focus-visible { outline: 2px solid var(--cfpt-focus); outline-offset: 2px; }
.cfpt-btn-primary {
  background: var(--cfpt-accent);
  color: var(--color-text-on-accent, #fff);
  border-color: var(--cfpt-accent);
}
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
  background: color-mix(in srgb, var(--cfpt-surface) 88%, #000 12%);
  border: 1px solid var(--cfpt-border);
  border-radius: 10px;
  padding: 8px;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  max-height: 170px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.cfpt-log .warn { color: #d97706; }
.cfpt-log .error { color: #dc2626; }
.cfpt-log .marker { color: #059669; }
.cfpt-link { color: #3b82f6; text-decoration: none; }
.cfpt-link:hover { text-decoration: underline; }
.cfpt-onboarding-toast {
  position: absolute;
  pointer-events: auto;
  width: min(310px, calc(100vw - 24px));
  padding: 12px;
  border: 1px solid var(--cfpt-border-strong);
  border-radius: 12px;
  background: var(--cfpt-surface);
  color: var(--cfpt-text);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  font-size: 12px;
  line-height: 1.4;
}
.cfpt-onboarding-toast strong { display: block; padding-right: 22px; font-size: 13px; }
.cfpt-onboarding-toast p { margin: 6px 0 10px; color: var(--cfpt-muted); }
.cfpt-icon-close {
  position: absolute;
  top: 7px;
  inset-inline-end: 8px;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--cfpt-muted);
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
}
.cfpt-icon-close:hover { background: var(--cfpt-hover); color: var(--cfpt-text); }
.cfpt-check-row { display: flex; align-items: center; gap: 7px; color: var(--cfpt-muted); cursor: pointer; }
.cfpt-check-row input { margin: 0; }
.cfpt-toast-continue { margin-top: 10px; margin-right: 0; }
.cfpt-setup-backdrop {
  position: relative;
  width: 100%;
  height: auto;
  display: block;
  padding: 0;
  pointer-events: auto;
  background: transparent;
}
.cfpt-setup-card {
  position: relative;
  width: 100%;
  max-height: min(64vh, 640px);
  overflow-y: auto;
  padding: 18px;
  border: 1px solid var(--cfpt-border-strong);
  border-radius: var(--cfpt-radius);
  background: var(--cfpt-surface);
  color: var(--cfpt-text);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--cfpt-accent) 18%, transparent),
    0 1px 2px rgba(0, 0, 0, 0.08);
}
.cfpt-setup-icon {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  margin-bottom: 10px;
  border-radius: 11px;
  background: color-mix(in srgb, var(--cfpt-accent) 14%, var(--cfpt-surface));
  color: var(--cfpt-accent);
}
.cfpt-setup-icon svg { width: 19px; height: 19px; fill: currentColor; }
.cfpt-setup-card h2 { margin: 0 30px 8px 0; font-size: 18px; line-height: 1.25; }
.cfpt-setup-lead { margin: 0 0 12px; color: var(--cfpt-muted); font-size: 13px; line-height: 1.45; }
.cfpt-setup-steps { margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.5; }
.cfpt-setup-steps li + li { margin-top: 7px; }
.cfpt-setup-steps code {
  padding: 1px 4px;
  border-radius: 5px;
  background: var(--cfpt-hover);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.cfpt-setup-footnote { margin: 12px 0 0; color: var(--cfpt-muted); font-size: 11px; line-height: 1.45; }
.cfpt-setup-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.cfpt-setup-actions .cfpt-btn { margin: 0; }
.cfpt-plan-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 10px;
  padding: 4px 8px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--cfpt-accent) 13%, transparent);
  color: var(--cfpt-text);
  font-size: 11px;
  font-weight: 700;
}
@media (max-width: 620px) {
  :host([data-cfpt-host="launcher"]) { width: 34px; height: 34px; }
  .cfpt-launcher { width: 34px; height: 34px; }
  .cfpt-panel { max-height: min(68vh, 620px); }
  .cfpt-body { padding: 13px 14px 15px; }
  .cfpt-btn { padding-inline: 11px; }
  .cfpt-setup-card { padding: 17px; }
}
@media (prefers-reduced-motion: reduce) {
  .cfpt-launcher,
  :host([data-highlighted="true"]) .cfpt-launcher,
  .cfpt-launcher-tooltip,
  .cfpt-spinner { animation: none; transition: none; }
}
`;
