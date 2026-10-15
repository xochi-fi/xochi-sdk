export function formatUnknownError(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === "string" && value.message !== "") {
      return value.message;
    }
  } catch {
    return "unreadable thrown value";
  }

  try {
    if (typeof value === "string") return value;
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "object") {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? "unknown object" : serialized;
    }
    return String(value);
  } catch {
    return "unreadable thrown value";
  }
}
