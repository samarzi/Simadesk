/**
 * Закрытие вкладки против удаления документа.
 *
 * Регрессия, стоившая пользователю нескольких файлов: крестик на вкладке звал
 * deleteDoc. Диалог обещал «документ будет закрыт», а код стирал кеш и слал
 * DELETE на сервер. Документ исчезал отовсюду, оставаясь в «Недавних», откуда
 * уже не открывался — «на сервере его нет».
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db: { rows: any[]; deletes: string[]; posts: string[] } = { rows: [], deletes: [], posts: [] };
vi.mock('@/services/dbClient', () => ({
  dbFetch: vi.fn(async (endpoint: string, opts?: any) => {
    if (opts?.method === 'DELETE') {
      const id = /id=eq\.([^&]+)/.exec(endpoint)?.[1] ?? '';
      db.deletes.push(id);
      db.rows = db.rows.filter(r => r.id !== id);
      return null;
    }
    if (opts?.method === 'POST') {
      const b = JSON.parse(opts.body);
      db.posts.push(b.id);
      const i = db.rows.findIndex(r => r.id === b.id);
      if (i >= 0) db.rows[i] = b; else db.rows.push(b);
      return null;
    }
    return db.rows;
  }),
}));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'CO', onChange: () => () => {} } }));
vi.mock('@/services/aiPageContext', () => ({ aiPage: { register: () => {}, unregister: () => {} } }));
vi.mock('@/services/selectionContext', () => ({ selectionCtx: { set: () => {}, clear: () => {} } }));
vi.mock('@/utils/toast', () => ({ showToast: () => {} }));

import { DocsModule } from '@/modules/DocsModule';

const CONTENT = JSON.stringify({ sheets: [{ name: 'Лист1', data: [[{ v: 'важные данные' }]] }] });
let M: any;

beforeEach(() => {
  db.rows = []; db.deletes = []; db.posts = [];
  localStorage.clear();
  M = Object.create(DocsModule.prototype);
  Object.assign(M, { dirty: new Set(), serverKnown: new Set(), recentSyncTimers: new Map(), memberNames: new Map(), xlSelMemo: {}, bookCache: null, wbEval: null, srvV2: false, pendingContent: new Set(), warnedNoPersist: new Set(), recent: [] });
  M.root = document.createElement('div');
  M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: CONTENT, updated_at: 1000 }];
  M.recent = []; M.activeId = 'd1'; M.loadedCompanyId = 'CO';
  M.saveTimer = null; M.activeSheetIdx = 0;
  M.pendingContent = new Set(); M.warnedNoPersist = new Set();
  M.xlUndoStack = []; M.xlRedoStack = []; M.xlSheetScroll = {};
  M.fxRows = null; M.fxEval = null;
  M.render = () => {};
});

describe('закрытие вкладки обратимо', () => {
  it('НЕ удаляет документ с сервера', () => {
    M.closeDoc('d1');
    expect(db.deletes, 'закрытие вкладки отправило DELETE на сервер').toEqual([]);
  });

  it('сохраняет содержимое в кеше браузера', () => {
    M.closeDoc('d1');
    expect(localStorage.getItem('docs_v2_CO__doc_d1')).toBe(CONTENT);
  });

  it('отправляет документ на сервер перед закрытием', () => {
    M.closeDoc('d1');
    expect(db.posts).toContain('d1');
  });

  it('документ открывается заново со всем содержимым', () => {
    M.closeDoc('d1');
    expect(M.docs.find((d: any) => d.id === 'd1')).toBeUndefined();
    expect(M.recent.some((r: any) => r.id === 'd1')).toBe(true);
    // Повторное открытие из «Недавних» берёт содержимое из кеша.
    M.load();
    const cached = localStorage.getItem('docs_v2_CO__doc_d1');
    expect(cached).toBe(CONTENT);
  });
});

describe('удаление необратимо и честно об этом говорит', () => {
  it('стирает и кеш, и запись на сервере', () => {
    db.rows = [{ id: 'd1', content: CONTENT }];
    M.deleteDoc('d1', true);
    expect(db.deletes).toEqual(['d1']);
    expect(localStorage.getItem('docs_v2_CO__doc_d1')).toBeNull();
  });

  it('убирает документ из «Недавних», чтобы не осталось мёртвой записи', () => {
    M.recent = [{ id: 'd1', title: 'Прайс', type: 'excel', updated_at: 1000 }];
    M.deleteDoc('d1', true);
    expect(M.recent.some((r: any) => r.id === 'd1'), 'мёртвая запись осталась в недавних').toBe(false);
  });

  it('без подтверждения ничего не удаляет', () => {
    const spy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    M.deleteDoc('d1');
    expect(db.deletes).toEqual([]);
    expect(M.docs).toHaveLength(1);
    spy.mockRestore();
  });

  it('предупреждение называет вещи своими именами', () => {
    const spy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    M.deleteDoc('d1');
    const text = spy.mock.calls[0][0] as string;
    expect(text).toMatch(/навсегда|нельзя/i);
    expect(text, 'диалог удаления не должен обещать простое закрытие').not.toMatch(/будет закрыт/i);
    spy.mockRestore();
  });
});
