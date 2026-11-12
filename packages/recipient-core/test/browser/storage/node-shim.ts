// Stands in for the Node built-ins (`tty`, `net`) that Aztec packages import at module scope but
// never call in a browser, as an app bundler stubs them. colorette (the Aztec logger) reads
// `tty.isatty` at module scope; a browser has no TTY.
export const isatty = (): boolean => false;
export default { isatty };
