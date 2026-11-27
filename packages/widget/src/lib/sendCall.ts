import { encodeFunctionData, erc20Abi, isAddress, maxUint256, zeroAddress } from "viem";
import type { OriginSponsorshipAction } from "../types/originSponsorship.js";

/** Build the wallet call for a public Send. Native assets use the zero token address. */
export function publicSendCall({
  token,
  recipient,
  amount,
}: Extract<OriginSponsorshipAction, { action: "send" }>) {
  if (
    !isAddress(token, { strict: false }) ||
    !isAddress(recipient) ||
    recipient.toLowerCase() === zeroAddress ||
    amount <= 0n ||
    amount > maxUint256
  )
    throw new Error("Invalid Send");
  return token.toLowerCase() === zeroAddress
    ? { to: recipient, value: amount, data: "0x" as const }
    : {
        to: token,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [recipient, amount],
        }),
      };
}
