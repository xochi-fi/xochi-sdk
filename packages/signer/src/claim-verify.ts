/**
 * Verification of a served stealth-claim UserOperation against what the client
 * independently knows. Network-free: the Xochi Worker forwards `userOperation` /
 * `entryPoint` / `userOpHash` / `chainId` from Riddler verbatim.
 */

import {
  computeUserOpHash,
  decodeErc20TransferExecute,
  ENTRYPOINT_V08_ADDRESS,
  UserOperationError,
  type UserOperationV08,
} from "./erc4337";
import { sameAddressish, sameNumeric } from "./compare";

export class XochiClaimMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XochiClaimMismatchError";
  }
}

/** The `/xochi/claim/prepare` response, as of axol-io/Riddler#851. */
export interface PreparedClaim {
  userOpHash?: string;
  chainId?: number | string;
  stealthAddress?: string;
  counterfactualAddress?: string;
  /** Added by Riddler#851. Absent on a deployment that predates it. */
  entryPoint?: string;
  /** Added by Riddler#851. The SPONSORED op: the one the hash was computed over. */
  userOperation?: UserOperationV08;
  [key: string]: unknown;
}

/** What the client independently knows a claim should do, from its own request + `/xochi/status`. */
export interface ClaimExpectation {
  /** The `--recipient` the caller asked to sweep to. */
  recipient: string;
  /** `status.counterfactualAddress`, the account holding the settled funds. */
  counterfactualAddress: string;
  /**
   * `status.settlementChainId`, the chain the settlement landed on. Absence is a verification
   * GAP, not a check that quietly does not apply: the counterfactual address is identical on
   * every EVM chain, so an op bound to the wrong one sweeps a different balance. Riddler
   * always populates it (`Xochi.Adapter`), so a settled intent lacking it is anomalous.
   */
  settlementChainId?: number | string | null;
  expectedToken?: string | null;
  expectedAmount?: string | number | bigint | null;
  /**
   * Turn every gap into a refusal instead of a `{verified: false}` report. Opt-in for
   * step 2; the default once #851 is deployed everywhere.
   */
  requireVerified?: boolean;
}

export interface ClaimVerification {
  /**
   * True only when the served op was recomputed to the served hash AND every check ran and
   * passed, including the chain binding. A check that could not run leaves this false; it
   * does not mean "nothing looked wrong". The staged rollout reads this to decide when
   * refusing outright is safe.
   */
  verified: boolean;
  /** Why verification was skipped. Set only when `verified` is false. */
  reason?: string;
  /** What the op actually moves, once decoded. Surfaced so a caller can see what it authorised. */
  token?: string;
  amount?: string;
}

/**
 * Asserts the UserOp `/xochi/claim/prepare` wants signed is the claim that was asked
 * for. Recovering the signature to the derived stealth signer is not an authorization
 * check: it proves the signature matches the key, which is true of any 32 bytes, and at
 * the moment `prepare` is called the counterfactual account holds the settled funds.
 *
 * axol-io/Riddler#851 makes the op inspectable, and the checks run in dependency order.
 * Recomputing the hash from `userOperation` + `entryPoint` + `chainId` is load-bearing:
 * until the struct is known to be the digest's preimage, reading fields off it says
 * nothing. Then `sender` must be the counterfactual account from `/xochi/status`, and
 * `callData` must be `execute(token, 0, transfer(recipient, amount))` with the requested
 * recipient, the field that decides where the money goes. Token and amount are compared
 * only when the caller supplied them, `/xochi/status` carrying neither.
 *
 * Absent fields warn rather than refuse, because a server predating Riddler#851 serves
 * no `userOperation` and hard-failing breaks every client pointed at one: this returns
 * `{verified: false, reason}` and the caller warns, while `requireVerified` (CLI:
 * `--require-verified-userop`) turns every gap into a throw. So it does NOT close the gap
 * alone, a malicious server can omit the field too; it makes the hard requirement safe
 * once #851 is everywhere, at which point absence becomes a refusal (staged rollout,
 * axol-io/riddler-sdk#86 step 3).
 */
