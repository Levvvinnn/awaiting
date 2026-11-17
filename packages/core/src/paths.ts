// Data-directory rule (plan 01 §3.2, D1.4). Pure string logic: callers pass env, home dir and
// separator in, then `path.resolve` the result. hooks/awaiting-hook.js carries a copy of this
// rule, kept in sync by a contract test table.

/** Environment variable that overrides the data directory. */
export const AWAITING_HOME_ENV = 'AWAITING_HOME';

/** Name of the default data directory inside the user's home directory. */
export const DATA_DIR_NAME = '.awaiting';

/** A platform path separator. */
export type PathSeparator = '/' | '\\';

/** Input to `resolveDataDir`. */
export type DataDirInput = {
  /** Value of `AWAITING_HOME` (`env[AWAITING_HOME_ENV]`), possibly undefined. */
  awaitingHome: string | undefined;
  /** `os.homedir()`. */
  homeDir: string;
  /** `path.sep` (or `separatorForPlatform(process.platform)`). */
  sep: PathSeparator;
};

/** Returns the path separator for a Node `process.platform` value (`\` on win32, `/` elsewhere). */
export function separatorForPlatform(platform: string): PathSeparator {
  return platform === 'win32' ? '\\' : '/';
}

/** Returns `awaitingHome` verbatim if non-blank, else `<homeDir><sep>.awaiting`; throws RangeError on a blank `homeDir`. */
export function resolveDataDir(input: DataDirInput): string {
  const { awaitingHome, homeDir, sep } = input;
  if (awaitingHome !== undefined && awaitingHome.trim() !== '') {
    return awaitingHome;
  }
  if (homeDir.trim() === '') {
    throw new RangeError('resolveDataDir: homeDir is empty and AWAITING_HOME is not set');
  }
  // On Windows both separators are valid, so strip trailing runs of either.
  const trailing = sep === '\\' ? /[\\/]+$/ : /\/+$/;
  return `${homeDir.replace(trailing, '')}${sep}${DATA_DIR_NAME}`;
}
