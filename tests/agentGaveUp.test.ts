import { describe, it, expect } from 'vitest';
import { describeGaveUp } from '../src/main/agent/AgentEngine';

describe('what is said when a task is given up on', () => {
  it('running out of time after slow model steps blames the slow service, not the size of the request', () => {
    const said = describeGaveUp('time', [8805, 6195, 9226], 3);
    expect(said).toMatch(/AI service is very slow right now/);
    expect(said).toMatch(/after 3 steps/);
    expect(said).toMatch(/try again in a minute or two/i);
    expect(said).not.toMatch(/break it down|more steps/i);
  });

  it('running out of time with a healthy model says it took too long, once', () => {
    const said = describeGaveUp('time', [1800, 2100], 1);
    expect(said).toBe('That took too long and I ran out of time after 1 step. Please ask for one smaller thing at a time.');
  });

  it('only a real step limit says "more steps than I can do"', () => {
    expect(describeGaveUp('steps', [2000], 16)).toBe('That took more steps than I can do in one go. Could you break it down?');
  });

  it('no timings at all is not called slow', () => {
    expect(describeGaveUp('time', [], 0)).toMatch(/ran out of time after 0 steps/);
    expect(describeGaveUp('time', [], 0)).not.toMatch(/very slow/);
  });
});
