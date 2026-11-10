/**
 * The configurator's own URL (xochi-widget#36, #47): its keys never collide
 * with the frame's, and every preview vocabulary value round-trips.
 */

import { describe, it, expect } from "vitest";
import { embedOverrides, FRAME_DEFAULTS } from "../trade/embedParams.js";
import { EMBED_PARAM } from "@xochi/widget-lib";
import { VIEW_PARAM, configuratorSearch, readConfiguratorSearch } from "./configuratorUrl.js";
import { BACKDROP_KINDS, DEFAULT_BACKDROP, PREVIEW_DEVICES } from "./previewModel.js";

describe("configurator URL", () => {
  it("uses no key the frame reads", () => {
    const frameKeys = new Set<string>(Object.values(EMBED_PARAM));
    const viewKeys = Object.values(VIEW_PARAM);
    expect(viewKeys.filter((key) => frameKeys.has(key))).toEqual([]);
    // And no two configurator keys share a name either.
    expect(new Set(viewKeys).size).toBe(viewKeys.length);
  });

  it("round-trips every backdrop kind and device", () => {
    for (const kind of BACKDROP_KINDS) {
      for (const device of PREVIEW_DEVICES) {
        const backdrop = { kind, custom: "#2b3a55" };
        const read = readConfiguratorSearch(configuratorSearch(FRAME_DEFAULTS, backdrop, device));
        expect(read, `${kind} ${device}`).toEqual({
          params: embedOverrides(FRAME_DEFAULTS),
          backdrop,
          device,
        });
      }
    }
  });

  it("reads malformed preview values as defaults", () => {
    expect(readConfiguratorSearch("?bg=neon&bgColor=xyz&device=watch")).toEqual({
      params: {},
      backdrop: DEFAULT_BACKDROP,
      device: PREVIEW_DEVICES[0],
    });
  });
});
