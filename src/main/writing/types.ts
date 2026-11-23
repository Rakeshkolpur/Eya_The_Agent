/**
 * Writing Watch: while the user drafts (a petition in Word, a note anywhere), Eya reads what is being written and quietly points out
 * slips — never changes anything on her own. These are the shapes shared by the checks, the watcher and the card that shows them.
 */

export type FindingKind =
  | 'repeated_word'
  | 'spacing'
  | 'punctuation'
  | 'brackets'
  | 'quotes'
  | 'capital'
  | 'date'
  | 'number'
  | 'amount'
  | 'name'
  | 'case_number'
  | 'numbering'
  | 'term'
  | 'spelling'
  | 'ai';

/** A slip, as a check finds it in some text. */
export interface RawFinding {
  readonly kind: FindingKind;
  /** What is wrong, in plain words. */
  readonly message: string;
  /** The words around the slip, as written (short). */
  readonly excerpt: string;
  /**
   * Exact text in the paragraph to replace, and what to put there instead — only when the fix is certain. Without it the user decides.
   */
  readonly replace?: { readonly from: string; readonly to: string };
}

/** A slip in a particular paragraph of the document being written (1-based). */
export interface Finding extends RawFinding {
  /** Stable for the same slip in the same words, so a dismissed one stays dismissed. */
  readonly id: string;
  readonly paragraph: number;
}

/** What a source of text hands over: the document as paragraphs, and where the cursor is. */
export interface DocumentText {
  /** Which kind of program it came from. */
  readonly app: 'word' | 'other';
  /** The window or file name, for the card ("Watching Word · Petition.docx"). Never logged. */
  readonly title: string;
  /** The program's process name when it is not Word ("notepad"), so the card can say which program is being watched. */
  readonly program?: string;
  readonly paragraphs: readonly string[];
  /** 1-based paragraph the cursor is in; 0 when unknown. */
  readonly active: number;
  /**
   * Words the program's own spell checker flagged, near the cursor (Word does this on this PC, locally). Absent when there is no
   * checker to ask.
   */
  readonly misspelled?: ReadonlyArray<{ readonly paragraph: number; readonly word: string; readonly suggestions: readonly string[] }>;
}

/** Something the watcher reads text from. */
export interface TextSource {
  readonly name: string;
  /** The text as it is now, or null when this source has nothing (the program is not running, no document is open). */
  read(): Promise<DocumentText | null>;
  /**
   * The words the program's own spell checker doubts in these paragraphs (only asked for once the writing has paused). Each target carries
   * the paragraph's words as they were read: a paragraph that is not that any more (the user kept typing) is skipped, never mistaken.
   */
  spell?(targets: ReadonlyArray<{ readonly paragraph: number; readonly text: string }>): Promise<NonNullable<DocumentText['misspelled']>>;
  /**
   * Replaces text in a paragraph (a fix the user clicked). `text` is the paragraph as it was read: if the paragraph is not that any more
   * nothing is changed. Resolves false when the text is no longer there.
   */
  replace?(paragraph: number, from: string, to: string, text: string): Promise<boolean>;
  close?(): void;
}
