/**
 * What is said aloud is not always what is shown. The chat shows "Brooo, you're cooked 😭 Go recharge." and a speech engine would read the face out, or stop on it; so the words are spoken and
 * the pictures are left out. Pure.
 */
export function forSpeech(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
