import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_ATTACHMENTS, attachmentInfo, whyNotAttachable } from '../../shared/attachments';
import type { AttachmentKind, AttachmentRef } from '../../shared/attachments';

export interface DraftAttachment {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly kind: AttachmentKind;
  /** preparing: being found on disk or kept (a pasted picture). */
  readonly state: 'preparing' | 'ready';
  readonly path?: string;
  /** A small picture of an image, for the preview. */
  readonly preview?: string;
}

export interface AttachmentNote {
  readonly id: number;
  readonly text: string;
}

const EXT_BY_TYPE: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

/** What the person is attaching to the message being written: previews, what is wrong with a file (said, not hidden), and what is ready to send. */
export function useAttachments(): {
  readonly items: readonly DraftAttachment[];
  readonly notes: readonly AttachmentNote[];
  readonly add: (files: readonly File[]) => void;
  readonly remove: (id: number) => void;
  readonly clear: () => void;
  readonly dismissNote: (id: number) => void;
  readonly say: (text: string) => void;
  readonly preparing: boolean;
  readonly ready: readonly AttachmentRef[];
} {
  const [items, setItems] = useState<readonly DraftAttachment[]>([]);
  const [notes, setNotes] = useState<readonly AttachmentNote[]>([]);
  const itemsRef = useRef<readonly DraftAttachment[]>([]);
  const nextId = useRef(1);

  const set = useCallback((next: readonly DraftAttachment[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const say = useCallback((text: string) => setNotes((n) => [...n.filter((x) => x.text !== text), { id: nextId.current++, text }].slice(-4)), []);

  const drop = useCallback(
    (id: number) => {
      const gone = itemsRef.current.find((i) => i.id === id);
      if (gone?.preview !== undefined) URL.revokeObjectURL(gone.preview);
      set(itemsRef.current.filter((i) => i.id !== id));
    },
    [set],
  );

  const add = useCallback(
    (files: readonly File[]) => {
      let current = itemsRef.current;
      const toPrepare: Array<[DraftAttachment, File]> = [];
      for (const file of files) {
        const name = file.name !== '' ? file.name : `pasted-${Date.now()}.${EXT_BY_TYPE[file.type] ?? 'png'}`;
        const problem = whyNotAttachable(name, file.size);
        if (problem !== null) {
          say(`${name}: ${problem}`);
          continue;
        }
        if (current.length >= MAX_ATTACHMENTS) {
          say(`Only ${MAX_ATTACHMENTS} files can go in one message.`);
          break;
        }
        if (current.some((i) => i.name === name && i.size === file.size)) continue;
        const info = attachmentInfo(name);
        if (info === null) continue;
        const item: DraftAttachment = {
          id: nextId.current++,
          name,
          size: file.size,
          kind: info.kind,
          state: 'preparing',
          ...(info.kind === 'image' ? { preview: URL.createObjectURL(file) } : {}),
        };
        current = [...current, item];
        toPrepare.push([item, file]);
      }
      set(current);
      for (const [item, file] of toPrepare) {
        void (async () => {
          try {
            // A file from the disk is read where it is; one with no place on disk (pasted) is kept by Eya for a few days.
            let path = window.eya.pathForFile(file);
            if (path === '') {
              const saved = await window.eya.saveAttachment(item.name, await file.arrayBuffer());
              if (!saved.ok || saved.path === undefined) throw new Error(saved.error ?? 'It could not be attached.');
              path = saved.path;
            }
            set(itemsRef.current.map((i) => (i.id === item.id ? { ...i, state: 'ready' as const, path } : i)));
          } catch (err) {
            say(`${item.name}: ${err instanceof Error ? err.message : 'It could not be attached.'}`);
            drop(item.id);
          }
        })();
      }
    },
    [drop, say, set],
  );

  const clear = useCallback(() => {
    for (const i of itemsRef.current) if (i.preview !== undefined) URL.revokeObjectURL(i.preview);
    set([]);
  }, [set]);

  // Pictures held for previews are let go when the window goes.
  useEffect(
    () => () => {
      for (const i of itemsRef.current) if (i.preview !== undefined) URL.revokeObjectURL(i.preview);
    },
    [],
  );

  const ready: AttachmentRef[] = items.flatMap((i) => (i.state === 'ready' && i.path !== undefined ? [{ name: i.name, path: i.path, kind: i.kind, size: i.size }] : []));
  return {
    items,
    notes,
    add,
    remove: drop,
    clear,
    dismissNote: (id) => setNotes((n) => n.filter((x) => x.id !== id)),
    say,
    preparing: items.some((i) => i.state === 'preparing'),
    ready,
  };
}
