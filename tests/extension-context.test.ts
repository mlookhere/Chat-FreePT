import { describe, expect, it, vi } from "vitest";
import {
  createExtensionContextGuard,
  isExtensionContextInvalidated,
} from "../src/content/extension-context";

describe("extension context lifecycle", () => {
  it("recognizes Chrome extension-context invalidation errors", () => {
    expect(isExtensionContextInvalidated(new Error("Extension context invalidated."))).toBe(true);
    expect(isExtensionContextInvalidated("extension context invalidated")).toBe(true);
    expect(isExtensionContextInvalidated(new Error("storage temporarily unavailable"))).toBe(false);
    expect(isExtensionContextInvalidated({ message: "Extension context invalidated." })).toBe(
      false,
    );
    expect(isExtensionContextInvalidated(null)).toBe(false);
  });

  it("turns invalidation into one terminal disposal", () => {
    const dispose = vi.fn();
    const guard = createExtensionContextGuard(dispose);

    expect(guard.invalidated).toBe(false);
    expect(guard.handle(new Error("Extension context invalidated."))).toBe(true);
    expect(guard.invalidated).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);

    expect(guard.handle(new Error("Extension context invalidated."))).toBe(true);
    guard.invalidate();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("leaves genuine operational errors available to normal logging/retry logic", () => {
    const dispose = vi.fn();
    const guard = createExtensionContextGuard(dispose);

    expect(guard.handle(new Error("quota exceeded"))).toBe(false);
    expect(guard.invalidated).toBe(false);
    expect(dispose).not.toHaveBeenCalled();
  });
});
