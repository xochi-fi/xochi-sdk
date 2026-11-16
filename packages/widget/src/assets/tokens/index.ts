import ethSvg from "./eth.svg?no-inline";
import usdcPng from "./usdc.png?no-inline";
import usdtPng from "./usdt.png?no-inline";
import usdgPng from "./usdg.png?no-inline";
import wbtcPng from "./wbtc.png?no-inline";
import wstethPng from "./wsteth.png?no-inline";
import daiPng from "./dai.png?no-inline";
import polSvg from "./pol.svg?no-inline";
import arbSvg from "./arb.svg?no-inline";
import opPng from "./op.png?no-inline";
import raxolPng from "./raxol.png?no-inline";
import eurePng from "./eure.png?no-inline";
import zchfPng from "./zchf.png?no-inline";

export const TOKEN_ICONS: Record<string, string> = {
  ETH: ethSvg,
  WETH: ethSvg,
  wstETH: wstethPng,
  USDC: usdcPng,
  USDC_E: usdcPng,
  USDT: usdtPng,
  USDG: usdgPng,
  RAXOL: raxolPng,
  WBTC: wbtcPng,
  DAI: daiPng,
  POL: polSvg,
  ARB: arbSvg,
  OP: opPng,
  cbETH: ethSvg,
  EURe: eurePng,
  ZCHF: zchfPng,
};
