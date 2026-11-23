import { describe, expect, it } from 'vitest';
import { systemPrompt } from '../src/main/agent/prompts';
import { groupOfTool, parseGroups, routeGroups, routeTopics, selectTools } from '../src/main/agent/toolGroups';
import { pcRig } from './pcFixtures';

/** A PC problem switches the PC tools on (and the Settings page with them); an ordinary website, chat or file request does not carry them. */

describe('what points at the PC tools', () => {
  const pc = [
    'how do I set the environment variable JAVA_HOME',
    'set JAVA_HOME to C:\Program Files\Java\jdk-17',
    "node is not recognized as an internal or external command",
    'install git on my pc',
    'installing python is failing',
    'add python to the path',
    'add C:\tools to my path',
    'winget install vs code',
    'npm not working',
    'java version problem',
    'my laptop is very slow',
    'my computer is not working properly',
    'internet not working on my computer',
    'my disk space is full',
    'clean up my temporary files',
    'the taskbar is frozen',
    'dns is not resolving',
    'I have a proxy problem',
    'uninstall docker',
    'uninstall anydesk from my pc',
    'rename my pc to Rakhi',
    'rename my PC to Rakhi please',
    'change my computer name to Rakhi',
    'change pc name',
    'set pc name Rakhi',
    'give my laptop a new name',
    'what is my pc name',
    "what's my computer name",
    'call my laptop Rakhi',
    // the Windows side: speed, background programs, start-up apps, the microphone, printers, commands
    'make my pc fast',
    'make my laptop faster',
    'my pc is very slow',
    'speed up my computer',
    'my laptop is lagging',
    'free up ram',
    'my memory is full',
    'high cpu usage',
    'stop all background running apps',
    'close all running programs',
    'what is running in the background',
    'stop startup apps',
    'disable startup programs',
    'which apps start with windows',
    'boot time is slow',
    'mic issue',
    'my microphone is not working',
    'they cannot hear me',
    'no sound from my laptop',
    'my headset is not working',
    'the printer is stuck',
    'run a powershell command to list services',
    'open task manager',
  ];
  for (const text of pc) {
    it(`"${text}" switches them on, with the Settings pages`, () => {
      const g = routeGroups(text);
      expect(g.has('pcfix'), text).toBe(true);
      expect(g.has('system'), text).toBe(true);
    });
  }

  const not = [
    'open youtube and play a song',
    'send hello to Akka on WhatsApp',
    'find my resume pdf',
    'what is the cause list for today',
    'book a ticket on irctc',
    'open the flipkart website and order a phone',
    'set up a live chat with Meera',
    'do live chat with Meera, I am here too',
    'write the petition in Word and add page numbers',
    'what is the weather',
    'rename my resume pdf to cv',
    'rename the folder petitions to Cases',
    'change the system volume to 30',
    'change my phone name to Rakhi',
    'set the wallpaper to the beach photo',
    'tell me how many cases listed for monday, check in high court of telangana advocate code is 21295',
    'play the latest telugu song on youtube',
    'send a message to Anna on WhatsApp saying I will call at six',
    'write a petition and add a heading',
    'what is the capital of France',
    'order a pizza from zomato',
  ];
  for (const text of not) {
    it(`"${text}" does not`, () => {
      expect(routeGroups(text).has('pcfix'), text).toBe(false);
    });
  }

  it('every PC tool is in the group, and the group is one of the groups the model can switch on', () => {
    for (const n of ['pc_check', 'set_environment_variable', 'remove_environment_variable', 'edit_user_path', 'find_program', 'install_program', 'flush_dns', 'clear_temp_files', 'restart_explorer', 'list_pc_changes', 'undo_pc_change']) {
      expect(groupOfTool(n), n).toBe('pcfix');
    }
  });

  it('the exact words that were typed ("rename my pc to Rakhi") send the model the rename tool and what to do with it, and not the browser', () => {
    const { tools } = pcRig();
    const all = [...tools.map((t) => ({ name: t.schema.name })), { name: 'click_on_page' }, { name: 'find_and_open_website' }];
    const text = 'rename my pc to Rakhi';
    const groups = routeGroups(text);
    const topics = routeTopics(text);
    const sent = selectTools(all, groups, topics).map((t) => t.name);
    for (const n of ['rename_pc', 'uninstall_program', 'install_program', 'pc_check']) expect(sent, n).toContain(n);
    expect(sent).not.toContain('click_on_page');
    const prompt = systemPrompt(new Date('2026-11-22T10:00:00'), groups, topics);
    expect(prompt).toContain('"Rename my PC" is rename_pc, never Settings, About and clicking');
    expect(prompt).toContain("Windows' permission box");
    expect(prompt).toContain('You never click it and never type a password');
    // a request that has nothing to do with the PC does not carry any of it
    const other = routeGroups('open youtube and play a song');
    expect(selectTools(all, other, routeTopics('open youtube and play a song')).map((t) => t.name)).not.toContain('rename_pc');
    expect(systemPrompt(new Date('2026-11-22T10:00:00'), other, routeTopics('open youtube and play a song'))).not.toContain('is rename_pc');
  });

  it('load_tools pcfix switches the fixing tools on, while load_tools pc still means the apps and files a website request set aside (the two names were once the same word)', () => {
    const fix = parseGroups('pcfix');
    expect([...fix.groups]).toEqual(['pcfix']);
    expect(fix.pc).toBe(false);
    expect(fix.unknown).toEqual([]);
    const held = parseGroups('pc');
    expect(held.pc).toBe(true);
    expect(held.groups.has('pcfix')).toBe(false);
    // "all" brings both
    const all = parseGroups('all');
    expect(all.groups.has('pcfix')).toBe(true);
    expect(all.pc).toBe(true);
  });
});
