import ethereumSvg from "./ethereum.svg?no-inline";
import arbitrumSvg from "./arbitrum.svg?no-inline";
import optimismSvg from "./optimism.svg?no-inline";
import polygonSvg from "./polygon.svg?no-inline";
import baseSvg from "./base.svg?no-inline";
import robinhoodSvg from "./robinhood.svg?no-inline";
import arcSvg from "./arc.svg?no-inline";
import gnosisPng from "./gnosis.png?no-inline";
import xochiSvg from "./xochi.svg?no-inline";
import aztecSvg from "./aztec.svg?no-inline";
import tronSvg from "./tron.svg?no-inline";

import type { ExtendedChainId } from "../../types/intent.js";
import { CANTON_MAINNET_CHAIN_ID, TRON_CHAIN_ID } from "@xochi/client";

/**
 * Canton has no artwork cleared for redistribution here (licenses/assets.json),
 * so its chain icon is a plain monogram drawn inline, not Canton's logo.
 */
const CANTON_MONOGRAM =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23444'/%3E%3Cpath d='M21 11a7 7 0 1 0 0 10' fill='none' stroke='%23fff' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";

export const CHAIN_ICONS: Record<ExtendedChainId, string> = {
  1: ethereumSvg,
  10: optimismSvg,
  137: polygonSvg,
  42161: arbitrumSvg,
  8453: baseSvg,
  4663: robinhoodSvg,
  5042: arcSvg,
  100: gnosisPng,
  0: xochiSvg,
  [TRON_CHAIN_ID]: tronSvg,
  [CANTON_MAINNET_CHAIN_ID]: CANTON_MONOGRAM,
};

export const AZTEC_ICON = aztecSvg;
