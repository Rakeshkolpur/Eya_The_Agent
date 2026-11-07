import React from 'react';

const PATHS = {
  home: 'M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  screen: 'M3 5h18v11H3z M8 20h8 M12 16v4',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3 2',
  memory: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3z M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6 M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  folder: 'M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  settings: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 4v6 M9 14v6',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3',
  send: 'M4 12l16-8-6 16-3-7z',
  minus: 'M5 12h14',
  close: 'M6 6l12 12 M18 6L6 18',
  expand: 'M14 3h7v7 M10 21H3v-7 M21 3l-8 8 M3 21l8-8',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  user: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M4 21a8 8 0 0 1 16 0',
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c3 3.5 3 14.5 0 18 M12 3c-3 3.5-3 14.5 0 18',
  file: 'M6 3h8l5 5v13H6z M14 3v5h5',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  check: 'M5 12l5 5 9-10',
  plus: 'M12 5v14 M5 12h14',
  repeat: 'M17 2l4 4-4 4 M3 11V9a3 3 0 0 1 3-3h15 M7 22l-4-4 4-4 M21 13v2a3 3 0 0 1-3 3H3',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  lock: 'M6 11h12v10H6z M8 11V7a4 4 0 0 1 8 0v4',
  info: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 11v6 M12 7.5v.5',
  image: 'M4 5h16v14H4z M4 16l5-5 4 4 3-3 4 4 M9 9.5h.01',
  search: 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4',
  more: 'M12 5h.01 M12 12h.01 M12 19h.01',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v5H5V6h5',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6 3 3 0 1 0 0-6z',
  eyeoff: 'M3 3l18 18 M10.6 6.2A9.6 9.6 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8 M6.6 7.6C3.9 9.4 2 12 2 12s4 6 10 6a9.7 9.7 0 0 0 4-.9 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  tasks: 'M5 4h14v17H5z M9 4V2h6v2 M9 11l2 2 4-4 M9 17h6',
  agents: 'M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  knowledge: 'M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z M20 4h-4a3 3 0 0 0-2 .8 M20 4v14h-4',
  plug: 'M9 3v5 M15 3v5 M6 8h12v3a6 6 0 0 1-12 0z M12 17v4',
  automation: 'M4 12a8 8 0 0 1 14-5l2 2 M20 4v5h-5 M20 12a8 8 0 0 1-14 5l-2-2 M4 20v-5h5',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7z M10 20a2 2 0 0 0 4 0',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z M12 2v2 M12 20v2 M4.2 4.2l1.4 1.4 M18.4 18.4l1.4 1.4 M2 12h2 M20 12h2 M4.2 19.8l1.4-1.4 M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  clip: 'M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7',
  layout: 'M4 4h16v16H4z M4 9h16 M10 9v11',
  split: 'M3 5h18v14H3z M12 5v14',
  panel: 'M3 5h18v14H3z M9 5v14',
  chevron: 'M9 6l6 6-6 6',
  pause: 'M8 5v14 M16 5v14',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  reload: 'M20 12a8 8 0 1 1-2.3-5.7 M20 4v5h-5',
  forward: 'M5 12h14 M13 6l6 6-6 6',
  hand: 'M8 12V5a1.5 1.5 0 0 1 3 0v6 M11 11V3.5a1.5 1.5 0 0 1 3 0V11 M14 11V5a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7c-3 0-4-1-6-4l-1.5-3a1.5 1.5 0 0 1 2.5-1.5L8 14',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  chart: 'M4 20V10 M10 20V4 M16 20v-8 M22 20H2',
  audio: 'M9 18V6l10-2v12 M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z M19 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0z',
  film: 'M4 5h16v14H4z M10 9l5 3-5 3z',
  restore: 'M9 4v5H4 M4 9l6-6 M15 20v-5h5 M20 15l-6 6',
  panelright: 'M3 5h18v14H3z M15 5v14',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  winmax: 'M5.5 5.5h13v13h-13z',
  winrestore: 'M8.5 8.5h10v10h-10z M5.5 15.5v-10h10',
} as const;

export type IconName = keyof typeof PATHS;

/** A small outline icon that takes its colour from the text around it. */
export function Icon({ name, size = 18 }: { name: IconName; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
