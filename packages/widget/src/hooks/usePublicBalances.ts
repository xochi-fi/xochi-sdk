/**
 * Read wallet holdings independently of trade-route availability. Each browser
 * chain has its own query, so a failed or unconfigured chain cannot discard
 * successful reads elsewhere. Arc USDC uses the first-party balance endpoint;
 * its native and ERC-20 views are the same funds and are counted only once.
 */

import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { readContractsQueryOptions } from "@wagmi/core/query";
import { useAccount, useBalance, useConfig } from "wagmi";
import { erc20Abi } from "viem";
import { ARC_BROWSER_ENABLED, GNOSIS_ENABLED, TIMEOUTS } from "../config.js";
import { useRecipientBalance } from "./useRecipientBalance.js";
import { useCapabilities } from "./useCapabilities.js";
import {
  publicBalanceTokens,
  erc20Balances,
  aggregateBySymbol,
  readBalance,
  type PublicBalance,
  type PublicBalanceToken,
} from "../lib/balances.js";
import { ARC_CHAIN_ID, CHAIN_NATIVE_CURRENCY, GNOSIS_CHAIN_ID } from "@xochi/client";

const REFRESH = TIMEOUTS.balanceRefresh;

export function usePublicBalances() {
  const config = useConfig();
  const { address, isConnected } = useAccount();
  const { capabilities } = useCapabilities();
  const enabled = isConnected && !!address;
  const discovery = useMemo(() => {
    const tokens = publicBalanceTokens(capabilities).filter(
      ({ chainId }) =>
        (ARC_BROWSER_ENABLED || chainId !== ARC_CHAIN_ID) &&
        (GNOSIS_ENABLED || chainId !== GNOSIS_CHAIN_ID),
    );
    const browser = tokens.filter(({ chainId }) => chainId !== ARC_CHAIN_ID);
    const registered = new Set(config.chains.map((chain) => chain.id));
    const byChain = new Map<number, PublicBalanceToken[]>();
    const unconfigured: PublicBalanceToken[] = [];
    for (const token of browser) {
      if (!registered.has(token.chainId)) {
        unconfigured.push(token);
        continue;
      }
      const group = byChain.get(token.chainId);
      if (group) group.push(token);
      else byChain.set(token.chainId, [token]);
    }
    return {
      groups: [...byChain.values()],
      unconfigured,
      configurationError: unconfigured.length
        ? new Error(
            `Balance chains not configured: ${[...new Set(unconfigured.map((t) => t.chainId))].join(", ")}`,
          )
        : null,
      arc: tokens.find(({ chainId, symbol }) => chainId === ARC_CHAIN_ID && symbol === "USDC"),
    };
  }, [capabilities, config.chains]);

  const arcBalance = useRecipientBalance(
    discovery.arc ? ARC_CHAIN_ID : undefined,
    discovery.arc?.address,
    enabled ? address : undefined,
  );

  const erc20 = useQueries({
    queries: discovery.groups.map((tokens) => ({
      ...readContractsQueryOptions(config, {
        allowFailure: true,
        contracts: tokens.map((token) => ({
          address: token.address as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: address ? ([address] as const) : undefined,
          chainId: token.chainId,
        })),
      }),
      enabled,
      refetchInterval: REFRESH,
    })),
    combine: (queries) => {
      // allowFailure reports individual contract failures as query data.
      const failedContract = queries
        .flatMap((query) => query.data ?? [])
        .find((result) => result.status === "failure");
      return {
        balances: queries.flatMap((query, index) =>
          erc20Balances(discovery.groups[index], enabled ? query.data : undefined),
        ),
        error:
          queries.find((query) => query.isError)?.error ??
          (failedContract?.status === "failure" ? failedContract.error : null) ??
          null,
        isLoading: queries.some((query) => query.isLoading),
        refetches: queries.map((query) => query.refetch),
      };
    },
  });

  // Fixed hook count. Disabled/unregistered chains stay unknown; Arc has no
  // separate native read because the endpoint above already reads its USDC.
  const nativeQuery = (chainId: number) => ({
    enabled: enabled && config.chains.some((chain) => chain.id === chainId),
    refetchInterval: REFRESH,
  });
  const nativeEth = useBalance({ address, chainId: 1, query: nativeQuery(1) });
  const nativeOp = useBalance({ address, chainId: 10, query: nativeQuery(10) });
  const nativePol = useBalance({ address, chainId: 137, query: nativeQuery(137) });
  const nativeArb = useBalance({ address, chainId: 42161, query: nativeQuery(42161) });
  const nativeBase = useBalance({ address, chainId: 8453, query: nativeQuery(8453) });
  const nativeRbn = useBalance({ address, chainId: 4663, query: nativeQuery(4663) });
  const nativeGno = useBalance({
    address,
    chainId: GNOSIS_CHAIN_ID,
    query: {
      ...nativeQuery(GNOSIS_CHAIN_ID),
      enabled: nativeQuery(GNOSIS_CHAIN_ID).enabled && GNOSIS_ENABLED,
    },
  });
  const natives = [
    { chainId: 1, query: nativeEth },
    { chainId: 10, query: nativeOp },
    { chainId: 137, query: nativePol },
    { chainId: 42161, query: nativeArb },
    { chainId: 8453, query: nativeBase },
    { chainId: 4663, query: nativeRbn },
    ...(GNOSIS_ENABLED ? [{ chainId: GNOSIS_CHAIN_ID, query: nativeGno }] : []),
  ];

  const nativeBalances = useMemo<PublicBalance[]>(() => {
    const dataByChain = [
      { chainId: 1, data: nativeEth.data },
      { chainId: 10, data: nativeOp.data },
      { chainId: 137, data: nativePol.data },
      { chainId: 42161, data: nativeArb.data },
      { chainId: 8453, data: nativeBase.data },
      { chainId: 4663, data: nativeRbn.data },
      ...(GNOSIS_ENABLED ? [{ chainId: GNOSIS_CHAIN_ID, data: nativeGno.data }] : []),
    ];
    return dataByChain.map(({ chainId, data: result }) => {
      const data = enabled ? result : undefined;
      return {
        chainId,
        address: "native",
        symbol:
          data?.symbol ??
          CHAIN_NATIVE_CURRENCY[chainId as keyof typeof CHAIN_NATIVE_CURRENCY] ??
          "ETH",
        decimals: data?.decimals ?? 18,
        balance: data?.value ?? 0n,
        isNative: true,
        ...(data === undefined ? { unread: true as const } : {}),
      };
    });
  }, [
    enabled,
    nativeEth.data,
    nativeOp.data,
    nativePol.data,
    nativeArb.data,
    nativeBase.data,
    nativeRbn.data,
    nativeGno.data,
  ]);

  const balances = useMemo<PublicBalance[]>(
    () => [
      ...nativeBalances,
      ...erc20.balances,
      ...erc20Balances(discovery.unconfigured, undefined),
      ...(discovery.arc
        ? [
            {
              ...discovery.arc,
              balance: arcBalance.balance ?? 0n,
              isNative: false,
              ...(arcBalance.balance === null ? { unread: true as const } : {}),
            },
          ]
        : []),
    ],
    [nativeBalances, erc20.balances, discovery, arcBalance.balance],
  );

  const holdings = useMemo(() => aggregateBySymbol(balances), [balances]);
  const readBalanceOf = useCallback(
    (chainId: number, tokenAddress: string) => readBalance(balances, chainId, tokenAddress),
    [balances],
  );
  const error = enabled
    ? (erc20.error ??
      discovery.configurationError ??
      arcBalance.error ??
      natives.find(({ query }) => query.isError)?.query.error ??
      null)
    : null;

  const refetch = () => {
    for (const refetchChain of erc20.refetches) void refetchChain();
    if (discovery.arc) arcBalance.refetch();
    for (const { chainId, query } of natives) {
      if (config.chains.some((chain) => chain.id === chainId)) void query.refetch();
    }
  };

  return {
    balances,
    holdings,
    readBalanceOf,
    hasUnread: enabled && balances.some((balance) => balance.unread),
    isLoading:
      enabled &&
      (erc20.isLoading || arcBalance.isLoading || natives.some(({ query }) => query.isLoading)),
    isError: error !== null,
    error,
    refetch,
  };
}
