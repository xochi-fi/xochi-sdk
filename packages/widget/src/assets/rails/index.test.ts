import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import * as icons from "simple-icons";
import { railLogo } from "./index";

const slugs = {
  alipay: "siAlipay",
  cashapp: "siCashapp",
  mercadopago: "siMercadopago",
  monzo: "siMonzo",
  n26: "siN26",
  paypal: "siPaypal",
  revolut: "siRevolut",
  venmo: "siVenmo",
  wise: "siWise",
  xmoney: "siX",
  zelle: "siZelle",
} as const;

describe("railLogo", () => {
  it.each(Object.entries(slugs))("uses the pinned Simple Icons SVG for %s", (id, exportName) => {
    const icon = icons[exportName];
    const logo = railLogo(id)!;
    expect(logo).toMatchObject({ width: 24, height: 24, brandColor: `#${icon.hex}` });
    const filename = basename(logo.light.split("?")[0]);
    expect(filename).toBe(`${id}.svg`);
    expect(readFileSync(new URL(filename, import.meta.url), "utf8").trim()).toBe(icon.svg);
  });

  it.each(["chime", "upi", "monobank", "unknown", "constructor", "__proto__"])(
    "returns undefined for %s",
    (id) => expect(railLogo(id)).toBeUndefined(),
  );
});
