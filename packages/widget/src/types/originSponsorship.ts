import type { Address, Hex } from "viem";

export type OriginSponsorshipAction =
  | { action: "send"; token: Address; amount: bigint; recipient: Address }
  | { action: "approve_permit2"; token: Address; amount: bigint; quoteId: string };

export interface SponsoredOriginAccount {
  profile: "simple_account" | "simple_7702";
  owner: Address;
  /** Use zero for the predelegated account profile. */
  salt: bigint;
  /** The trusted verifying paymaster on this chain, configured independently of the venue. */
  paymaster: Address;
  /** Prompt the owner for the venue's SIWE challenge. */
  signMessage(message: string): Promise<Hex>;
  /** Prompt the owner to authorize the verified operation and sign its raw v0.8 hash. */
  signOperation(action: OriginSponsorshipAction, hash: Hex): Promise<Hex>;
}

export interface OriginSponsorshipAdapter {
  /** Return an account only for the connector, sender, chain and action this integration owns. */
  resolve(context: {
    connector: { readonly id: string; readonly uid: string; readonly type: string };
    sender: Address;
    chainId: number;
    action: OriginSponsorshipAction["action"];
  }): SponsoredOriginAccount | null;
}
