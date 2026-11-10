import { afterEach, describe, expect, it } from "vitest";
import {
  installPromiseWithResolvers,
  type PromiseConstructorWithResolvers,
} from "./promiseWithResolvers.js";

const native = Object.getOwnPropertyDescriptor(Promise, "withResolvers");

afterEach(() => {
  if (native) Object.defineProperty(Promise, "withResolvers", native);
  else delete (Promise as PromiseConstructorWithResolvers).withResolvers;
});

describe("Promise.withResolvers compatibility", () => {
  it("installs a working shim only when the browser lacks the native API", async () => {
    const constructor = Promise as PromiseConstructorWithResolvers;
    constructor.withResolvers = undefined;

    installPromiseWithResolvers();

    const resolvers = (Promise as PromiseConstructorWithResolvers).withResolvers?.<number>();
    if (!resolvers) throw new Error("Promise.withResolvers shim was not installed");
    resolvers.resolve(42);
    await expect(resolvers.promise).resolves.toBe(42);
  });
});
