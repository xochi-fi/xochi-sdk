import { describe, expect, it } from "vitest";
import { parseEmbedParams, type EmbedParams } from "@xochi/widget-lib";
import { surfaceParams, withSurfaceParams, replaceSurfaceParams } from "./surfaceParams.js";
import { codeFor } from "./snippets.js";
import { readConfiguratorSearch, configuratorSearch } from "./configuratorUrl.js";
import { FRAME_DEFAULTS } from "../trade/embedParams.js";
import { DEFAULT_BACKDROP } from "./previewModel.js";

const params: EmbedParams = {
  tabs: ["send", "activity"],
  initialTab: "send",
  modes: ["onramp"],
  initialMode: "onramp",
  sendDestinations: ["payment_app"],
  fiatCurrency: "USD",
  rampProviders: ["peer"],
};

describe("configurator public surface parameters", () => {
  it("leaves provider defaults unconfigured", () => {
    expect(surfaceParams({})).toEqual({});
  });
  it("repairs initial selections excluded by narrowing without widening", () => {
    expect(surfaceParams({ ...params, initialTab: "trade", initialMode: "swap" })).toEqual(params);
  });
  it("rejects empty narrowing rather than enabling every option", () => {
    for (const key of ["tabs", "modes", "sendDestinations", "rampProviders"] as const) {
      expect(() => surfaceParams({ [key]: [] })).toThrow();
    }
  });
  it("retains unrelated options when replacing or clearing defaults", () => {
    const previous = { ...params, theme: "light", amount: "10" } as const;
    expect(replaceSurfaceParams(previous, {})).toEqual({
      theme: "light",
      amount: "10",
      layout: "full",
    });
    expect(previous.rampProviders).toEqual(["peer"]);
  });
  it("repairs an initial Send tab removed by dependent narrowing", () => {
    expect(
      surfaceParams({ initialTab: "send", modes: ["onramp"], sendDestinations: ["stealth"] })
        .initialTab,
    ).toBe("trade");
  });
  it("keeps legacy single-card layout consistent", () => {
    expect(withSurfaceParams({ layout: "swap" }, params)).toMatchObject({
      tabs: ["trade"],
      initialTab: "trade",
      modes: ["swap"],
      initialMode: "swap",
    });
  });
  it("carries only documented defaults and narrowing, never execution authority", () => {
    expect(surfaceParams({ ...params, available: true, executable: true } as EmbedParams)).toEqual(
      params,
    );
  });
  it("round trips all controls through shared links and snippets", () => {
    const shared = configuratorSearch(FRAME_DEFAULTS, DEFAULT_BACKDROP, "desktop", params);
    expect(readConfiguratorSearch(shared).params).toEqual(params);
    expect(
      parseEmbedParams(new URL(codeFor("url", "https://widget.example", params)).search),
    ).toEqual(params);
    for (const format of ["html", "react", "ramp"] as const) {
      const code = codeFor(format, "https://widget.example", params);
      for (const [key, value] of Object.entries(params))
        expect(code).toContain(`${key}: ${JSON.stringify(value)}`);
      expect(code).toContain(format === "ramp" ? "createXochiRampWidget" : "createXochiWidget");
      if (format === "ramp") {
        expect(code).toContain('direction: "offramp"');
        expect(code).toContain("widget.updateParams(");
      }
    }
  });
});
