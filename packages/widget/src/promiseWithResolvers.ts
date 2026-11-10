/**
 * ES2024 compatibility for @xochi/client's transport on older browsers.
 * Installed from main.tsx before either lazy application entry can import the client.
 */
export interface PromiseConstructorWithResolvers {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
}

export function installPromiseWithResolvers(): void {
  const constructor = Promise as PromiseConstructorWithResolvers;
  if (typeof constructor.withResolvers === "function") return;

  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    writable: true,
    value: <T>() => {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    },
  });
}
