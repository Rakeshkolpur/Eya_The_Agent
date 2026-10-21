import { describe, it, expect } from 'vitest';
import { TaskCompleter } from '../src/main/tasks/TaskCompleter';
import { TaskCommands } from '../src/main/tasks/TaskCommands';
import { TaskStore } from '../src/main/tasks/TaskStore';
import type { StoreIo } from '../src/main/privacy/communicationAccessStore';
import type { AgentResult } from '../src/shared/types';

function setup() {
  const files = new Map<string, string>();
  const io: StoreIo = { read: (p) => files.get(p) ?? null, write: (p, t) => void files.set(p, t) };
  const ran: string[] = [];
  const completer = new TaskCompleter({
    store: new TaskStore('t.json', io),
    run: async (task) => {
      ran.push(task.request);
      return { requestId: 'r', ok: true, spoken: 'Done.' } satisfies AgentResult;
    },
    notify: () => undefined,
  });
  return { completer, commands: new TaskCommands(completer), ran };
}

const say = async (c: TaskCommands, text: string) => (await c.tryHandle(text))?.spoken ?? null;

describe('TaskCommands: stopping', () => {
  it('"cancel the task" stops the latest open one and says which', async () => {
    const { completer, commands } = setup();
    completer.begin('send this image to Akka on WhatsApp', 'live');
    expect(await say(commands, 'Cancel the task')).toBe('Okay, I\'ve stopped: send this image to Akka on WhatsApp.');
    expect(completer.snapshot().open).toBe(0);
  });

  it('understands the ways people say it', async () => {
    for (const phrase of ['stop the task', 'cancel that task', 'hey Eya, cancel the task please', 'abort the job', 'stop working on it', 'drop the current task', 'Cancel my request.']) {
      const { completer, commands } = setup();
      completer.begin('download the form', 'text');
      const reply = await say(commands, phrase);
      expect(reply, phrase).toContain("I've stopped");
      expect(completer.snapshot().open, phrase).toBe(0);
    }
  });

  it('"stop all tasks" and "cancel everything" stop them all', async () => {
    for (const phrase of ['stop all tasks', 'cancel everything', 'cancel all the tasks', 'forget all my pending tasks']) {
      const { completer, commands } = setup();
      completer.begin('one', 'text');
      completer.begin('two', 'text');
      expect(await say(commands, phrase), phrase).toBe("Okay, I've stopped all 2 tasks.");
      expect(completer.snapshot().open, phrase).toBe(0);
    }
  });

  it('"never mind" and "forget it" stop a task only while one is open, and are otherwise left to everything else', async () => {
    const idle = setup();
    expect(await say(idle.commands, 'never mind')).toBeNull();
    expect(await say(idle.commands, 'forget it')).toBeNull();

    const busy = setup();
    busy.completer.begin('send the file', 'text');
    expect(await say(busy.commands, 'never mind')).toContain("I've stopped");
  });

  it('says so when there is nothing to stop', async () => {
    const { commands } = setup();
    expect(await say(commands, 'cancel the task')).toBe("There's nothing I'm working on.");
    expect(await say(commands, 'cancel everything')).toBe("There's nothing I'm working on.");
  });
});

describe('TaskCommands: asking', () => {
  it('says what it is working on, and what each task waits for', async () => {
    const { completer, commands } = setup();
    expect(await say(commands, 'what are you working on')).toBe("I'm not working on anything right now.");
    const a = completer.begin('send this image to Akka', 'live');
    completer.settle(a, { requestId: 'r', ok: false, spoken: 'later', pending: { kind: 'retry', why: 'WhatsApp is loading' } });
    const reply = await say(commands, 'any pending tasks?');
    expect(reply).toBe('One task: send this image to Akka, waiting to try again.');
    const b = completer.begin('open the cause list', 'text');
    completer.settle(b, { requestId: 'r', ok: true, spoken: 'There is a CAPTCHA.', pending: { kind: 'needs_you', why: 'a CAPTCHA', watch: 'browser' } });
    expect(await say(commands, "what's pending")).toContain('2 tasks:');
    expect(await say(commands, "what's pending")).toContain('open the cause list, waiting for you');
  });
});

describe('TaskCommands: carrying on', () => {
  it('"continue" resumes what is waiting, and does nothing when nothing is', async () => {
    const empty = setup();
    expect(await say(empty.commands, 'continue')).toBeNull();
    expect(await say(empty.commands, 'try again')).toBeNull();

    const { completer, commands, ran } = setup();
    const id = completer.begin('upload the form', 'text');
    completer.settle(id, { requestId: 'r', ok: true, spoken: 'Please sign in.', pending: { kind: 'needs_you', why: 'a sign-in' } });
    expect(await say(commands, 'continue')).toBe('Okay, carrying on with: upload the form.');
    await completer.tick();
    expect(ran).toEqual(['upload the form']);
  });

  it('"try again" also picks up a task that was stopped or failed', async () => {
    const { completer, commands, ran } = setup();
    const id = completer.begin('zip my Downloads folder', 'text');
    completer.cancel(id);
    expect(await say(commands, 'try again')).toBe('Okay, carrying on with: zip my Downloads folder.');
    await completer.tick();
    expect(ran).toHaveLength(1);
  });
});

describe('TaskCommands: what it leaves alone', () => {
  it('never acts on always-on listening, long sentences, or ordinary requests', async () => {
    const { completer, commands } = setup();
    completer.begin('send the file', 'text');
    expect((await commands.tryHandle('cancel the task', { live: true })) ?? null).toBeNull();
    expect(await say(commands, 'please cancel the task for the meeting tomorrow and also remind me about it later')).toBeNull();
    expect(await say(commands, 'open notepad')).toBeNull();
    expect(await say(commands, 'send the invoice to Akka')).toBeNull();
    expect(completer.snapshot().open).toBe(1);
  });
});
