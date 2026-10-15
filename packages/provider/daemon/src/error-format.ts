function escapeControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (character) => {
    const code = character.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${code}`;
  });
}

export function formatUnknownError(value: unknown): string {
  try {
    if (value instanceof Error && typeof value.message === "string" && value.message !== "") {
      return escapeControlCharacters(value.message);
    }
  } catch {
    return "unreadable thrown value";
  }

  try {
    if (typeof value === "string") return escapeControlCharacters(value);
    if (value === null) return "null";
    if (value === undefined) return "undefined";
    if (typeof value === "object") {
      const serialized = JSON.stringify(value);
      return serialized === undefined ? "unknown object" : escapeControlCharacters(serialized);
    }
    return escapeControlCharacters(String(value));
  } catch {
    return "unreadable thrown value";
  }
}
