/**
 * useWrapEth Hook
 *
 * Wrap native ETH into WETH (`deposit`) and unwrap WETH back to ETH
 * (`withdraw`) on the connected chain, via the canonical WETH contract.
 * Real on-chain writes through wagmi; the caller drives amounts and reads
 * balances from usePublicBalances.
 */

import { useCallback } from "react";
import { useChainId, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { type ChainId } from "@xochi/client";
import { WETH_ADDRESSES } from "@xochi/client";

// Minimal WETH9 interface: deposit() payable, withdraw(uint256).
const WETH_ABI = [
  { name: "deposit", type: "function", stateMutability: "payable", inputs: [], outputs: [] },
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wad", type: "uint256" }],
    outputs: [],
  },
] as const;

export type WrapDirection = "wrap" | "unwrap";

export function useWrapEth() {
  const chainId = useChainId();
  const wethAddress = WETH_ADDRESSES[chainId as ChainId] as `0x${string}` | undefined;

  const { writeContractAsync, data: hash, isPending, error, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  const wrap = useCallback(
    async (amountWei: bigint) => {
      if (!wethAddress) throw new Error("WETH is not available on this chain");
      return writeContractAsync({
        address: wethAddress,
        abi: WETH_ABI,
        functionName: "deposit",
        value: amountWei,
        chainId,
      });
    },
    [wethAddress, chainId, writeContractAsync],
  );

  const unwrap = useCallback(
    async (amountWei: bigint) => {
      if (!wethAddress) throw new Error("WETH is not available on this chain");
      return writeContractAsync({
        address: wethAddress,
        abi: WETH_ABI,
        functionName: "withdraw",
        args: [amountWei],
        chainId,
      });
    },
    [wethAddress, chainId, writeContractAsync],
  );

  return {
    chainId,
    wethAvailable: !!wethAddress,
    wrap,
    unwrap,
    hash,
    isPending,
    isConfirming,
    isSuccess,
    error,
    reset,
  };
}