export function assertPreparedClaimMatchesRequest(
  prepared: PreparedClaim,
  expected: ClaimExpectation,
): ClaimVerification {
  // A gap is something this function could not check, not something it checked and refused.
  // `requireVerified` decides whether a gap is fatal here or reported for the caller to warn
  // about.
  const gap = (reason: string): ClaimVerification => {
    if (expected.requireVerified) {
      throw new XochiClaimMismatchError(`${reason} Refusing to sign (--require-verified-userop).`);
    }
    return { verified: false, reason };
  };

  if (!prepared.userOperation || !prepared.entryPoint) {
    const missing = [
      prepared.userOperation ? null : "userOperation",
      prepared.entryPoint ? null : "entryPoint",
    ]
      .filter(Boolean)
      .join(" and ");
    return gap(
      `claim/prepare served no ${missing}, so the userOpHash cannot be recomputed and this signs a ` +
        "digest that cannot be inspected. Expected from a server predating axol-io/Riddler#851; " +
        "a server that HAS it and omits it anyway looks exactly the same from here.",
    );
  }

  // Pinned, not echoed: the EntryPoint is the EIP-712 verifyingContract for the op, so
  // an attacker-chosen one recomputes cleanly against its own served hash.
  if (String(prepared.entryPoint).toLowerCase() !== ENTRYPOINT_V08_ADDRESS.toLowerCase()) {
    throw new XochiClaimMismatchError(
      `claim/prepare names EntryPoint ${JSON.stringify(prepared.entryPoint)}, but ERC-4337 v0.8 is ` +
        `${ENTRYPOINT_V08_ADDRESS} on every EVM chain -- recomputing the hash against the served ` +
        "address would just agree with whatever was sent. Refusing to sign.",
    );
  }

  if (prepared.chainId === undefined || prepared.chainId === null) {
    throw new XochiClaimMismatchError(
      "claim/prepare served a userOperation but no chainId -- the chain is part of the hash preimage, " +
        "so without it the digest cannot be reproduced. Refusing to sign.",
    );
  }

  let recomputed: string;
  try {
    recomputed = computeUserOpHash(
      prepared.userOperation,
      String(prepared.entryPoint),
      prepared.chainId,
    );
  } catch (e) {
    if (e instanceof UserOperationError) {
      throw new XochiClaimMismatchError(e.message);
    }
    throw e;
  }

  if (recomputed.toLowerCase() !== String(prepared.userOpHash).toLowerCase()) {
    throw new XochiClaimMismatchError(
      `claim/prepare asks for a signature over ${prepared.userOpHash}, but the UserOperation it served ` +
        `hashes to ${recomputed} -- the digest is not this op's. Whatever it IS the hash of is not ` +
        "something this client can see. Refusing to sign.",
    );
  }

  const op = prepared.userOperation;

  if (!sameAddressish(String(op.sender ?? ""), expected.counterfactualAddress)) {
    throw new XochiClaimMismatchError(
      `the UserOperation spends from ${JSON.stringify(op.sender)} but this intent settled to ` +
        `${expected.counterfactualAddress} -- refusing to sign an operation against a different account.`,
    );
  }

  // A stealth settle records the settlement chain (== the intent's to_chain_id), and the
  // account address is identical on every EVM chain, so an op bound to the wrong chain is a
  // claim against a different balance at the same address. No settlement chain is a GAP, not
  // an inapplicable check: reporting `verified` for an op whose chain was never bound would
  // let a hostile server delete this check by omitting one status field. Same warn-or-refuse
  // path as an absent userOperation, never a silent pass.
  if (expected.settlementChainId === undefined || expected.settlementChainId === null) {
    return gap(
      "/xochi/status carried no settlementChainId, so the UserOperation's chain cannot be bound to " +
        "the chain the settlement landed on. The counterfactual account has the same address on every " +
        "EVM chain, so an op built for another chain would sweep a different balance. Riddler always " +
        "populates this field, so its absence is anomalous rather than merely an old deployment.",
    );
  }

  if (!sameNumeric(prepared.chainId, expected.settlementChainId)) {
    throw new XochiClaimMismatchError(
      `claim/prepare built the UserOperation for chain ${prepared.chainId} but the settlement landed ` +
        `on chain ${expected.settlementChainId} -- the counterfactual address is the same on every ` +
        "EVM chain, so this would sweep a different balance. Refusing to sign.",
    );
  }

  let transfer: ReturnType<typeof decodeErc20TransferExecute>;
  try {
    transfer = decodeErc20TransferExecute(op.callData);
  } catch (e) {
    if (e instanceof UserOperationError) {
      throw new XochiClaimMismatchError(e.message);
    }
    throw e;
  }

  if (!sameAddressish(transfer.to, expected.recipient)) {
    throw new XochiClaimMismatchError(
      `the UserOperation transfers to ${transfer.to} but ${expected.recipient} was requested -- ` +
        "this is the field that decides where the settled funds land. Refusing to sign.",
    );
  }

  if (transfer.value !== 0n) {
    throw new XochiClaimMismatchError(
      `the UserOperation also sends ${transfer.value} wei of the account's native balance alongside the ` +
        "token transfer -- a stealth claim carries no value. Refusing to sign.",
    );
  }

  // Pinning `value` to zero bounds what the CALL spends, not what the op spends on GAS.
  // Without a paymaster the account pays its own prefund from unbounded server-chosen gas
  // fields, so an unsponsored op with maxed fees drains the account's native balance while
  // still delivering the token correctly. A claim is always sponsored, so requiring it costs
  // nothing honest.
  if (op.paymaster === undefined || op.paymaster === null) {
    throw new XochiClaimMismatchError(
      "the UserOperation names no paymaster, so the counterfactual account would pay its own gas at " +
        `maxFeePerGas=${JSON.stringify(op.maxFeePerGas)} -- a stealth claim is always sponsored, and an ` +
        "unsponsored one can drain the account's native balance as gas regardless of the token transfer " +
        "being correct. Refusing to sign.",
    );
  }

  if (expected.expectedToken) {
    if (!sameAddressish(transfer.token, String(expected.expectedToken))) {
      throw new XochiClaimMismatchError(
        `the UserOperation sweeps token ${transfer.token} but ${expected.expectedToken} was expected -- ` +
          "refusing to sign.",
      );
    }
  }

  if (expected.expectedAmount !== undefined && expected.expectedAmount !== null) {
    if (!sameNumeric(transfer.amount, expected.expectedAmount)) {
      throw new XochiClaimMismatchError(
        `the UserOperation sweeps ${transfer.amount} base units but ${expected.expectedAmount} was ` +
          "expected -- refusing to sign.",
      );
    }
  }

  return { verified: true, token: transfer.token, amount: String(transfer.amount) };
}
