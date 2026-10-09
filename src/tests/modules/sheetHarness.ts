/** Отрисовать книгу настоящим SheetEditor в jsdom и вернуть корневой элемент. */
import { SheetEditor, type SheetHost } from '@/modules/docs/sheetEditor';
import type { ExcelContent } from '@/modules/docs/model';
import { createEvaluator, type GridAccess } from '@/utils/formula';

export function renderBook(book: ExcelContent, sheetIdx = 0): { root: HTMLElement; editor: SheetEditor; commits: number } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  let si = sheetIdx;
  const state = { commits: 0 };
  const gridOf = (i: number): GridAccess => ({
    raw: (r, c) => book.sheets[i].data[r]?.[c]?.v ?? '',
    isNumeric: (r, c) => book.sheets[i].data[r]?.[c]?.t === 'n',
    rowCount: () => book.sheets[i].data.length,
    sheet: (n) => { const j = book.sheets.findIndex(s => s.name.toLowerCase() === n.toLowerCase()); return j >= 0 ? gridOf(j) : null; },
  });
  const host: SheetHost = {
    docId: () => 'd', docTitle: () => 'T', book: () => book,
    sheetIdx: () => si, setSheetIdx: i => { si = i; },
    beginChange: () => {}, commit: () => { state.commits++; },
    undo: () => {}, redo: () => {}, canUndo: () => false, canRedo: () => false,
    evaluator: i => createEvaluator(gridOf(i)),
    publishSelection: () => {},
    prepareImage: async src => ({ dataUrl: src }), fileToDataUrl: async () => '',
    toast: () => {},
  };
  const editor = new SheetEditor(host, root);
  return { root, editor, get commits() { return state.commits; } } as any;
}
