import { useEffect, useMemo, useState } from "react";
import { getPublicClient } from "@wagmi/core";
import { useConfig } from "wagmi";
import { toCoinType } from "viem";
import {
  resolveRecipient,
  type RecipientDeps,
  type ResolveResult,
} from "../../lib/recipient/index.js";

const LOOKING = { status: "looking" } as const;
const EMPTY = { status: "empty" } as const;

type Lookup = (ResolveResult & { networkMismatch?: boolean }) | typeof LOOKING | typeof EMPTY;

export function useRecipientDeps(): RecipientDeps | undefined {
  const config = useConfig();
  return useMemo(() => {
    const clientFor = (chainId: number) =>
      config.chains.some((chain) => chain.id === chainId)
        ? getPublicClient(config, { chainId })
        : undefined;
    const mainnetClient = clientFor(1);
    return mainnetClient ? { mainnetClient, clientFor } : undefined;
  }, [config]);
}

export function useSendRecipient(input: string, chainId: number, attempt = 0): Lookup {
  const deps = useRecipientDeps();
  const [result, setResult] = useState<{
    input: string;
    chainId: number;
    deps: RecipientDeps | undefined;
    lookup: Lookup;
    attempt: number;
  }>();
  const value = input.trim();

  useEffect(() => {
    if (!value) return;
    const controller = new AbortController();
    const { signal } = controller;
    const publish = (lookup: Lookup) => {
      if (!signal.aborted) setResult({ input, chainId, deps, lookup, attempt });
    };
    const timer = setTimeout(() => {
      void (async () => {
        if (!deps) {
          publish({ status: "unavailable", reason: "Lookup unavailable" });
          return;
        }
        const lookup = await resolveRecipient(value, deps, signal);
        const recipient = lookup.status === "resolved" ? lookup.recipient : undefined;
        if (recipient?.kind !== "ens" || !recipient.address || !recipient.name || chainId === 1) {
          publish(lookup);
          return;
        }

        signal.throwIfAborted();
        const chainAddress = await deps.mainnetClient
          .getEnsAddress({
            name: recipient.name,
            coinType: toCoinType(chainId),
          })
          .catch(() => null);
        publish({
          ...lookup,
          networkMismatch:
            !!chainAddress && chainAddress.toLowerCase() !== recipient.address.toLowerCase(),
        });
      })().catch(() => publish({ status: "unavailable", reason: "Lookup unavailable" }));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [input, value, chainId, deps, attempt]);

  if (!value) return EMPTY;
  return result?.input === input &&
    result.chainId === chainId &&
    result.deps === deps &&
    result.attempt === attempt
    ? result.lookup
    : LOOKING;
}
