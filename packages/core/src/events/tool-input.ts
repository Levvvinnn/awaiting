// Content-free `tool_input` summaries (plan 01 §3.6, D1.16).
import { STRING_LIMITS, type ToolInputSummary } from './types.js';
import { capString, codePointLength, isPlainObject } from './util.js';

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const PATH_KEYS = ['file_path', 'notebook_path', 'path'] as const;
const PROGRAM_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Summarizes `tool_input` as paths, Bash/PowerShell program name and length, subagent type and key names; never content. */
export function summarizeToolInput(toolName: string, input: unknown): ToolInputSummary {
  if (!isPlainObject(input)) return { input_keys: [] };
  const summary: ToolInputSummary = {
    input_keys: Object.keys(input)
      .slice(0, STRING_LIMITS.inputKeys)
      .map((k) => capString(k, STRING_LIMITS.toolName)),
  };
  for (const key of PATH_KEYS) {
    const v = input[key];
    if (typeof v === 'string') summary[key] = capString(v, STRING_LIMITS.path);
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = input['command'];
    if (typeof command === 'string') {
      const program = commandProgram(command);
      if (program !== null) summary.command_program = program;
      summary.command_length = codePointLength(command);
    }
    const bg = input['run_in_background'];
    if (typeof bg === 'boolean') summary.run_in_background = bg;
  }
  if (AGENT_TOOLS.has(toolName)) {
    const subagentType = input['subagent_type'];
    if (typeof subagentType === 'string') {
      summary.subagent_type = capString(subagentType, STRING_LIMITS.id);
    }
  }
  return summary;
}

/** Basename of the first command token (quotes honored), only if it looks like a program name. */
function commandProgram(command: string): string | null {
  const trimmed = command.trimStart();
  let token: string;
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    token = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  } else {
    const m = /^\S+/.exec(trimmed);
    token = m === null ? '' : m[0];
  }
  const segments = token.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? '';
  return PROGRAM_NAME.test(base) ? base : null;
}
