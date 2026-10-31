/**
 * Fail-closed pin for origin-pull authorizations: binds both WHERE the funds go
 * and HOW MUCH, before the wallet signs.
 *
 * Two axes can move funds on the origin leg. The recipient (pull `to` for
 * ERC-3009, `spender` for Permit2) decides who collects. The amount (`value` for
 * ERC-3009, `permitted.amount` for Permit2) decides how much. The user's
 * signature is the on-chain authority for both (ERC-3009 moves exactly `value`,
 * Permit2 caps the pull at `permitted.amount`), so a pull whose amount exceeds
 * the intended input can overdraw the wallet even to a correctly-pinned
 * recipient. This pin binds the recipient to an operator allowlist AND the amount
 * to the intended input, refusing to sign on either mismatch. The trust anchors
 * are the client's own config and the user's own quoted amount, neither of which
 * the quote server can influence.
 *
 * Defense in depth: the Xochi worker independently refuses to serve a quote whose
 * pull amount does not equal `from_amount` (packages/worker-lib), and the
 * on-chain token / Permit2 contract verifies the signature over the amount
 * actually pulled. So a compromised quote server cannot overdraw even if this
 * client check is bypassed.
 *
 * Permit2 has no on-chain recipient guard (the spender chooses the recipient at
 * call time), so its recipient is ALWAYS fail-closed: an unpinned permit2 pull is
 * rejected. ERC-3009 binds `to` in the signed digest and the token enforces
 * `msg.sender == to`, so an unpinned `to` stays bounded (accepted unless a hard
 * pin is requested). Once an allowlist is configured, both methods enforce it.
 *
 * A Permit2 pull's domain must also name the canonical Permit2 contract (SPEC
 * §2.3): the machine runs this pin before asking the integrator for the one-time
 * approval, so a pull aimed at any other contract never gets that far.
 *
 * Mirrors the raxol agent-side pin (`solver_allowed?/2`). See GitHub #333
 * (recipient pin) and the #170 origin-leg amount binding.
 */

import { PERMIT2_ADDRESS, sameAddressish } from "@xochi/signer";
import type { Eip712TypedData } from "../shared/index.js";
import { extractPullAmount } from "../shared/index.js";

export interface SolverPinConfig {
  /**
   * Lowercased addresses valid as an ERC-3009 pull `to` (the solver collection
   * EOA, or the verified per-chain XochiPull USDC contract once #591 flips). This
   * class NEVER accepts a Permit2 spender: the two roles are distinct addresses
   * with distinct on-chain authority, so mixing them would let one impersonate the
   * other.
   */
  erc3009Allowlist: string[];
  /**
   * Lowercased addresses valid as a Permit2 `spender` (the verified
   * XochiPullPermit2 contract, #591 sibling / PULL2). Distinct from the ERC-3009
   * class above so a solver EOA can never stand in as the Permit2 spender.
   */
  permit2Allowlist: string[];
  /** When true, ERC-3009 also requires a pin (Permit2 always does). */
  requirePin: boolean;
}

export type SolverPinField =
  | "pull_to"
  | "pull_spender"
  | "pull_type"
  | "pull_domain"
  | "pull_amount"
  | "payout_amount"
  | "payout_recipient";

export type SolverPinResult = { ok: true } | { ok: false; field: SolverPinField; reason: string };

/** What the client rendered, and therefore what the user agreed to receive. */
export interface PayoutPinExpectation {
  /** Destination-token smallest units: the `toAmount` shown in the panel. */
  toAmount: string;
  /**
   * Who the panel said would be paid: the connected wallet on a same-VM route,
   * or the user-entered destination address on a non-EVM one.
   *
   * Typed as possibly-undefined on purpose. The caller's wallet address is
   * `string | undefined`, and the honest handling of "we do not know who this
   * was for" is to refuse, not to assert it away with a cast. Casting also loses
   * to the pre-commit `eslint --fix`, which strips assertions it deems
   * unnecessary.
   */
  recipient: string | undefined;
}

