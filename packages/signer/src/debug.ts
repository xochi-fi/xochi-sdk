// Reads DEBUG without assuming a Node realm: a bare `process` reference throws a
// ReferenceError at module load in a browser with no `process` shim.
export function debugEnabled(): boolean {
  return typeof process !== "undefined" && !!process.env?.DEBUG;
}
