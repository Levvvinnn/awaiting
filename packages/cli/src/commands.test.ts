import { describe, expect, it } from 'vitest';
import { COMMANDS, isCommand } from './commands';

describe('isCommand', () => {
  it.each(['install', 'uninstall', 'doctor'])('accepts %s', (value) => {
    expect(isCommand(value)).toBe(true);
  });

  it.each(['', 'Install', 'help'])('rejects %j', (value) => {
    expect(isCommand(value)).toBe(false);
  });

  it('lists exactly the three subcommands', () => {
    expect(COMMANDS).toEqual(['install', 'uninstall', 'doctor']);
  });
});