const ERC3009_TYPE = "ReceiveWithAuthorization";
const PERMIT2_TYPE = "PermitWitnessTransferFrom";

/**
 * Validate a served origin-pull authorization against the solver pin. Returns
 * `{ ok: true }` when the wallet may sign, or `{ ok: false, field, reason }` to
 * abort before signing.
 *
 * `expectedAmount` is the intended input amount (origin-token smallest units, the
 * user's own quoted `from_amount`). The pull is rejected unless its collected
 * amount equals it, so a served pull cannot overdraw beyond what the user meant
 * to spend even when the recipient is correctly pinned.
 */
export function validateSolverPin(
  pull: Eip712TypedData,
  config: SolverPinConfig,
  expectedAmount: bigint,
): SolverPinResult {
  // message values are `unknown` off the wire; checkRecipient guards the field.
  const message = pull.message;

  let recipient: SolverPinResult;
  switch (pull.primaryType) {
    case ERC3009_TYPE:
      recipient = checkRecipient("pull_to", message.to, "erc3009", config.erc3009Allowlist, config);
      break;
    case PERMIT2_TYPE:
      // Refused before the approval is requested (SPEC §2.3: Permit2 is one
      // universal address), so no allowance is granted for any other contract.
      if (!sameAddressish(String(pull.domain?.verifyingContract ?? ""), PERMIT2_ADDRESS)) {
        return {
          ok: false,
          field: "pull_domain",
          reason: `Permit2 pull domain names ${String(pull.domain?.verifyingContract)}, not the canonical Permit2 ${PERMIT2_ADDRESS}`,
        };
      }
      recipient = checkRecipient(
        "pull_spender",
        message.spender,
        "permit2",
        config.permit2Allowlist,
        config,
      );
      break;
    default:
      return {
        ok: false,
        field: "pull_type",
        reason: `unsupported origin-pull authorization type: ${pull.primaryType}`,
      };
  }
  if (!recipient.ok) return recipient;

  return checkAmount(pull, expectedAmount);
}

/**
 * Bind the DESTINATION leg of the intent payload to what the client rendered,
 * before the wallet signs it.
 *
 * `validateSolverPin` above protects the origin leg: how much leaves the wallet
 * and who collects it. This is the mirror for the other end -- how much comes
 * back and who receives it -- and it exists because those two fields are the only
 * ones a user cannot verify by reading a wallet prompt. A payload whose
 * `toAmount` is lower than the number on screen, or whose `recipient` is an
 * address the user never chose, produces a wallet prompt that looks entirely
 * normal.
 *
 * The trust anchor is the same as the origin pin's and that is the whole point:
 * the expectation comes from the client's own rendered quote, never from another
 * field of the same served response. The Xochi worker independently refuses to
 * serve a quote whose `eip712.message.toAmount` disagrees with the `to_amount` it
 * advertises (`servedPayoutMismatch`, packages/worker-lib), so against a healthy
 * backend this check never fires. It covers what that one structurally cannot:
 * anything that reaches the payload after the worker has vouched for it, or a
 * worker that is itself compromised. A firing check here is an incident, not a
 * tuning problem.
 *
 * Fail-closed on a missing or unreadable field: never sign a payout we cannot
 * read.
 */
