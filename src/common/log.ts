const PREFIX = "[ChatFreePT]";

/**
 * The only sanctioned console access in the extension. The repository quality gate
 * rejects bare console.log in changed files, and a single namespace keeps the host
 * page's own console output filterable.
 */
export const log = {
  debug: (...args: unknown[]): void => console.debug(PREFIX, ...args),
  info: (...args: unknown[]): void => console.info(PREFIX, ...args),
  warn: (...args: unknown[]): void => console.warn(PREFIX, ...args),
  error: (...args: unknown[]): void => console.error(PREFIX, ...args),
};
