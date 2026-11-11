/**
 * Whether the Get code dock opens with its code shown (xochi-fi/xochi-widget#35).
 *
 * On desktop the dock is pinned under the settings column and takes its height
 * from it, so on a short viewport an open dock hides the lower half of a
 * section (Route's Receive leg at 1280x720). There it opens collapsed to its
 * head row, which still copies. Stacked (760px and below) the dock is in the
 * page flow and covers nothing, so it opens shown.
 *
 * 920px: the open dock with format tabs and the non-production notice is
 * about 410px tall, which still clipped Route's Receive leg at 900-913px.
 */
export const CODE_SHOWN_MEDIA = "(min-height: 920px), (max-width: 760px)";

/** Read once at mount; the user's toggle wins after that. */
export function codeShownByDefault(): boolean {
  return typeof window.matchMedia !== "function" || window.matchMedia(CODE_SHOWN_MEDIA).matches;
}
