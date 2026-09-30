import { describe, it, expect } from "vitest";
import { styles } from "../../src/ui/styles";

describe("thread popover", () => {
  const css = styles("#6d28d9");

  it("shows a comment in full, where the drawer clamps it to four lines", () => {
    expect(css).toContain(".entry .body{display:-webkit-box;-webkit-line-clamp:4;");
    expect(css).toContain(".thread .entry .body{display:block;-webkit-line-clamp:unset;overflow:visible}");
  });

  it("is wide enough to read, and never wider than the viewport", () => {
    expect(css).toMatch(/\.thread\{position:fixed;width:360px;max-width:calc\(100vw - 24px\);/);
  });
});