export function validatePayoutPin(
  intent: Eip712TypedData,
  expected: PayoutPinExpectation,
): SolverPinResult {
  const message = intent.message;

  const servedAmount = message.toAmount;
  if (typeof servedAmount !== "string" && typeof servedAmount !== "number") {
    return {
      ok: false,
      field: "payout_amount",
      reason: "intent payout amount is missing or unparseable",
    };
  }
  if (!sameAmount(servedAmount, expected.toAmount)) {
    return {
      ok: false,
      field: "payout_amount",
      reason: `intent payout ${String(servedAmount)} does not match the quoted output ${expected.toAmount}`,
    };
  }

  // Fail closed rather than skip: not knowing the expected recipient is exactly
  // the case where signing blind is worst.
  if (!expected.recipient) {
    return {
      ok: false,
      field: "payout_recipient",
      reason: "no expected recipient to check the payout against",
    };
  }

  const servedRecipient = message.recipient;
  if (typeof servedRecipient !== "string" || servedRecipient === "") {
    return {
      ok: false,
      field: "payout_recipient",
      reason: "intent payout recipient is missing or unparseable",
    };
  }
  if (!sameRecipient(servedRecipient, expected.recipient)) {
    return {
      ok: false,
      field: "payout_recipient",
      reason: `intent payout recipient ${servedRecipient} is not the address this quote was for`,
    };
  }

  return { ok: true };
}

/**
 * Compare two smallest-unit amounts by value, not by spelling.
 *
 * A string compare would reject `"0998000"` or a numeric `998000` against
 * `"998000"` even though both mean the same payout, and this check fails closed:
 * a false negative blocks a legitimate swap at the wallet prompt. BigInt is also
 * required for correctness at scale, since an 18-decimal payout is past
 * `Number.MAX_SAFE_INTEGER`. Falls back to exact string equality only when a
 * value will not parse as an integer, so an unexpected format still has to match
 * verbatim rather than being waved through.
 */
function sameAmount(served: string | number, expected: string): boolean {
  try {
    return BigInt(served) === BigInt(expected);
  } catch {
    return String(served) === expected;
  }
}

/**
 * Compare two recipients per address family. An EVM (`0x`-hex) pair compares
 * case-insensitively; anything else (base58 Tron/Solana) is case-sensitive and
 * compares verbatim, because lowercasing a base58 address changes it. Mirrors
 * the worker-side rule and Riddler's own `token_value/1`.
 */
function sameRecipient(a: string, b: string): boolean {
  return a.startsWith("0x") && b.startsWith("0x") ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Bind the pull's collected amount to the intended input. Fail-closed: a
 * missing/unparseable amount is rejected (never sign an authorization whose value
 * we cannot read), as is any amount that does not match exactly. Riddler builds
 * the pull value straight from `from_amount` with no fee or buffer, so exact
 * equality is correct.
 */
function checkAmount(pull: Eip712TypedData, expectedAmount: bigint): SolverPinResult {
  const amount = extractPullAmount(pull);
  if (amount === null) {
    return {
      ok: false,
      field: "pull_amount",
      reason: "origin-pull amount is missing or unparseable",
    };
  }
  if (amount !== expectedAmount) {
    return {
      ok: false,
      field: "pull_amount",
      reason: `origin-pull amount ${amount.toString()} does not match the intended input ${expectedAmount.toString()}`,
    };
  }
  return { ok: true };
}

function checkRecipient(
  field: "pull_to" | "pull_spender",
  recipient: unknown,
  method: "erc3009" | "permit2",
  allowlist: string[],
  config: SolverPinConfig,
): SolverPinResult {
  const addr = typeof recipient === "string" ? recipient.toLowerCase() : null;

  if (allowlist.length === 0) {
    // No pin configured for this method. ERC-3009 is bounded by the signed `to`
    // + on-chain msg.sender == to, so accept unless a hard pin is demanded.
    // Permit2 has no such guard, so it must always be pinned.
    if (method === "erc3009" && !config.requirePin) return { ok: true };

    return {
      ok: false,
      field,
      reason:
        method === "permit2"
          ? "permit2 origin pull requires a pinned spender address"
          : "solver pin required but no allowlist is configured",
    };
  }

  if (addr !== null && allowlist.includes(addr)) return { ok: true };

  return {
    ok: false,
    field,
    reason: `origin-pull ${field} ${String(recipient)} is not an allowed solver address`,
  };
}
