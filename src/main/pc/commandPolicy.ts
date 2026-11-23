/**
 * What the "run a Windows command" tool will do with a PowerShell command. Pure.
 *
 * Three answers. `refuse`: never, with the reason (turning off Windows' protection, wiping drives, accounts, downloads that run, hiding what a command does). `read_only`: only looks (Get-*, ipconfig,
 * tasklist …), so it runs at once. `changes`: anything else, which is shown to the person word for word and runs only after their yes (and, if it needs administrator rights, Windows' own
 * permission box, which only they can answer).
 *
 * This is a safety net for a model's mistakes and for text on a web page that tries to steer it: it is deliberately strict, not clever. A command it does not understand is a `changes`.
 */

export type CommandVerdict = { readonly verdict: 'refuse'; readonly why: string } | { readonly verdict: 'read_only' } | { readonly verdict: 'changes' };

export const MAX_COMMAND_CHARS = 4000;

const REFUSE: ReadonlyArray<readonly [RegExp, string]> = [
  [/(set|add|remove)-mppreference|disable(realtimemonitoring|behaviormonitoring|ioavprotection|scriptscanning)|\bwindefend\b|\bsense\b.*(stop|disable)|windows ?defender|securityhealth|\bwscsvc\b/i, "Windows Security (Defender) is the PC's protection: turning it off is yours to do in Windows Security, not mine"],
  [/advfirewall|netfirewall|\bmpssvc\b|firewall.*\b(off|disable|false)\b|\b(off|disable|false)\b.*firewall/i, "the firewall is the PC's protection: changing it is yours to do in Windows Security"],
  [/enablelua|consentpromptbehavior|promptonsecuredesktop|enablesmartscreen|smartscreen|filteradministratortoken|localaccounttokenfilterpolicy/i, "user-account control and SmartScreen are the PC's protection: changing them is yours to do"],
  [/\\policies\\|hklm:?\\+software\\+policies/i, "policy settings change how Windows protects and manages the PC, so I do not write them"],
  [/\b(set-itemproperty|new-itemproperty|remove-itemproperty|new-item|remove-item|set-item|reg(\.exe)?\s+(add|delete|import|load)|regedit)\b[^\n;|]*(hklm|hkey_local_machine)/i, 'the machine-wide registry changes how Windows itself behaves, so I do not write it'],
  [/\b(diskpart|format-volume|clear-disk|initialize-disk|remove-partition|new-partition|resize-partition|set-partition|set-disk|bcdedit|bootrec|manage-bde|bitlocker|enable-bitlocker|disable-bitlocker|vssadmin|wbadmin|diskshadow|cipher\s+\/w|format\s+[a-z]:)\b/i, 'it can wipe or lock a drive, or remove restore points'],
  [/\b(net1?\s+(user|localgroup|accounts)|new-localuser|set-localuser|remove-localuser|enable-localuser|disable-localuser|add-localgroupmember|remove-localgroupmember)\b/i, 'user accounts are yours to manage'],
  [/\b(schtasks|register-scheduledtask|new-scheduledtask|set-scheduledtask|new-service|sc(\.exe)?\s+(create|config|delete))\b/i, 'a task or service that starts by itself can keep running without you knowing'],
  [/\b(invoke-expression|iex)\b/i, 'running text as a command hides what is being run'],
  [/(downloadstring|downloadfile|downloaddata|invoke-webrequest|\biwr\b|invoke-restmethod|\birm\b|start-bitstransfer|net\.webclient|\bcurl(\.exe)?\b|\bwget\b|certutil[^\n;|]*-urlcache|bitsadmin)/i, 'it downloads from the internet: use download_file or install_program, which check what they fetch'],
  [/-enc(odedcommand)?\b|frombase64string|\[convert\]::|\[system\.convert\]::/i, 'a command that is encoded hides what is being run'],
  [/start-process[^\n;|]*-verb\s+runas|\brunas\b/i, 'rights are only ever asked for through the permission box of this tool, which you answer'],
  [/\b(powershell(\.exe)?|pwsh(\.exe)?|cmd(\.exe)?)\b\s+(\/c|\/k|-c|-command|-file|-noprofile|-nop|-ep|-executionpolicy)/i, 'a shell inside a shell hides what is being run'],
  [/\b(shutdown|restart-computer|stop-computer)\b/i, 'use restart_computer or shutdown_computer, which ask you first'],
  [/\b(clear-eventlog|wevtutil\s+cl|remove-eventlog)\b/i, "clearing Windows' logs hides what happened"],
  [/(stop-process|taskkill)[^\n;|]*\b(csrss|winlogon|lsass|services|svchost|wininit|smss|explorer|dwm)\b/i, 'stopping a core part of Windows can crash the PC'],
  [/\bset-executionpolicy\b/i, 'the script policy is part of the PC protection'],
  [/\b(remove-item|del|erase|rd|rmdir|rm)\b[^\n;|]*(\bc:\\windows\b|\bc:\\program files|\bc:\\programdata\b|system32|%systemroot%|\$env:(windir|systemroot|programfiles|programdata)\b|(^|[\s'"])[a-z]:\\?(?=[\s'";|]|$)|\bc:\\users\\?(?=[\s'";|]|$)|\bc:\\users\\[^\\\s'";|]+\\?(?=[\s'";|]|$)|\$env:(userprofile|homepath)\\?(?=[\s'";|]|$)|\\\*(\s|$))/i, 'it deletes a whole system or personal folder'],
  [/[\0]/, 'it contains a control character'],
];

