/**
 * Working out what is wrong with the microphone from what Windows says about it. Pure: the facts come in, plain sentences and the fixes that apply go out.
 */

export interface MicDevice {
  readonly name: string;
  /** Windows' state: 1 working, 2 turned off, 4 not present, 8 unplugged (other bits can ride along). */
  readonly state: number;
}

export interface MicFacts {
  /** Windows Settings, Privacy, Microphone: "Allow", "Deny" or null when not set. */
  readonly accessUser: string | null;
  readonly accessMachine: string | null;
  /** The switch for desktop programs ("Let desktop apps access your microphone"). */
  readonly accessDesktopApps: string | null;
  /** A policy (a work or school rule) that forces microphone access off. */
  readonly policyBlocks: boolean;
  /** Programs that have the microphone open right now. */
  readonly usedNow: readonly string[];
  /** Programs the person has blocked from the microphone. */
  readonly blockedApps: readonly string[];
  readonly devices: readonly MicDevice[];
  /** The microphone Windows uses by default; null when there is none. */
  readonly defaultDevice: { readonly name: string; readonly muted: boolean; readonly volume: number } | null;
  readonly audioService: string;
  readonly endpointBuilder: string;
}

export type MicFix = 'privacy' | 'unmute' | 'volume' | 'restart_audio';

export interface MicDiagnosis {
  readonly findings: string[];
  readonly fixes: MicFix[];
  /** Nothing is wrong on the Windows side: the problem is in the program that cannot hear (its own microphone choice), or in the hardware. */
  readonly windowsLooksFine: boolean;
}

export const LOW_VOLUME = 10;

const stateWords = (state: number): string => {
  if ((state & 8) !== 0) return 'unplugged';
  if ((state & 4) !== 0) return 'not present';
  if ((state & 2) !== 0) return 'turned off';
  if ((state & 1) !== 0) return 'working';
  return 'not working';
};

/** A device state that is not one of the known ones (Windows adds high bits, for example for Stereo Mix, which only repeats what the speakers play). */
export const isWorking = (d: MicDevice): boolean => (d.state & 0xf) === 1;

export function diagnoseMic(f: MicFacts): MicDiagnosis {
  const findings: string[] = [];
  const fixes: MicFix[] = [];

  if (f.audioService.toLowerCase() !== 'running') {
    findings.push(`The Windows Audio service is ${f.audioService === '' ? 'not running' : f.audioService.toLowerCase()}, so no sound or microphone works. Restarting it usually fixes this.`);
    fixes.push('restart_audio');
  }
  if (f.endpointBuilder.toLowerCase() !== 'running' && !fixes.includes('restart_audio')) {
    findings.push('The Windows Audio Endpoint Builder service is not running, so the microphone is not seen. Restarting the audio service fixes this.');
    fixes.push('restart_audio');
  }

  if (f.policyBlocks) {
    findings.push('A rule on this PC (a work or school policy) blocks microphone access for programs. That rule overrides the Settings switch, so I cannot turn it back on from here.');
  } else if ((f.accessUser ?? 'Allow').toLowerCase() === 'deny' || (f.accessMachine ?? 'Allow').toLowerCase() === 'deny') {
    findings.push('Microphone access is switched OFF in Windows Settings, Privacy, Microphone, so no program can hear you. That is the problem.');
    fixes.push('privacy');
  } else if ((f.accessDesktopApps ?? 'Allow').toLowerCase() === 'deny') {
    findings.push('"Let desktop apps access your microphone" is switched OFF in Windows Settings, Privacy, Microphone, so ordinary programs (Zoom, Teams, Chrome, WhatsApp Desktop) cannot hear you.');
    fixes.push('privacy');
  }

  const working = f.devices.filter(isWorking).filter((d) => !/stereo mix/i.test(d.name));
  if (f.devices.length === 0) {
    findings.push('Windows does not see any microphone at all. If you use a headset, plug it in again; if it is the laptop microphone, the driver may be missing or switched off.');
  } else if (working.length === 0) {
    const list = f.devices.filter((d) => !/stereo mix/i.test(d.name)).map((d) => `${d.name} (${stateWords(d.state)})`).join(', ');
    findings.push(`None of the microphones is working right now: ${list}. Plug the headset in again, or turn the microphone on in Windows Settings, System, Sound.`);
  }

  const d = f.defaultDevice;
  if (d === null) {
    if (working.length > 0) findings.push(`There is a working microphone (${working.map((w) => w.name).join(', ')}), but Windows has no default one chosen. Choose it in Windows Settings, System, Sound, Input.`);
  } else {
    if (d.muted) {
      findings.push(`The microphone ${d.name} is MUTED in Windows, so nobody can hear you. That is the problem.`);
      fixes.push('unmute');
    }
    if (d.volume < LOW_VOLUME) {
      findings.push(`The microphone ${d.name} is turned almost all the way down (${d.volume}%), so it picks up almost nothing.`);
      fixes.push('volume');
    }
  }

  if (f.usedNow.length > 0) findings.push(`${f.usedNow.join(', ')} ${f.usedNow.length === 1 ? 'has' : 'have'} the microphone open right now. If another program cannot use it, close ${f.usedNow.length === 1 ? 'that one' : 'those'} first.`);
  if (f.blockedApps.length > 0) findings.push(`You have blocked ${f.blockedApps.join(', ')} from the microphone (Windows Settings, Privacy, Microphone). If one of them is the program that cannot hear you, allow it there.`);

  const windowsLooksFine = findings.filter((x) => !/has the microphone open|have the microphone open|You have blocked/.test(x)).length === 0;
  if (windowsLooksFine) {
    const mic = d !== null ? `${d.name}, not muted, volume ${d.volume}%` : working.map((w) => w.name).join(', ');
    findings.unshift(`Nothing is wrong on the Windows side: the microphone (${mic}) is working and allowed. If one program cannot hear you, open ITS own settings and choose this microphone there.`);
  }
  return { findings, fixes, windowsLooksFine };
}
