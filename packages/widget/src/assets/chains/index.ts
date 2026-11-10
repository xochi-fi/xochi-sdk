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
import { TRON_CHAIN_ID } from "@xochi/client";

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
};

export const AZTEC_ICON = aztecSvg;