/** Commands that only look. A command qualifies when every cmdlet in it starts with one of these verbs and nothing in it can run, write or download. */
const READ_VERBS = /^(get|test|measure|select|where|sort|format|group|compare|resolve|convertto|convertfrom|out-string|out-host|write-output|write-host|foreach-object|join-path|split-path)\b/i;

const NATIVE_READ: ReadonlyArray<RegExp> = [
  /^ipconfig(\s+\/(all|displaydns))?$/i,
  /^(systeminfo|tasklist|whoami|hostname|getmac|driverquery|nslookup|ping|tracert|pathping)(\s|$)/i,
  /^netstat(\s|$)/i,
  /^powercfg\s+\/(list|query|a|getactivescheme|requests|devicequery|batteryreport\b)/i,
  /^wmic\s+[a-z]+\s+(get|list)\b/i,
  /^(arp\s+-a|route\s+print|nbtstat\s+-[a-z])$/i,
  /^sc(\.exe)?\s+(query|queryex|qc)\b/i,
  /^reg(\.exe)?\s+query\b/i,
  /^where(\.exe)?\s/i,
  /^findstr(\s|$)/i,
  /^fsutil\s+volume\s+diskfree\b/i,
];

/** Things that could run, write or reach out, even inside a command that only starts with Get-. */
const NOT_READ_ONLY = /(::|&|>|`|\$\(|\.\s*[a-z]+\s*\(|invoke-|start-|stop-|remove-|set-|new-|add-|out-file|out-printer|out-null\b.*\|\s*[a-z]|get-credential|convertto-securestring|import-|export-|enable-|disable-|restart-|clear-|copy-|move-|rename-|register-|unregister-|install-|uninstall-|update-|save-|send-|write-eventlog|\bsc(\.exe)?\s+(start|stop|pause)|\|\s*(sh|bash|cmd|powershell))/i;

/** The short names of the same read-only commands (select, where, sort, ft, gci, gps …). */
const READ_ALIASES = /^(select|where|sort|ft|fl|fw|measure|group|gci|ls|dir|gps|gsv|gwmi|gcim|gc|gp|gi|gcm|echo|cat|type)$/i;

const stripAssignment = (s: string): string => s.replace(/^\$[a-z_][a-z0-9_]*\s*=\s*/i, '');

export function checkCommand(script: string): CommandVerdict {
  const text = script.trim();
  if (text === '') return { verdict: 'refuse', why: 'it is empty' };
  if (text.length > MAX_COMMAND_CHARS) return { verdict: 'refuse', why: `it is longer than ${MAX_COMMAND_CHARS} characters` };
  for (const [re, why] of REFUSE) if (re.test(text)) return { verdict: 'refuse', why };

  if (NOT_READ_ONLY.test(text)) return { verdict: 'changes' };
  const segments = text.split(/[;|\n\r]+/).map((s) => stripAssignment(s.trim())).filter((s) => s !== '');
  if (segments.length === 0) return { verdict: 'changes' };
  for (const seg of segments) {
    // the body of a Where-Object / ForEach-Object block is not a command of its own: its words are properties and comparisons
    const head = seg.replace(/^[{(]+/, '').trim();
    if (head.startsWith('$_') || head.startsWith('$') || head.startsWith('}') || head === '') continue;
    const first = head.split(/\s+/)[0] ?? '';
    if (/^[a-z]+-[a-z]+$/i.test(first)) {
      if (!READ_VERBS.test(first)) return { verdict: 'changes' };
      continue;
    }
    if (READ_ALIASES.test(first)) continue;
    if (NATIVE_READ.some((re) => re.test(head))) continue;
    return { verdict: 'changes' };
  }
  return { verdict: 'read_only' };
}
