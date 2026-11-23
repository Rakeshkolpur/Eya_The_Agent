import { describe, it, expect } from 'vitest';
import { validateArgs, ToolValidationError } from '../src/main/tools/types';
import type { ToolSchema } from '../src/main/tools/types';

const schema: ToolSchema = {
  name: 'test',
  description: 'test',
  args: {
    name: { type: 'string', required: true },
    count: { type: 'number' },
    mode: { type: 'string', enum: ['fast', 'safe'] },
  },
};

describe('validateArgs', () => {
  it('accepts valid args', () => {
    expect(() => validateArgs(schema, { name: 'x', count: 1, mode: 'fast' })).not.toThrow();
  });

  it('rejects missing required arg', () => {
    expect(() => validateArgs(schema, {})).toThrow(ToolValidationError);
  });

  it('rejects wrong type', () => {
    expect(() => validateArgs(schema, { name: 42 as unknown as string })).toThrow(
      ToolValidationError,
    );
  });

  it('rejects unknown arg', () => {
    expect(() => validateArgs(schema, { name: 'x', extra: 'y' })).toThrow(ToolValidationError);
  });

  it('rejects out-of-enum value', () => {
    expect(() => validateArgs(schema, { name: 'x', mode: 'wild' })).toThrow(ToolValidationError);
  });
});
