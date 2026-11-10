import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { parseEmbedParams, type HostConnection } from "@xochi/widget-lib";
import { embedLook, type EmbedLook } from "../pages/trade/embedParams.js";

/** URL layout stays fixed; only the host's theme can change in a mounted frame. */
export function useEmbedLook(bridge: HostConnection | null): EmbedLook {
  const [initialLook] = useState(() => embedLook(parseEmbedParams(window.location.search)));
  const subscribe = useCallback(
    (onChange: () => void) => bridge?.onTheme(onChange) ?? (() => {}),
    [bridge],
  );
  const getSnapshot = useCallback(
    () => bridge?.theme() ?? initialLook.theme,
    [bridge, initialLook.theme],
  );
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(
    () => (theme === initialLook.theme ? initialLook : { ...initialLook, theme }),
    [initialLook, theme],
  );
}
