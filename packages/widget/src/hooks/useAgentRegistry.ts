/**
 * useAgentRegistry Hook
 *
 * Reactive view of the connected wallet's authorized-agent registry
 * (see lib/agentRegistry). Purely client-side; nothing here touches the server.
 */

import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import {
  listAgents,
  authorizeAgent,
  revokeAgent,
  subscribeAgentRegistry,
  type AuthorizedAgent,
  type AuthorizeInput,
} from "../lib/agentRegistry.js";

export interface UseAgentRegistryReturn {
  agents: AuthorizedAgent[];
  authorize: (input: AuthorizeInput) => void;
  revoke: (agentWallet: string) => void;
}

export function useAgentRegistry(): UseAgentRegistryReturn {
  const { address } = useAccount();
  const [agents, setAgents] = useState<AuthorizedAgent[]>(() => listAgents(address));

  const reload = useCallback(() => setAgents(listAgents(address)), [address]);

  useEffect(() => {
    reload();
    return subscribeAgentRegistry(reload);
  }, [reload]);

  const authorize = useCallback(
    (input: AuthorizeInput) => {
      authorizeAgent(address, input);
    },
    [address],
  );

  const revoke = useCallback(
    (agentWallet: string) => {
      revokeAgent(address, agentWallet);
    },
    [address],
  );

  return { agents, authorize, revoke };
}
