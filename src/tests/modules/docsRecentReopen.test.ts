/**
 * Открытие документа из «Недавних» на пустом экране.
 *
 * Регрессия: закрываешь последний документ, попадаешь на экран «Нет открытых
 * документов», видишь там свой файл в «Недавних» — и клик по нему не делает
 * ничего. Список недавних рисуется в двух местах (выпадашка в шапке и блок на
 * пустом экране), а делегирование кликов висело только на шапке.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db: { rows: any[] } = { rows: [] };
vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn(async () => db.rows) }));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'CO', onChange: () => () => {} } }));
vi.mock('@/services/aiPageContext', () => ({ aiPage: { register: () => {}, unregister: () => {} } }));
vi.mock('@/services/selectionContext', () => ({ selectionCtx: { set: () => {}, clear: () => {} } }));
vi.mock('@/utils/toast', () => ({ showToast: () => {} }));

import { DocsModule } from '@/modules/DocsModule';

const CONTENT = JSON.stringify({ sheets: [{ name: 'Лист1', data: [[{ v: 'важные данные' }]] }] });
let M: any;

beforeEach(() => {
  db.rows = [];
  localStorage.clear();
  M = Object.create(DocsModule.prototype);
  Object.assign(M, { dirty: new Set(), serverKnown: new Set(), recentSyncTimers: new Map(), memberNames: new Map(), xlSelMemo: {}, bookCache: null, wbEval: null, srvV2: false, pendingContent: new Set(), warnedNoPersist: new Set(), deletingDocs: new Set(), deletedDocs: new Set(), recent: [] });
  M.root = document.createElement('div');
  // Корни предыдущих тестов надо убирать: иначе в документе остаётся несколько
  // элементов с id="docs-recent-wrap", и селектор «#docs-recent-wrap .row»
  // (nwsapi оптимизирует #id через getElementById) цепляется за самый первый,
  // чужой, а не за тот, что внутри M.root.
  document.body.innerHTML = '';
  document.body.appendChild(M.root);
  M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: CONTENT, updated_at: 1000 }];
  M.recent = []; M.activeId = 'd1'; M.loadedCompanyId = 'CO';
  M.saveTimer = null; M.activeSheetIdx = 0;
  M.pendingContent = new Set(); M.warnedNoPersist = new Set();
  M.xlUndoStack = []; M.xlRedoStack = []; M.xlSheetScroll = {};
  M.fxRows = null; M.fxEval = null;
  M.isFullscreen = false;
});

const rowFor = (id: string) =>
  M.root.querySelector(`.docs-recent-row[data-recent-id="${id}"]`) as HTMLElement | null;

describe('пустой экран «Нет открытых документов»', () => {
  it('закрытый документ виден в недавних', () => {
    M.closeDoc('d1');
    expect(M.docs).toHaveLength(0);
    expect(M.root.querySelector('.docs-empty')).toBeTruthy();
    expect(rowFor('d1')).toBeTruthy();
  });

  it('клик по строке недавних открывает документ обратно', () => {
    M.closeDoc('d1');
    rowFor('d1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(M.docs.map((d: any) => d.id)).toEqual(['d1']);
    expect(M.activeId).toBe('d1');
  });

  it('содержимое возвращается целиком, а не пустым', () => {
    M.closeDoc('d1');
    rowFor('d1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const back = M.docs.find((d: any) => d.id === 'd1');
    expect(back.content).toBe(CONTENT);
    // Кеш есть — значит документ не «ждёт сервера» и не рисует пустой лист
    expect(M.pendingContent.has('d1')).toBe(false);
  });

  it('крестик в строке удаляет её из недавних, а не открывает документ', () => {
    M.closeDoc('d1');
    const del = M.root.querySelector('.docs-recent-del[data-del-recent="d1"]') as HTMLElement;
    del.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(M.recent.some((r: any) => r.id === 'd1')).toBe(false);
    expect(M.docs).toHaveLength(0);
  });
});

describe('выпадашка недавних в шапке продолжает работать', () => {
  it('клик по строке в шапке открывает документ', () => {
    // второй документ остаётся открытым — значит рисуется редактор, не пустой экран
    M.docs.push({ id: 'd2', type: 'excel', title: 'Второй', content: CONTENT, updated_at: 2000 });
    M.closeDoc('d1');
    expect(M.root.querySelector('.docs-empty')).toBeFalsy();
    const row = M.root.querySelector('#docs-recent-wrap .docs-recent-row[data-recent-id="d1"]') as HTMLElement;
    expect(row).toBeTruthy();
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(M.docs.some((d: any) => d.id === 'd1')).toBe(true);
    expect(M.activeId).toBe('d1');
  });
});
