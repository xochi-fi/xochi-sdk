// colorette (pulled in by the Aztec logger) reads `tty.isatty` at module scope; a browser has no TTY.
export const isatty = (): boolean => false;
export default { isatty };
