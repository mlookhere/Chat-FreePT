import { query } from "../selectors";

interface NativeSurfaceSnapshot {
  form: HTMLFormElement;
  surface: HTMLElement;
  composer: HTMLElement | null;
  composerContentEditable: string | null;
  composerTabIndex: string | null;
  composerAriaDisabled: string | null;
  position: string;
  inset: string;
  width: string;
  height: string;
  overflow: string;
  clipPath: string;
  opacity: string;
  pointerEvents: string;
  visibility: string;
  inert: boolean;
  ariaHidden: string | null;
}

function themeValue(styles: CSSStyleDeclaration[], names: string[]): string {
  for (const name of names) {
    for (const style of styles) {
      const value = style.getPropertyValue(name).trim();
      if (value) return value;
    }
  }
  return "";
}

function isTransparentColor(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return (
    !normalized ||
    normalized === "transparent" ||
    normalized === "rgba(0,0,0,0)" ||
    normalized === "rgb(0 0 0/0)"
  );
}

function effectiveBackground(element: HTMLElement): string {
  let current: HTMLElement | null = element;
  while (current) {
    const value = getComputedStyle(current).backgroundColor;
    if (!isTransparentColor(value)) return value;
    current = current.parentElement;
  }
  return "";
}

/**
 * Owns every mutation made to ChatGPT's native composer while Chat FreePT occupies its slot.
 * Panel owns FreePT UI; this class owns only the host-page composer lifecycle.
 */
export class NativeComposerHost {
  private snapshot: NativeSurfaceSnapshot | null = null;
  private automationDepth = 0;

  constructor(
    private readonly overlayHost: HTMLElement,
    private readonly focusIntegratedSurface: () => void,
  ) {}

  surface(): HTMLElement | null {
    const surface = query("composerSurface");
    return surface instanceof HTMLElement ? surface : null;
  }

  form(): HTMLFormElement | null {
    const form = query("composerForm");
    return form instanceof HTMLFormElement ? form : null;
  }

  mountOverlay(): void {
    const surface = this.surface();
    const slot = surface?.parentElement;
    if (surface && slot) {
      if (
        this.overlayHost.parentElement !== slot ||
        this.overlayHost.previousElementSibling !== surface
      ) {
        surface.insertAdjacentElement("afterend", this.overlayHost);
      }
      return;
    }
    if (!this.overlayHost.isConnected) this.form()?.appendChild(this.overlayHost);
  }

  activate(): void {
    const surface = this.surface();
    const form = this.form();
    const parent = surface?.parentElement;
    if (!surface || !form || !parent) return;

    this.mountOverlay();
    if (this.snapshot?.surface === surface) {
      this.guard(this.automationDepth === 0);
      return;
    }

    this.restore(false);
    this.moveFocusOutside(surface);
    this.snapshot = this.capture(form, surface);

    surface.style.position = "absolute";
    surface.style.inset = "0 auto auto 0";
    surface.style.width = "1px";
    surface.style.height = "1px";
    surface.style.overflow = "hidden";
    surface.style.clipPath = "inset(50%)";
    surface.style.opacity = "0";
    surface.style.pointerEvents = "none";
    surface.dataset["cfptNativeHidden"] = "true";
    form.dataset["cfptTakeover"] = "true";
    this.guard(this.automationDepth === 0);
  }

  async withAutomationAccess<T>(task: () => Promise<T>): Promise<T> {
    this.automationDepth += 1;
    this.guard(false);
    try {
      return await task();
    } finally {
      this.automationDepth = Math.max(0, this.automationDepth - 1);
      this.guard(this.automationDepth === 0);
      if (this.automationDepth === 0 && this.snapshot) {
        queueMicrotask(() => this.focusIntegratedSurface());
      }
    }
  }

  isGuardedPath(path: EventTarget[]): boolean {
    return (
      this.automationDepth === 0 &&
      this.snapshot !== null &&
      path.includes(this.snapshot.surface)
    );
  }

  isGuardedTarget(target: EventTarget | null): boolean {
    return (
      this.automationDepth === 0 &&
      this.snapshot !== null &&
      target instanceof Node &&
      this.snapshot.surface.contains(target)
    );
  }

  restore(focusNative = true): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;

    snapshot.surface.style.position = snapshot.position;
    snapshot.surface.style.inset = snapshot.inset;
    snapshot.surface.style.width = snapshot.width;
    snapshot.surface.style.height = snapshot.height;
    snapshot.surface.style.overflow = snapshot.overflow;
    snapshot.surface.style.clipPath = snapshot.clipPath;
    snapshot.surface.style.opacity = snapshot.opacity;
    snapshot.surface.style.pointerEvents = snapshot.pointerEvents;
    snapshot.surface.style.visibility = snapshot.visibility;
    snapshot.surface.inert = snapshot.inert;
    this.restoreComposerAttributes(snapshot);
    this.restoreAttribute(snapshot.surface, "aria-hidden", snapshot.ariaHidden);
    delete snapshot.surface.dataset["cfptNativeHidden"];
    delete snapshot.surface.dataset["cfptNativeGuarded"];
    delete snapshot.form.dataset["cfptTakeover"];
    this.snapshot = null;

