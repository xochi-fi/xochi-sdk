import { useState, useEffect } from "react";

/**
 * Hook for reading a value from localStorage without persisting changes.
 * Useful when one component writes and another only reads.
 *
 * @param key - The localStorage key
 * @param typeGuard - Optional type guard for validating stored data
 */
export function useLocalStorageRead<T>(
  key: string,
  typeGuard?: (value: unknown) => value is T,
): T | null {
  const [value, setValue] = useState<T | null>(null);

  useEffect(() => {
    try {
      const item = localStorage.getItem(key);
      if (item === null) {
        setValue(null);
        return;
      }

      const parsed: unknown = JSON.parse(item);

      if (typeGuard) {
        setValue(typeGuard(parsed) ? parsed : null);
      } else {
        setValue(parsed as T);
      }
    } catch (error) {
      console.warn(`[useLocalStorageRead] Failed to read key "${key}":`, error);
      setValue(null);
    }
  }, [key, typeGuard]);

  return value;
}
