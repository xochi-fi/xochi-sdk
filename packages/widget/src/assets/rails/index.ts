import monzo from "./monzo.png?no-inline";
import monzoDark from "./monzo-dark.png?no-inline";
import revolut from "./revolut.png?no-inline";
import revolutDark from "./revolut-dark.png?no-inline";
import wise from "./wise.png?no-inline";
import wiseDark from "./wise-dark.png?no-inline";

export interface RailLogo {
  readonly light: string;
  readonly dark?: string;
  /** Aspect ratio of the light image canvas. Dark variants can use different canvas sizes. */
  readonly width: number;
  readonly height: number;
  /** Minimum distance from the artwork to adjacent content, in units of the light canvas height. */
  readonly clearSpaceRatio: number;
}

const logos: Readonly<Record<string, RailLogo>> = {
  monzo: { light: monzo, dark: monzoDark, width: 2414, height: 808, clearSpaceRatio: 0.59 },
  revolut: { light: revolut, dark: revolutDark, width: 3623, height: 800, clearSpaceRatio: 1.1 },
  wise: { light: wise, dark: wiseDark, width: 250, height: 250, clearSpaceRatio: 0.115 },
};

export function railLogo(railId: string): RailLogo | undefined {
  return Object.hasOwn(logos, railId) ? logos[railId] : undefined;
}
