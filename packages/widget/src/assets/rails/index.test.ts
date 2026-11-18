import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { railLogo } from "./index";

const files = Object.keys(import.meta.glob("./*.{svg,png}")).map((path) => basename(path));
const included = [...new Set(files.map((file) => file.replace(/(?:-dark)?\.(?:svg|png)$/, "")))];

describe("railLogo", () => {
  it("looks up a known rail by ID", () => {
    expect(railLogo("monzo")).toMatchObject({
      light: expect.stringContaining("monzo.png"),
      dark: expect.stringContaining("monzo-dark.png"),
      width: 2414,
      height: 808,
    });
  });

  it.each(["unknown", "zelle", "constructor", "__proto__"])("returns undefined for %s", (id) => {
    expect(railLogo(id)).toBeUndefined();
  });

  it("lists every shipped variant in the manifest", () => {
    const urls = included.flatMap((id) => {
      const logo = railLogo(id);
      return logo?.dark ? [logo.light, logo.dark] : logo ? [logo.light] : [];
    });
    expect(urls.map((url) => basename(url.split("?")[0])).sort()).toEqual(files.sort());
  });

  it.each(included)("ships valid image files for %s", (id) => {
    const logo = railLogo(id)!;
    expect(Number.isFinite(logo.clearSpaceRatio)).toBe(true);
    expect(logo.clearSpaceRatio).toBeGreaterThanOrEqual(0);

    for (const variant of [logo.light, logo.dark]) {
      if (variant === undefined) continue;

      const filename = basename(variant.split("?")[0]);
      const asset = readFileSync(new URL(filename, import.meta.url));
      if (filename.endsWith(".svg")) {
        const svg = asset.toString("utf8");
        expect(svg).toMatch(/^\s*<svg\b[^>]*\bviewBox=/);
        expect(svg).not.toMatch(
          /<!|<\?|<(?:[\w-]+:)?(?:script|foreignObject|image|style|iframe|a|animate\w*|set)\b|\s(?:[\w-]+:)?on[\w-]+\s*=|\b(?:href|src)\s*=\s*["'](?!#)|url\(\s*["']?(?!#)/i,
        );
      } else {
        expect(filename).toMatch(/\.png$/);
        expect(asset.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(asset.toString("ascii", 12, 16)).toBe("IHDR");
        const width = asset.readUInt32BE(16);
        const height = asset.readUInt32BE(20);
        expect(width).toBeGreaterThan(0);
        expect(height).toBeGreaterThan(0);
        if (variant === logo.light) {
          expect([width, height]).toEqual([logo.width, logo.height]);
        }
      }
    }
  });
});
