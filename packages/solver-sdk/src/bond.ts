// SolverBond (Base): the stake a solver is admitted on. `OnchainEscrowGateway`
// reads and sends through these; escrow-gateway.ts re-exports the public names.

import { ethers } from "ethers";

import { EscrowRefusalError } from "./escrow-verify";
import { providerOf } from "./tx-sender";

export const SOLVER_BOND_ABI = [
  "function token() view returns (address)",
  "function minBond() view returns (uint256)",
  "function unbondingPeriod() view returns (uint256)",
  "function accounts(address solver) view returns (uint256 bonded, uint256 unbonding, uint256 pending, uint64 unbondingReadyAt)",
  "function activeBond(address solver) view returns (uint256)",
  "function isEligible(address solver) view returns (bool)",
  "function deposit(uint256 amount)",
  "function requestWithdrawal(uint256 amount)",
  "function cancelWithdrawal()",
  "function completeWithdrawal() returns (uint256)",
  "function completeWithdrawalTo(address to) returns (uint256)",
  "error ZeroAmount()",
  "error ZeroAddress()",
  "error InsufficientBond(uint256 requested, uint256 bonded)",
  "error NothingToWithdraw()",
  "error StillUnbonding(uint64 readyAt)",
  "error ShortReceipt(uint256 expected, uint256 received)",
] as const;

export interface BondConfig {
  signer: ethers.Signer; // the bonded solver, connected to Base
  address: string; // SolverBond
}

export interface BondStatus {
  token: string;
  minBond: bigint;
  unbondingPeriod: bigint;
  bonded: bigint;
  unbonding: bigint;
  pending: bigint;
  unbondingReadyAt: bigint;
  activeBond: bigint;
  eligible: boolean;
}

// The SolverBond this solver is bonded on: its address and the chain its
// signer is connected to. Required to accept, and so to fill.
export async function trustedBond(
  cfg: BondConfig | undefined,
  orderId: string,
): Promise<{ chainId: bigint; address: string }> {
  if (!cfg)
    throw new EscrowRefusalError(
      "bond_mismatch",
      "no SolverBond configured; an award cannot be accepted",
      orderId,
    );
  const { chainId } = await providerOf(cfg.signer).getNetwork();
  return { chainId, address: cfg.address };
}

export async function bondContract(cfg: BondConfig | undefined): Promise<{
  bond: ethers.Contract;
  signer: ethers.Signer;
  self: string;
}> {
  if (!cfg) throw new Error("escrow gateway: no SolverBond configured");
  return {
    bond: new ethers.Contract(cfg.address, SOLVER_BOND_ABI, providerOf(cfg.signer)),
    signer: cfg.signer,
    self: await cfg.signer.getAddress(),
  };
}

export async function readBondStatus(cfg: BondConfig | undefined): Promise<BondStatus> {
  const { bond, self } = await bondContract(cfg);
  const [token, minBond, unbondingPeriod, account, activeBond, eligible] = await Promise.all([
    bond.getFunction("token")(),
    bond.getFunction("minBond")(),
    bond.getFunction("unbondingPeriod")(),
    bond.getFunction("accounts")(self),
    bond.getFunction("activeBond")(self),
    bond.getFunction("isEligible")(self),
  ]);
  return {
    token,
    minBond,
    unbondingPeriod,
    bonded: account.bonded,
    unbonding: account.unbonding,
    pending: account.pending,
    unbondingReadyAt: account.unbondingReadyAt,
    activeBond,
    eligible,
  };
}
