/**
 * useLocalSends
 *
 * The connected wallet's local log of public sends (lib/localSends), kept live
 * by its pub/sub, so a send made in the Send tab shows in Activity at once.
 */

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { listLocalSends, subscribeLocalSends, type SendActivityItem } from "../lib/localSends.js";

export function useLocalSends(): SendActivityItem[] {
  const { address } = useAccount();
  const [sends, setSends] = useState<SendActivityItem[]>(() => listLocalSends(address));
  useEffect(() => {
    setSends(listLocalSends(address));
    return subscribeLocalSends(() => setSends(listLocalSends(address)));
  }, [address]);
  return sends;
}
