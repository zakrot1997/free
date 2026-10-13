// نقاط استعادة: قبل أي تعديل نحفظ النسخة الأصلية، فيمكن التراجع عن "دورة" الوكيل كاملة بنقرة.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface ChangedFile {
  path: string; // نسبي لمجلد المشروع
  created: boolean;
}

interface Snapshot {
  abs: string;
  rel: string;
  /** null = الملف لم يكن موجوداً (أنشأه الوكيل) */
  original: string | null;
}

export class CheckpointStore {
  /** كل عنصر = دورة واحدة من الوكيل؛ يمكن التراجع عن الأحدث فالأحدث */
  private turns: Map<string, Snapshot>[] = [];

  beginTurn(): void {
    this.turns.push(new Map());
  }

  get depth(): number {
    return this.turns.filter((t) => t.size > 0).length;
  }

  /** يُستدعى قبل الكتابة. ينسخ الأصل مرة واحدة فقط لكل ملف في الدورة. */
  async snapshot(root: string, abs: string): Promise<void> {
    const turn = this.turns[this.turns.length - 1];
    if (!turn || turn.has(abs)) return;
    let original: string | null = null;
    try {
      original = await fs.readFile(abs, 'utf8');
    } catch {
      original = null;
    }
    turn.set(abs, { abs, rel: path.relative(root, abs), original });
  }

  currentChanges(): ChangedFile[] {
    const turn = this.turns[this.turns.length - 1];
    return turn ? [...turn.values()].map((s) => ({ path: s.rel, created: s.original === null })) : [];
  }

  allChanges(): ChangedFile[] {
    const seen = new Map<string, ChangedFile>();
    for (const t of this.turns) for (const s of t.values()) if (!seen.has(s.rel)) seen.set(s.rel, { path: s.rel, created: s.original === null });
    return [...seen.values()];
  }

  /** يتراجع عن آخر دورة فيها تغييرات. يعيد الملفات المتأثرة. */
  async undoLast(): Promise<ChangedFile[]> {
    while (this.turns.length && this.turns[this.turns.length - 1].size === 0) this.turns.pop();
    const turn = this.turns.pop();
    if (!turn) return [];
    const restored: ChangedFile[] = [];
    for (const s of turn.values()) {
      if (s.original === null) {
        await fs.rm(s.abs, { force: true });
      } else {
        await fs.mkdir(path.dirname(s.abs), { recursive: true });
        await fs.writeFile(s.abs, s.original, 'utf8');
      }
      restored.push({ path: s.rel, created: s.original === null });
    }
    return restored;
  }

  clear(): void {
    this.turns = [];
  }
}