    if (!focusNative) return;
    queueMicrotask(() => {
      const composer = query("composer");
      if (composer instanceof HTMLElement) composer.focus({ preventScroll: true });
    });
  }

  syncTheme(): void {
    const surface = this.surface();
    if (!surface) return;
    const form = this.form();
    const submitCandidate = query("sendButton");
    const submit = submitCandidate instanceof HTMLElement ? submitCandidate : null;
    const elements = [surface, form, submit, document.body, document.documentElement].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    );
    const styles = elements.map((element) => getComputedStyle(element));
    const surfaceStyle = styles[0];
    if (!surfaceStyle) return;

    const read = (...names: string[]): string => themeValue(styles, names);
    const accent = this.resolveAccent(read, submit);
    this.setThemeVar(
      "--cfpt-native-surface",
      read(
        "--composer-surface-primary",
        "--main-surface-primary",
        "--color-background-composer-surface",
        "--color-surface",
      ) || effectiveBackground(surface),
    );
    this.setThemeVar(
      "--cfpt-native-text",
      read("--text-primary", "--color-text-primary", "--color-text") || surfaceStyle.color,
    );
    this.setThemeVar("--cfpt-native-radius", surfaceStyle.borderRadius);
    this.setThemeVar("--cfpt-accent", accent);
    this.setThemeVar(
      "--cfpt-focus",
      read("--app-color-border-focus", "--focus-ring", "--color-border-focus") || accent,
    );
    this.setThemeVar(
      "--cfpt-field-surface",
      read(
        "--composer-surface-secondary",
        "--main-surface-secondary",
        "--color-surface-secondary",
        "--app-color-background-surface-under",
      ),
    );
    this.setThemeVar(
      "--cfpt-border",
      read("--border-light", "--color-border", "--app-color-border"),
    );
    this.setThemeVar(
      "--cfpt-border-strong",
      read("--border-medium", "--color-border-strong", "--app-color-border-heavy"),
    );
    this.setThemeVar(
      "--cfpt-muted",
      read("--text-secondary", "--color-text-secondary", "--app-color-text-secondary"),
    );
    if (surfaceStyle.colorScheme) this.overlayHost.style.colorScheme = surfaceStyle.colorScheme;
  }

  private capture(form: HTMLFormElement, surface: HTMLElement): NativeSurfaceSnapshot {
    const composerCandidate = query("composer");
    const composer =
      composerCandidate instanceof HTMLElement && surface.contains(composerCandidate)
        ? composerCandidate
        : null;
    return {
      form,
      surface,
      composer,
      composerContentEditable: composer?.getAttribute("contenteditable") ?? null,
      composerTabIndex: composer?.getAttribute("tabindex") ?? null,
      composerAriaDisabled: composer?.getAttribute("aria-disabled") ?? null,
      position: surface.style.position,
      inset: surface.style.inset,
      width: surface.style.width,
      height: surface.style.height,
      overflow: surface.style.overflow,
      clipPath: surface.style.clipPath,
      opacity: surface.style.opacity,
      pointerEvents: surface.style.pointerEvents,
      visibility: surface.style.visibility,
      inert: surface.inert === true,
      ariaHidden: surface.getAttribute("aria-hidden"),
    };
  }

  private guard(guarded: boolean): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    snapshot.surface.inert = guarded;
    snapshot.surface.style.visibility = guarded ? "hidden" : snapshot.visibility;
    snapshot.surface.dataset["cfptNativeGuarded"] = String(guarded);
    snapshot.surface.setAttribute("aria-hidden", "true");
    this.setComposerEditable(snapshot, !guarded);
    if (guarded && snapshot.surface.contains(document.activeElement)) {
      this.focusIntegratedSurface();
    }
  }

  private setComposerEditable(snapshot: NativeSurfaceSnapshot, editable: boolean): void {
    const composer = snapshot.composer;
    if (!composer) return;
    if (!editable) {
      composer.setAttribute("contenteditable", "false");
      composer.setAttribute("tabindex", "-1");
      composer.setAttribute("aria-disabled", "true");
      return;
    }
    this.restoreComposerAttributes(snapshot);
  }

  private restoreComposerAttributes(snapshot: NativeSurfaceSnapshot): void {
    const composer = snapshot.composer;
    if (!composer) return;
    this.restoreAttribute(composer, "contenteditable", snapshot.composerContentEditable);
    this.restoreAttribute(composer, "tabindex", snapshot.composerTabIndex);
    this.restoreAttribute(composer, "aria-disabled", snapshot.composerAriaDisabled);
  }

  private restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  private moveFocusOutside(surface: HTMLElement): void {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !surface.contains(active)) return;
    this.focusIntegratedSurface();
    if (surface.contains(document.activeElement)) active.blur();
  }

  private resolveAccent(
    read: (...names: string[]) => string,
    submit: HTMLElement | null | undefined,
  ): string {
    return (
      read(
        "--theme-submit-btn-bg",
        "--theme-submit-button-bg",
        "--accent-primary",
        "--accent-color",
        "--color-accent",
        "--color-text-composer-reference",
        "--app-color-border-focus",
        "--app-color-accent-blue",
        "--accent-blue",
      ) ||
      (submit && !isTransparentColor(getComputedStyle(submit).backgroundColor)
        ? getComputedStyle(submit).backgroundColor
        : "")
    );
  }

  private setThemeVar(name: string, value: string): void {
    if (value) this.overlayHost.style.setProperty(name, value);
    else this.overlayHost.style.removeProperty(name);
  }
}
