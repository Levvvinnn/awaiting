import { describe, expect, it } from 'vitest';
import { DOC_EXAMPLES, VARIANTS } from '../fixtures/index.js';
import { STRING_LIMITS } from './types.js';
import { summarizeToolInput } from './tool-input.js';

describe('summarizeToolInput', () => {
  it('returns only empty input_keys for a non-object input', () => {
    for (const v of [undefined, null, 'rm -rf /', 5, [], ['a']]) {
      expect(summarizeToolInput('Bash', v)).toEqual({ input_keys: [] });
    }
  });

  describe('Bash / PowerShell', () => {
    it('summarizes the doc PreToolUse example', () => {
      expect(summarizeToolInput('Bash', DOC_EXAMPLES.PreToolUse['tool_input'])).toEqual({
        command_program: 'npm',
        command_length: 'npm test'.length,
        input_keys: ['command', 'description'],
      });
    });

    it('keeps run_in_background only when boolean', () => {
      expect(
        summarizeToolInput('Bash', { command: 'npm run dev', run_in_background: true }),
      ).toMatchObject({ run_in_background: true });
      expect(
        summarizeToolInput('Bash', { command: 'x', run_in_background: 'yes' }),
      ).not.toHaveProperty('run_in_background');
    });

    it('uses the basename of the first token', () => {
      expect(summarizeToolInput('Bash', { command: '/usr/bin/git status' }).command_program).toBe(
        'git',
      );
      expect(
        summarizeToolInput('PowerShell', { command: 'C:\\tools\\rg.exe foo' }).command_program,
      ).toBe('rg.exe');
      expect(summarizeToolInput('Bash', { command: '  ls -la' }).command_program).toBe('ls');
      expect(summarizeToolInput('Bash', { command: './gradlew build' }).command_program).toBe(
        'gradlew',
      );
    });

    it('honors a quoted first token', () => {
      expect(
        summarizeToolInput('PowerShell', {
          command: '"C:\\Program Files\\nodejs\\node.exe" script.js',
        }).command_program,
      ).toBe('node.exe');
      expect(summarizeToolInput('Bash', { command: "'my tool' x" }).command_program).toBe(
        undefined,
      );
    });

    it('omits command_program when the token is not a plain program name', () => {
      for (const command of [
        'FOO=secret npm test',
        '& "C:\\x\\y.exe"',
        '$(curl evil)',
        '',
        '   ',
        'a'.repeat(65),
        'echo|cat',
      ]) {
        const s = summarizeToolInput('Bash', { command });
        expect(s).not.toHaveProperty('command_program');
        expect(s.command_length).toBe([...command].length);
      }
    });

    it('measures command_length in code points', () => {
      expect(summarizeToolInput('Bash', { command: 'echo 😀' }).command_length).toBe(6);
    });

    it('ignores a non-string command', () => {
      const s = summarizeToolInput('Bash', { command: ['npm', 'test'] });
      expect(s).toEqual({ input_keys: ['command'] });
    });

    it('does not apply shell rules to other tools', () => {
      expect(summarizeToolInput('Read', { command: 'npm test' })).toEqual({
        input_keys: ['command'],
      });
    });
  });

  describe('paths', () => {
    it('keeps file_path (doc PostToolUse) and drops content', () => {
      expect(summarizeToolInput('Write', DOC_EXAMPLES.PostToolUse['tool_input'])).toEqual({
        file_path: '/Users/alice/my-project/file.txt',
        input_keys: ['file_path', 'content'],
      });
    });

    it('keeps a Windows file_path verbatim', () => {
      expect(
        summarizeToolInput('Write', VARIANTS.preToolUseWindowsWrite['tool_input']).file_path,
      ).toBe('C:\\Users\\alice\\my-project\\src\\app.ts');
    });

    it('keeps notebook_path and path on any tool, capped', () => {
      const long = 'p'.repeat(STRING_LIMITS.path + 50);
      const s = summarizeToolInput('Grep', {
        path: long,
        notebook_path: '/n.ipynb',
        pattern: 'secret',
      });
      expect(s.path).toHaveLength(STRING_LIMITS.path);
      expect(s.notebook_path).toBe('/n.ipynb');
      expect(JSON.stringify(s)).not.toContain('secret"');
    });

    it('ignores non-string paths', () => {
      expect(summarizeToolInput('Read', { file_path: 3 })).toEqual({ input_keys: ['file_path'] });
    });
  });

  describe('Agent / Task', () => {
    it('keeps subagent_type and drops the agent prompt', () => {
      for (const tool of ['Agent', 'Task']) {
        const s = summarizeToolInput(tool, {
          subagent_type: 'Explore',
          prompt: 'investigate the secret',
          description: 'd',
        });
        expect(s).toEqual({
          subagent_type: 'Explore',
          input_keys: ['subagent_type', 'prompt', 'description'],
        });
      }
    });

    it('ignores subagent_type on other tools', () => {
      expect(summarizeToolInput('Read', { subagent_type: 'Explore' })).toEqual({
        input_keys: ['subagent_type'],
      });
    });
  });

  describe('never keeps content', () => {
    it.each([
      ['Edit', { file_path: '/f', old_string: 'OLD_SECRET', new_string: 'NEW_SECRET' }],
      ['WebFetch', { url: 'https://secret.example', prompt: 'SECRET_PROMPT' }],
      ['WebSearch', { query: 'SECRET_QUERY' }],
      ['Write', { file_path: '/f', content: 'SECRET_CONTENT' }],
      ['Bash', { command: 'echo SECRET_ARG', description: 'SECRET_DESC' }],
      ['mcp__srv__tool', { anything: 'SECRET_VALUE', nested: { deep: 'SECRET_DEEP' } }],
    ])('%s', (tool, input) => {
      expect(JSON.stringify(summarizeToolInput(tool, input))).not.toMatch(/SECRET/);
    });
  });

  describe('input_keys', () => {
    it(`keeps at most ${STRING_LIMITS.inputKeys} key names, each capped`, () => {
      const input: Record<string, number> = {};
      for (let i = 0; i < 30; i++) input[`k${i}`] = i;
      input['x'.repeat(200)] = 1;
      const keys = summarizeToolInput('X', input).input_keys;
      expect(keys).toHaveLength(STRING_LIMITS.inputKeys);
      expect(keys[0]).toBe('k0');

      const longKey = summarizeToolInput('X', { ['y'.repeat(200)]: 1 }).input_keys;
      expect(longKey[0]).toHaveLength(STRING_LIMITS.toolName);
    });
  });
});
