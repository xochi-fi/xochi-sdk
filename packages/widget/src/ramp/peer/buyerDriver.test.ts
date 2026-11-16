import { expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Address, type Hex } from "viem";
import { peerRecipientTransfer } from "./buyerDriver.js";
import { peerConfiguration } from "./discovery.js";
const token = peerConfiguration().settlement.asset_id as Address;
const recipient = "0x1111111111111111111111111111111111111111";
const vault = "0x2222222222222222222222222222222222222222";
const other = "0x3333333333333333333333333333333333333333";
function transfer(address: Address, to: Address, value: bigint, from: Address = vault) {
  return {
    address,
    blockHash: null,
    blockNumber: null,
    logIndex: null,
    transactionHash: null,
    transactionIndex: null,
    removed: false,
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
    topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from, to } }) as [
      Hex,
      ...Hex[],
    ],
  };
}
it("requires the actual reviewed USDC payment, not a closed payout lock or unrelated transfer", () => {
  expect(peerRecipientTransfer([], token, recipient, 1000000n, vault)).toBe(false);
  for (const logs of [
    [transfer(token, vault, 1000000n)],
    [transfer(other, recipient, 1000000n)],
    [transfer(token, recipient, 999999n)],
    [transfer(token, recipient, 1000000n, other)],
    [transfer(token, other, 1000000n)],
  ])
    expect(peerRecipientTransfer(logs, token, recipient, 1000000n, vault)).toBe(false);
  expect(
    peerRecipientTransfer(
      [transfer(token, recipient, 1000000n)],
      token,
      recipient,
      1000000n,
      vault,
    ),
  ).toBe(true);
});
