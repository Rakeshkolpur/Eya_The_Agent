/**
 * Eya never announces herself in a live chat ("Hi, I'm Eya, Rakesh's assistant"): she just chats. She says who she is only when the other person ASKS — "who are you?", "who is this?",
 * "are you a bot?", "is this Rakesh?" — and then she says it honestly (that part lives in the prompts and in `fallbackLine('human')`; this file never touches an answer to such a question).
 *
 * The prompts say so, but a model slips (a small one most often), so the words are checked here too: `stripSelfIntro` takes an unasked introduction out of a reply. It only ever REMOVES
 * words, so it cannot make anything up.
 *
 * (22 Nov 2026: "When live chat, Eya never ever said in starting I am Rakesh's assistant, just directly go ahead and chat; if the user asks who you are, then tell.")
 */

/** The other person is asking who she is, what she is, or whether she is a machine / a real person / the owner. */
export function asksWhoSheIs(text: string, owner = ''): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t === '') return false;
  const o = owner.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: RegExp[] = [
    /\bwho\s*(?:are|r|re)\s*(?:you|u|ya|yu)\b/i,
    /\bwho(?:'s|s|\s+is|\s+this)\s+(?:this|that|it|there|messaging|texting|writing|typing|chatting)\b/i,
    /\bwho\s+(?:am\s+i|i\s+am)\s+(?:talking|chatting|speaking|texting|messaging)\b/i,
    /\bwho\s+(?:is|are)\s+(?:messaging|texting|writing|typing|chatting|talking)\b/i,
    /\bwho\s+(?:wrote|sent|typed)\s+(?:this|that|these|it)\b/i,
    /\bwhat\s*(?:are|r|re)\s*(?:you|u)\b(?!\s+(?:doing|up|going|saying|talking|eating|watching|reading|thinking|planning|having|cooking|wearing|looking|trying|working|studying|upto|up to|do\b))/i,
    /\b(?:what(?:'s|s|\s+is)|whats|tell\s+me)\s+(?:your|ur|ya)\s+name\b/i,
    /\byour\s+name\b/i,
    /\b(?:are|r)\s*(?:you|u)\s+(?:a\s+|an\s+|the\s+)?(?:real|human|person|people|man|woman|girl|boy|bot|robot|chatbot|ai|a\.i\.|machine|computer|program|software|assistant|eya)\b/i,
    /\b(?:is\s+this|is\s+that)\s+(?:a\s+)?(?:real|human|person|bot|robot|ai|machine)\b/i,
    // (looser forms: it is better to allow an answer than to miss a question about her — a false "yes" only lets her answer honestly, it never makes her announce herself)
    /\bwho\b[^.?!]{0,30}\b(?:are|r|re)\s*(?:you|u|ya)\b/i,
    /\b(?:are|r)\s*(?:you|u)\s+(?:really|actually|even|truly|just)\s+(?:a\s+|an\s+)?(?:real|human|person|bot|robot|ai|machine|chatbot)\b/i,
    /\b(?:talking|chatting|speaking|texting)\s+(?:to|with)\s+(?:a\s+|an\s+)?(?:bot|robot|ai|machine|human|real\s+person|person|chatbot)\b/i,
    /\b(?:are|r)\s*(?:you|u)\s+(?:chat\s*gpt|gpt|gemini|siri|alexa|claude|copilot|an?\s+app)\b/i,
    /\bwho\s+(?:made|built|created|programmed|owns|runs|trained)\s+(?:you|u|this)\b/i,
    /\b(?:introduce\s+yourself|tell\s+me\s+about\s+yourself|about\s+yourself)\b/i,
    /\b(?:real\s+person|real\s+human)\s+(?:or|\?)/i,
    /\b(?:human|person|real)\s+or\s+(?:a\s+)?(?:bot|ai|robot|machine)\b/i,
    /\b(?:bot|robot|ai)\s+or\s+(?:a\s+)?(?:human|person|real)\b/i,
    // (romanised Hindi / Telugu / Tamil, and the scripts themselves)
    /\b(?:aap|ap|tum|tu|aap\s+log)\s+kaun\b/i,
    /\bkaun\s+(?:ho|hai|hain|bol|hu|ho\s+tum|ho\s+aap|baat)\b/i,
    /\bye\s+kaun\b/i,
    /\b(?:aapka|apka|tumhara|tera|aapki|tumhari)\s+(?:naam|nam)\b/i,
    /\b(?:nuvvu|nuvu|nuvv|meeru|miru|mee|nuv)\s+evaru\b/i,
    /\bevaru\s+(?:nuvvu|nuvu|nuvv|meeru|miru|ra|andi|ee)\b/i,
    /\b(?:ee|ii)\s+evaru\b/i,
    /\b(?:nee|mee|ni)\s+peru\b/i,
    /\b(?:neenga|ningal|nee|nenga)\s+yaar(?:u)?\b/i,
    /\b(?:ni|nee|unga)\s+(?:peyar|per)\b/i,
    /(?:आप|तुम|तू)\s*कौन/u,
    /कौन\s*(?:हो|हैं|है)/u,
    /(?:మీరు|నువ్వు|నీవు|నువు)\s*ఎవరు/u,
    /ఎవరు\s*(?:మీరు|నువ్వు|నువు)/u,
    /(?:நீங்கள்|நீ)\s*யார்/u,
  ];
  if (patterns.some((p) => p.test(t))) return true;
  // ("is this Rakesh?", "are you Rakesh?", "am I talking to Rakesh?")
  if (o !== '' && new RegExp(`\\b(?:is\\s+this|are\\s+(?:you|u)|am\\s+i\\s+(?:talking|chatting|speaking)\\s+(?:to|with))\\s+${o}\\b`, 'i').test(t)) return true;
  return false;
}

/**
 * The person's own instruction for THIS chat names the introduction in so many words ("introduce yourself as my assistant", "tell them you are Eya, my assistant"): then it is allowed,
 * because they asked for it in that chat. A bare "you can introduce yourself" is NOT enough — the standing rule (22 Nov 2026) is that she never introduces herself by herself.
 */
export function purposeAsksIntro(purpose: string | undefined): boolean {
  const p = (purpose ?? '').toLowerCase().replace(/\s+/g, ' ');
  if (p === '') return false;
  return (
    /\b(?:introduce|present)\s+yourself\s+as\b/.test(p) ||
    /\b(?:say|tell|let)\b[^.!?]{0,30}\b(?:that\s+)?you(?:'re|\s+are)\s+(?:eya|my\s+assistant|his\s+assistant|her\s+assistant|an?\s+(?:ai\s+)?assistant)\b/.test(p) ||
    /\bsay\s+who\s+you\s+are\b/.test(p)
  );
}

// "I'm Eya", "I am Eya", "this is Eya", "my name is Eya", "Eya here", "it's Eya" — with the role that usually follows ("…, Rakesh's assistant", "…, an AI assistant").
const ROLE = String.raw`(?:\s*[,;:-]?\s*(?:and\s+)?(?:(?:I'?m|I\s+am)\s+)?(?:an?\s+|the\s+|his\s+|her\s+|their\s+|your\s+)?(?:(?:AI|virtual|digital|personal|smart)\s+)?(?:[\p{L}]+['’]s\s+)?(?:(?:AI|virtual|digital|personal)\s+)?(?:assistant|helper|bot|chatbot|secretary)(?:\s+(?:of|for|to)\s+[\p{L}]+)?(?:\s*,?\s*(?:writing|chatting|messaging|texting|here)\s+(?:to\s+you\s+)?(?:on|for)\s+(?:his|her|their|[\p{L}]+['’]s)\s+behalf)?)?`;
const INTRO_CLAUSE = new RegExp(String.raw`(?:^|(?<=[\s,;:!.?]))(?:(?:hi|hello|hey|hii|hiii|namaste|namaskaram)[\s,!.-]+)?(?:(?:I'?m|I\s+am|this\s+is|it'?s|my\s+name\s+is|call\s+me|myself|(?:you\s+are\s+)?(?:talking|chatting|speaking)\s+(?:to|with))\s+Eya\b|Eya\s+here\b)${ROLE}[s,;:.!?-]*`, 'giu');
// (a sentence that is only the role: "I'm Rakesh's assistant." / "I am an AI assistant who writes for Rakesh." — without the name)
const ROLE_SENTENCE = /^(?:(?:hi|hello|hey)[\s,!.-]+)?(?:I'?m|I\s+am|this\s+is)\s+(?:an?\s+|the\s+)?(?:(?:AI|virtual|digital|personal|smart)\s+)?(?:[\p{L}]+['’]s\s+)?(?:AI\s+)?(?:assistant|helper|bot|chatbot|secretary)\b[^.!?]*[.!?]?$/iu;

const GREETING_ONLY = /^(?:hi|hello|hey|hii|hiii|namaste|namaskaram)\b[\s,!.-]*$/i;
const letters = (s: string): number => (s.match(/\p{L}/gu) ?? []).length;

/**
 * The reply without an unasked introduction. A greeting that came with it stays ("Hi, I'm Eya, Rakesh's assistant. How are you?" → "Hi! How are you?"); what is left is tidied.
 * Returns the text itself when there is nothing to take out, and an empty string when nothing but the introduction (and a greeting) was written.
 */
export function stripSelfIntro(text: string): string {
  const original = text.replace(/\s+/g, ' ').trim();
  if (original === '') return text;
  const had = new RegExp(INTRO_CLAUSE.source, INTRO_CLAUSE.flags);
  const greeting = /^(?:hi|hello|hey|hii|hiii|namaste|namaskaram)\b/i.exec(original)?.[0] ?? '';
  let t = original.replace(had, ' ');
  // sentences that are now only a role ("Rakesh's assistant.") or were a role sentence without the name
  const parts = t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== '');
  const kept = parts.filter((s) => !ROLE_SENTENCE.test(s) && !/^(?:[\p{L}]+['’]s\s+)?(?:AI\s+)?assistant[.!?]?$/iu.test(s));
  const changed = t !== original || kept.length !== parts.length;
  if (!changed) return text;
  t = kept
    .join(' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/([,;:-])\s*([.!?])/g, '$2')
    .replace(/^[\s,;:.!?-]+(?=\p{L}|\p{Extended_Pictographic})/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // (the greeting survives: it was said, and a reply without it can start abruptly)
  if (greeting !== '' && !/^(?:hi|hello|hey|hii|hiii|namaste|namaskaram)\b/i.test(t)) t = `${greeting.charAt(0).toUpperCase()}${greeting.slice(1).toLowerCase()}! ${t}`.trim();
  t = t.replace(/^((?:hi|hello|hey|hii|hiii|namaste|namaskaram))[.,]\s+/i, '$1! ');
  if (GREETING_ONLY.test(t) || letters(t.replace(/^(?:hi|hello|hey|hii|hiii|namaste|namaskaram)\b/i, '')) < 2) return '';
  return t;
}
