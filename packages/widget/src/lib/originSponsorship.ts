import type { Config, Connector } from "wagmi";
import { getCode, readContract } from "viem/actions";
import { getAccount } from "wagmi/actions";
import {
  encodeFunctionData,
  erc20Abi,
  isHash,
  parseAbi,
  parseSignature,
  recoverAddress,
  serializeSignature,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { SIMPLE_ACCOUNT_FACTORY } from "@xochi/client";
import {
  computeUserOpHash,
  ENTRYPOINT_V08_ADDRESS,
  PERMIT2_ADDRESS,
  type UserOperationV08,
} from "@xochi/signer";
import { ORIGIN_SPONSORSHIP } from "../config.js";
import { apiFetch } from "./api.js";
import { requestWalletSession } from "./walletSession.js";

const endpoint = "/api/origin-sponsorship";
const factory = SIMPLE_ACCOUNT_FACTORY as Address;
export const SIMPLE_7702_DELEGATE = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";
const factoryAbi = parseAbi([
  "function createAccount(address owner, uint256 salt) returns (address)",
  "function getAddress(address owner, uint256 salt) view returns (address)",
]);
const accountAbi = parseAbi(["function execute(address dest, uint256 value, bytes func)"]);

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
    connector: Connector;
    sender: Address;
    chainId: number;
    action: OriginSponsorshipAction["action"];
  }): SponsoredOriginAccount | null;
}

function sameHex(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

export function resolveOriginSponsorship(
  config: Config,
  context: Parameters<OriginSponsorshipAdapter["resolve"]>[0],
  isCurrent: () => boolean,
) {
  const account = ORIGIN_SPONSORSHIP?.resolve(context);
  if (!account) return null;
  const { profile, owner, salt, paymaster } = account;
  const signMessage = account.signMessage.bind(account);
  const { sender, chainId, connector } = context;
  const scope = { chain_id: chainId };
  const assertCurrent = () => {
    const current = getAccount(config);
    if (
      !isCurrent() ||
      !sameHex(current.address, sender) ||
      current.chainId !== chainId ||
      current.connector?.uid !== connector.uid
    )
      throw new Error("Wallet changed during sponsored operation");
  };

  async function post<T>(route: string, body: object, bearer: string): Promise<T> {
    const result = await apiFetch<T>(`${endpoint}/${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bearer}` },
      redirect: "error",
      body,
    });
    if (!result.success) throw new Error("Origin sponsorship request failed");
    return result.data;
  }

  // Keep the owner's credential separate from the connected SimpleAccount's session.
  let bearer: string | undefined;
  async function authenticate(): Promise<string> {
    assertCurrent();
    if (!bearer) {
      const session = await requestWalletSession(
        owner,
        ({ message }) => signMessage(message),
        assertCurrent,
      );
      bearer = session.token;
    }
    return bearer;
  }

  async function status(hash: Hex) {
    const receipt = await post<{ status: string; transaction_hash?: Hex }>(
      "status",
      { ...scope, user_op_hash: hash },
      await authenticate(),
    );
    if (receipt.status === "pending") return null;
    if (
      (receipt.status !== "succeeded" && receipt.status !== "reverted") ||
      typeof receipt.transaction_hash !== "string" ||
      !isHash(receipt.transaction_hash)
    )
      throw new Error("Invalid origin sponsorship receipt");
    return { hash: receipt.transaction_hash, success: receipt.status === "succeeded" };
  }

  return {
    supportsApproval: profile === "simple_7702",
    status,
    async wait(hash: Hex) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const receipt = await status(hash);
        if (receipt || Date.now() + 3_000 >= deadline) return receipt;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    },
    async submit(action: OriginSponsorshipAction, checkpoint: (hash: Hex) => void) {
      assertCurrent();
      const delegated = profile === "simple_7702";
      if (!delegated && action.action !== "send") throw new Error("Account cannot sign Permit2");
      const capability = await apiFetch<{
        chain_ids: number[];
        approve_permit2_chain_ids: number[];
      }>(`${endpoint}/capabilities`, { cache: "no-store", redirect: "error" });
      const chains =
        capability.success &&
        (delegated ? capability.data.approve_permit2_chain_ids : capability.data.chain_ids);
      if (!Array.isArray(chains) || !chains.includes(chainId)) {
        throw new Error("Origin sponsorship unavailable on this chain");
      }

      const client = config.getClient({ chainId });
      if (delegated) {
        const code = await getCode(client, { address: sender });
        if (
          salt !== 0n ||
          !sameHex(sender, owner) ||
          !sameHex(code, `0xef0100${SIMPLE_7702_DELEGATE.slice(2)}`)
        ) {
          throw new Error("Invalid Simple7702Account delegation");
        }
      } else {
        // Bind the sender to the pinned factory on the connected chain before signing.
        const derived = await readContract(client, {
          address: factory,
          abi: factoryAbi,
          functionName: "getAddress",
          args: [owner, salt],
        });
        if (!sameHex(derived, sender)) throw new Error("Invalid SimpleAccount binding");
      }
      const authorization = await authenticate();
      assertCurrent();
      const prepared = await post<{
        user_operation: UserOperationV08;
        user_op_hash: Hex;
        entry_point: Address;
      }>(
        "prepare",
        {
          ...scope,
          action: action.action,
          sender,
          owner,
          salt: salt.toString(),
          token: action.token,
          amount: action.amount.toString(),
          ...(action.action === "send"
            ? { recipient: action.recipient }
            : { quote_id: action.quoteId }),
        },
        authorization,
      );
      const op = prepared.user_operation;
      const inner =
        action.action === "send"
          ? encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [action.recipient, action.amount],
            })
          : encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [PERMIT2_ADDRESS, action.amount],
            });
      const call = encodeFunctionData({
        abi: accountAbi,
        functionName: "execute",
        args: [action.token, 0n, inner],
      });
      const deployment = encodeFunctionData({
        abi: factoryAbi,
        functionName: "createAccount",
        args: [owner, salt],
      });
      const hasFactory = op.factory != null;
      if (
        !sameHex(prepared.entry_point, ENTRYPOINT_V08_ADDRESS) ||
        !sameHex(op.sender, sender) ||
        !sameHex(op.paymaster, paymaster) ||
        sameHex(paymaster, zeroAddress) ||
        !sameHex(op.callData, call) ||
        (hasFactory
          ? delegated || !sameHex(op.factory, factory) || !sameHex(op.factoryData, deployment)
          : op.factoryData != null && op.factoryData !== "0x") ||
        !isHash(prepared.user_op_hash) ||
        !sameHex(computeUserOpHash(op, ENTRYPOINT_V08_ADDRESS, chainId), prepared.user_op_hash)
      )
        throw new Error("Invalid sponsored UserOperation");
      assertCurrent();
      const hash = prepared.user_op_hash;
      const signature = serializeSignature(
        parseSignature(await account.signOperation(action, hash)),
      );
      if (!sameHex(await recoverAddress({ hash, signature }), owner)) {
        throw new Error("Invalid owner signature");
      }
      assertCurrent();
      checkpoint(hash);
      // Once checkpointed, a lost response is resolved by status for this hash.
      // The caller never sends a fallback transaction or re-prepares the operation.
      const result = await post<{ user_op_hash: Hex }>(
        "submit",
        { ...scope, user_op_hash: hash, signature },
        authorization,
      );
      if (!sameHex(result.user_op_hash, hash)) throw new Error("Invalid submitted UserOperation");
      return hash;
    },
  };
}
