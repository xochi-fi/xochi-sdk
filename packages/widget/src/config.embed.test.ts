import { expect, it } from "vitest";
import { readWidgetEmbedConfig } from "./config.js";

it("exposes parsed IA and ramp restrictions without using the trade amount", () => {
  expect(
    readWidgetEmbedConfig(
      "initialTab=send&tabs=trade,send&initialMode=onramp&modes=onramp&sendDestinations=payment_app&fiatCurrency=EUR&rampProviders=peer&amount=50",
    ),
  ).toEqual({
    initialTab: "send",
    tabs: ["trade", "send"],
    initialMode: "onramp",
    modes: ["onramp"],
    sendDestinations: ["payment_app"],
    fiatCurrency: "EUR",
    rampProviders: ["peer"],
  });
});

it("drops defaults excluded by host restrictions and preserves empty restrictions", () => {
  expect(
    readWidgetEmbedConfig(
      "initialTab=send&tabs=trade&initialMode=onramp&modes=swap&sendDestinations=unknown&rampProviders=unknown",
    ),
  ).toEqual({
    tabs: ["trade"],
    modes: ["swap"],
    sendDestinations: [],
    rampProviders: [],
  });
  expect(readWidgetEmbedConfig("")).toEqual({});
});
