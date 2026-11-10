import { Buffer } from "buffer";
import { installPromiseWithResolvers } from "./promiseWithResolvers.js";

globalThis.Buffer = globalThis.Buffer || Buffer;
installPromiseWithResolvers();
