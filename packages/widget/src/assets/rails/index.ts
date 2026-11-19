import alipayIcon from "./alipay.svg?no-inline";
import cashappIcon from "./cashapp.svg?no-inline";
import mercadopagoIcon from "./mercadopago.svg?no-inline";
import monzoIcon from "./monzo.svg?no-inline";
import n26Icon from "./n26.svg?no-inline";
import paypalIcon from "./paypal.svg?no-inline";
import revolutIcon from "./revolut.svg?no-inline";
import venmoIcon from "./venmo.svg?no-inline";
import wiseIcon from "./wise.svg?no-inline";
import xmoneyIcon from "./xmoney.svg?no-inline";
import zelleIcon from "./zelle.svg?no-inline";
import monzo from "./monzo.png?no-inline";
import monzoDark from "./monzo-dark.png?no-inline";
import revolut from "./revolut.png?no-inline";
import revolutDark from "./revolut-dark.png?no-inline";
import wise from "./wise.png?no-inline";
import wiseDark from "./wise-dark.png?no-inline";

export interface RailLogo {
  readonly light: string;
  readonly dark?: string;
  readonly brandColor?: string;
  /** Aspect ratio of the light image canvas. Dark variants can use different canvas sizes. */
  readonly width: number;
  readonly height: number;
  /** Minimum distance from the artwork to adjacent content, in units of the light canvas height. */
  readonly clearSpaceRatio: number;
}

function vector(light: string, brandColor: string): RailLogo {
  return { light, brandColor, width: 24, height: 24, clearSpaceRatio: 0 };
}

const officialLogos: Readonly<Record<string, RailLogo>> = {
  monzo: { light: monzo, dark: monzoDark, width: 2414, height: 808, clearSpaceRatio: 0.59 },
  revolut: { light: revolut, dark: revolutDark, width: 3623, height: 800, clearSpaceRatio: 1.1 },
  wise: { light: wise, dark: wiseDark, width: 250, height: 250, clearSpaceRatio: 0.115 },
};

const brandLogos: Readonly<Record<string, RailLogo>> = {
  alipay: vector(alipayIcon, "#1677FF"),
  cashapp: vector(cashappIcon, "#00C244"),
  mercadopago: vector(mercadopagoIcon, "#00B1EA"),
  monzo: vector(monzoIcon, "#14233C"),
  n26: vector(n26Icon, "#48AC98"),
  paypal: vector(paypalIcon, "#002991"),
  revolut: vector(revolutIcon, "#191C1F"),
  venmo: vector(venmoIcon, "#008CFF"),
  wise: vector(wiseIcon, "#9FE870"),
  xmoney: vector(xmoneyIcon, "#000000"),
  zelle: vector(zelleIcon, "#6D1ED4"),
};

const logos = { ...officialLogos, ...brandLogos };

export function railLogo(railId: string): RailLogo | undefined {
  return Object.hasOwn(logos, railId) ? logos[railId] : undefined;
}

function luminance(hex: string): number {
  const rgb = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}

export function selectedRailIcon(brand: string | undefined, background: string): string {
  if (!brand) return "currentColor";
  const foreground = luminance(brand) + 0.05;
  const surface = luminance(background) + 0.05;
  return Math.max(foreground, surface) / Math.min(foreground, surface) >= 3
    ? brand
    : "currentColor";
}
