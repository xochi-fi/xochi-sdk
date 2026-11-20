/** Mobile web cannot complete Peer Buy; callers can narrow further, never override this gate. */
export function isPeerMobileWeb(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}
