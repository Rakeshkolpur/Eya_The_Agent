import { BrowserWindow } from 'electron';
import type { SocialImageSpec } from '@main/tools/impl/socialTools';

/**
 * A clean picture for a post: a headline (and a second line and a footer) on a plain coloured card, drawn by Eya's own hidden window and saved as a PNG. Only the person's words are drawn —
 * nothing from the internet, no faces, no logos. The page it draws is plain HTML and CSS with scripts switched off.
 */
const THEMES: Readonly<Record<SocialImageSpec['theme'], { readonly bg: string; readonly ink: string; readonly soft: string; readonly accent: string }>> = {
  dark: { bg: 'linear-gradient(135deg,#0f172a 0%,#1e293b 100%)', ink: '#f8fafc', soft: '#cbd5e1', accent: '#38bdf8' },
  light: { bg: 'linear-gradient(135deg,#f8fafc 0%,#e2e8f0 100%)', ink: '#0f172a', soft: '#475569', accent: '#2563eb' },
  blue: { bg: 'linear-gradient(135deg,#1d4ed8 0%,#0ea5e9 100%)', ink: '#ffffff', soft: '#e0f2fe', accent: '#fde047' },
  warm: { bg: 'linear-gradient(135deg,#7c2d12 0%,#c2410c 100%)', ink: '#fff7ed', soft: '#fed7aa', accent: '#fde68a' },
};

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The card as a web page (exported so its words and escaping can be tested without a window). */
export function socialImageHtml(spec: SocialImageSpec): string {
  const t = THEMES[spec.theme];
  const size = spec.title.length <= 40 ? 84 : spec.title.length <= 80 ? 66 : 52;
  const scale = spec.width >= 1200 ? 1 : spec.width / 1200;
  const px = (n: number): string => `${Math.round(n * scale * (spec.height > spec.width * 0.9 ? 1.1 : 1))}px`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${spec.width}px;height:${spec.height}px;overflow:hidden}
body{background:${t.bg};font-family:'Segoe UI','Nirmala UI',Arial,sans-serif;color:${t.ink};display:flex;flex-direction:column;justify-content:center;padding:${px(90)};box-sizing:border-box}
.bar{width:${px(110)};height:${px(10)};background:${t.accent};border-radius:6px;margin-bottom:${px(40)}}
h1{margin:0;font-size:${px(size)};line-height:1.15;font-weight:700;letter-spacing:-0.5px;word-wrap:break-word}
p{margin:${px(28)} 0 0;font-size:${px(34)};line-height:1.35;color:${t.soft}}
.foot{position:absolute;left:${px(90)};bottom:${px(50)};font-size:${px(26)};color:${t.soft}}
</style></head><body><div class="bar"></div><h1>${esc(spec.title)}</h1>${spec.subtitle !== '' ? `<p>${esc(spec.subtitle)}</p>` : ''}${spec.footer !== '' ? `<div class="foot">${esc(spec.footer)}</div>` : ''}</body></html>`;
}

/** Draws the card in a window that is never shown, and returns the PNG. */
export async function renderSocialImage(spec: SocialImageSpec): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: spec.width,
    height: spec.height,
    useContentSize: true,
    frame: false,
    webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(socialImageHtml(spec))}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: spec.width, height: spec.height });
    const size = shot.getSize();
    // (a screen with a scale of 125% draws more pixels: the card is always exactly the size asked for)
    return (size.width === spec.width && size.height === spec.height ? shot : shot.resize({ width: spec.width, height: spec.height, quality: 'best' })).toPNG();
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
