import type { EyaControl } from '../control';

/** Whether Eya is working on a task right now: her browser on a job, a task she keeps that is running, or a tool in use. A plain chat answer is not one. */
export function isTaskActive(c: EyaControl): boolean {
  const p = c.browserPanel;
  const browserBusy = p !== null && (p.status === 'working' || p.status === 'waiting_you' || p.paused || p.takenOver);
  const running = (c.tasks?.items ?? []).some((t) => t.state === 'running');
  return browserBusy || running || c.agent.working;
}
