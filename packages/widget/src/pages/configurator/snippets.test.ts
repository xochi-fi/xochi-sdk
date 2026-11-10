import { describe, expect, it } from "vitest";
import { parseEmbedParams } from "@xochi/widget-lib";
import widgetLibPackage from "@xochi/widget-lib/package.json";
import { codeFor, widgetLibModuleUrl } from "./snippets.js";

describe("configurator snippets", () => {
  it("emits every frame parameter and nothing else, however the input object was assembled", () => {
    const origin = "https://configurator.example";
    const params = {
      fromChainId: 8453,
      toChainId: 1,
      sellSymbol: "USDT",
      buySymbol: "USDC",
      amount: "250",
      settlement: "stealth",
      theme: "light",
      locked: true,
      allowedRpcMethods: ["eth_sign"],
      autoConnect: true,
    } as const;
    const publicParams = {
      fromChainId: 8453,
      toChainId: 1,
      sellSymbol: "USDT",
      buySymbol: "USDC",
      amount: "250",
      settlement: "stealth",
      theme: "light",
    };

    for (const format of ["html", "react"] as const) {
      const snippet = codeFor(format, origin, params);
      expect(snippet).toContain("createXochiWidget");
      expect(snippet).toContain(`origin: ${JSON.stringify(origin)}`);
      for (const [key, value] of Object.entries(publicParams)) {
        expect(snippet).toContain(`${key}: ${JSON.stringify(value)}`);
      }
      expect(snippet).not.toContain("locked");
      expect(snippet).not.toContain("allowedRpcMethods");
      expect(snippet).not.toContain("autoConnect");
    }

    const fallback = new URL(codeFor("url", origin, params));
    expect(fallback.origin).toBe(origin);
    expect(parseEmbedParams(fallback.search)).toEqual(publicParams);
  });

  it("imports the HTML module from the widget origin and the package only for React", () => {
    const origin = "https://widget.xochi.fi";
    const html = codeFor("html", origin, {});
    const browserModule = `${origin}/widget-lib/${widgetLibPackage.version}/index.js`;

    expect(widgetLibModuleUrl(origin)).toBe(browserModule);
    expect(html).toContain(`from "${browserModule}"`);
    expect(html).not.toContain("jsdelivr");
    expect(html).not.toContain('from "@xochi/widget-lib"');
    expect(codeFor("react", origin, {})).toContain('from "@xochi/widget-lib"');
  });
});
