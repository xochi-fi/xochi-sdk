/**
 * SessionReloadBanner
 *
 * Listens for the one-shot session-expired signal (fired when an authed API
 * call returns a 401 expired-token) and shows a fixed banner prompting a
 * reload -- which pulls a fresh build and a new login.
 */

import { useEffect, useState } from "react";
import { SESSION_EXPIRED_EVENT } from "../lib/sessionExpiry.js";

export function SessionReloadBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const handler = () => setShow(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, handler);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
  }, []);

  if (!show) return null;

  return (
    <div className="reload-banner" role="alert">
      <span className="reload-banner__text">
        A new version of Xochi is available. Please reload.
      </span>
      <button className="reload-banner__btn" onClick={() => window.location.reload()}>
        Reload
      </button>
    </div>
  );
}
