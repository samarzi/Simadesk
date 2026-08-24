/**
 * Жизненный цикл документа: правка → сохранение → обновление страницы → загрузка.
 * Тест воспроизводит реальный симптом: после F5 таблица пуста.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// dbFetch мокаем: имитируем и успех, и полный отказ сети.
const dbState: { rows: any[]; failWrites: boolean; failReads: boolean; writes: any[] } = {
  rows: [], failWrites: false, failReads: false, writes: [],
};
vi.mock('@/services/dbClient', () => ({
  dbFetch: vi.fn(async (endpoint: string, opts?: any) => {
    if (opts?.method === 'POST') {
      if (dbState.failWrites) throw new Error('network down');
      const body = JSON.parse(opts.body);
      dbState.writes.push(body);
      const i = dbState.rows.findIndex(r => r.id === body.id);
      if (i >= 0) dbState.rows[i] = body; else dbState.rows.push(body);
      return null;
    }
    if (endpoint.startsWith('docs_documents?company_id')) {
      if (dbState.failReads) throw new Error('HTTP 400 invalid input syntax for type uuid');
      return dbState.rows;
    }
    return [];
  }),
}));
vi.mock('@/services/companyService', () => ({
  companyService: { getActiveId: () => 'CO', onChange: () => () => {} },
}));
vi.mock('@/services/aiPageContext', () => ({
  aiPage: { register: () => {}, unregister: () => {} },
}));
vi.mock('@/services/selectionContext', () => ({ selectionCtx: { set: () => {}, clear: () => {} } }));
vi.mock('@/utils/toast', () => ({ showToast: () => {} }));

import { DocsModule } from '@/modules/DocsModule';

/** localStorage с настоящей квотой — как в браузере. */
function installQuotaStorage(limitBytes: number) {
  const store = new Map<string, string>();
  const used = () => [...store.entries()].reduce((n, [k, v]) => n + k.length + v.length, 0);
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const prev = store.get(k) ?? '';
      if (used() - prev.length + v.length > limitBytes) {
        const e: any = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      store.set(k, v);
    },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: mock, writable: true, configurable: true });
  return store;
}

/** Документ заданного размера — как импортированный из .xlsx прайс. */
function bigExcel(rowCount: number): string {
  const data = Array.from({ length: rowCount }, (_, r) =>
    Array.from({ length: 12 }, (_, c) => ({ v: `знач-${r}-${c}`, t: 'n', nf: '#,##0.00' })));
  return JSON.stringify({ sheets: [{ name: 'Лист1', data }] });
}

/** Один «сеанс страницы»: новый инстанс модуля, как после F5. */
function boot() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const M: any = Object.create(DocsModule.prototype);
  M.root = root; M.docs = []; M.recent = []; M.activeId = null;
  M.loadedCompanyId = 'CO'; M.saveTimer = null; M.activeSheetIdx = 0;
  M.xlUndoStack = []; M.xlRedoStack = []; M.xlSheetScroll = {};
  M.fxRows = null; M.fxEval = null;
  M.pendingContent = new Set();
  M.load();
  return M;
}

beforeEach(() => {
  dbState.rows = []; dbState.failWrites = false; dbState.failReads = false; dbState.writes = [];
  vi.clearAllMocks();
});

describe('документ переживает обновление страницы', () => {
  it('小 документ: правка сохраняется и читается после перезапуска', () => {
    installQuotaStorage(5_000_000);
    const A = boot();
    A.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: bigExcel(5), updated_at: 1000 }];
    A.activeId = 'd1';
    A.save();

    const B = boot();
    expect(B.docs).toHaveLength(1);
    expect(B.docs[0].content).toBe(bigExcel(5));
  });

  it('РЕГРЕССИЯ: при переполнении квоты кеш НЕ подменяется пустышкой', async () => {
    // Квоты хватает на индекс, но не на сам документ — обычная ситуация,
    // когда в редакторе лежит импортированный прайс.
    installQuotaStorage(60_000);
    const A = boot();
    const content = bigExcel(300);
    expect(content.length).toBeGreaterThan(60_000);
    A.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content, updated_at: 1000 }];
    A.activeId = 'd1';
    A.save();

    // Ключевое: пустая строка в кеш не записана. Раньше сюда клали '',
    // и после F5 документ выглядел пустым НАВСЕГДА.
    expect(localStorage.getItem('docs_v2_CO__doc_d1')).toBeNull();
    // Документ ушёл в БД — источник истины.
    expect(dbState.writes.some(w => w.id === 'd1' && w.content === content)).toBe(true);

    // F5: контента в кеше нет → документ помечен «загружается», не «пустой».
    const B = boot();
    expect(B.pendingContent.has('d1')).toBe(true);
    B.render = () => {};
    await B.syncFromDb();
    expect(B.docs[0].content, 'после F5 содержимое не восстановилось из БД').toBe(content);
  });

  it('РЕГРЕССИЯ: большой документ не выселяет кеш соседей', () => {
    installQuotaStorage(200_000);
    const A = boot();
    const small = bigExcel(3);
    const huge  = bigExcel(400);
    A.docs = [
      { id: 'd1', type: 'excel', title: 'Малый',  content: small, updated_at: 1000 },
      { id: 'd2', type: 'excel', title: 'Большой', content: huge,  updated_at: 2000 },
    ];
    A.activeId = 'd2';
    A.save();

    const B = boot();
    const d1 = B.docs.find((d: any) => d.id === 'd1');
    expect(d1.content, 'малый документ пострадал из-за соседа, который всё равно не поместился').toBe(small);
  });

  it('документ без локального кеша помечается как загружаемый и НЕ перезаписывается', async () => {
    installQuotaStorage(200_000);
    const content = bigExcel(300);
    // В БД документ есть, локального кеша нет — как после чистки localStorage.
    dbState.rows = [{ id: 'd1', type: 'excel', title: 'Прайс', content, updated_at: 5000 }];
    const A = boot();
    A.docs = [];
    localStorage.setItem('docs_v2_CO', JSON.stringify([
      { id: 'd1', type: 'excel', title: 'Прайс', updated_at: 5000 },
    ]));
    A.load();

    expect(A.pendingContent.has('d1'), 'документ должен быть помечен как ожидающий').toBe(true);

    // Пока грузится, правки должны игнорироваться, а не затирать документ.
    A.updateContent('d1', JSON.stringify({ sheets: [{ name: 'S', data: [] }] }));
    expect(A.docs[0].content).toBe('');

    A.render = () => {};
    await A.syncFromDb();
    expect(A.docs[0].content, 'содержимое не восстановилось из БД').toBe(content);
    expect(A.pendingContent.has('d1')).toBe(false);
  });
});

describe('история отмен ограничена по памяти', () => {
  it('на большом листе стек не растёт до OOM', () => {
    installQuotaStorage(5_000_000);
    const M: any = boot();
    // Лист 5000×26 — один снимок это 130 000 ячеек.
    const big = Array.from({ length: 5000 }, () =>
      Array.from({ length: 26 }, () => ({ v: 'x' })));
    for (let i = 0; i < 100; i++) {
      M.xlUndoStack.push({ data: M.snapshotGrid(big), docId: 'd', sheetIdx: 0, r: 0, c: 0 });
      M.trimUndoStack(M.xlUndoStack);
    }
    const cells = M.xlUndoStack.reduce((n: number, s: any) => n + M.snapCells(s.data), 0);
    expect(cells).toBeLessThanOrEqual(400_000);
    expect(M.xlUndoStack.length, 'хотя бы один шаг отмены обязан остаться').toBeGreaterThanOrEqual(1);
  });

  it('на мелком листе глубина истории сохраняется', () => {
    installQuotaStorage(5_000_000);
    const M: any = boot();
    const small = Array.from({ length: 10 }, () =>
      Array.from({ length: 5 }, () => ({ v: 'x' })));
    for (let i = 0; i < 100; i++) {
      M.xlUndoStack.push({ data: M.snapshotGrid(small), docId: 'd', sheetIdx: 0, r: 0, c: 0 });
      M.trimUndoStack(M.xlUndoStack);
    }
    expect(M.xlUndoStack.length).toBe(100);
  });

  it('снимок не разделяет ссылки с исходным листом', () => {
    installQuotaStorage(5_000_000);
    const M: any = boot();
    const src = [[{ v: '1' }, { v: '2' }]];
    const snap = M.snapshotGrid(src);
    src[0][0].v = 'изменено';
    expect(snap[0][0].v, 'снимок мутировал вместе с оригиналом').toBe('1');
  });
});

describe('миграция со старого формата хранения', () => {
  it('документы из единого блоба переезжают в отдельные ключи без потерь', () => {
    installQuotaStorage(5_000_000);
    const content = bigExcel(10);
    // Старый формат: содержимое лежало прямо в индексном ключе.
    localStorage.setItem('docs_v2_CO', JSON.stringify([
      { id: 'd1', type: 'excel', title: 'Прайс', content, updated_at: 1000 },
    ]));

    const A = boot();
    expect(A.docs[0].content, 'старый формат не прочитан').toBe(content);
    A.activeId = 'd1';
    A.save();

    // Индекс теперь без содержимого, содержимое — в своём ключе.
    const index = JSON.parse(localStorage.getItem('docs_v2_CO')!);
    expect(index[0].content).toBeUndefined();
    expect(localStorage.getItem('docs_v2_CO__doc_d1')).toBe(content);

    // И следующая загрузка видит документ целиком.
    const B = boot();
    expect(B.docs[0].content).toBe(content);
    expect(B.pendingContent.has('d1')).toBe(false);
  });

  it('недавние больше не хранят копии документов', () => {
    installQuotaStorage(5_000_000);
    const A = boot();
    const content = bigExcel(50);
    A.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content, updated_at: 1000 }];
    A.activeId = 'd1';
    A.touchRecent(A.docs[0]);

    const raw = localStorage.getItem('docs_recent_v2_CO')!;
    expect(raw).not.toContain('знач-0-0');
    expect(JSON.parse(raw)[0].content).toBeUndefined();
  });
});

describe('отрисовка после переделки хранения', () => {
  it('загруженный документ рисует сетку с данными, а не заглушку', () => {
    installQuotaStorage(5_000_000);
    const M: any = boot();
    M.docs = [{
      id: 'd1', type: 'excel', title: 'Прайс', updated_at: 1,
      content: JSON.stringify({ sheets: [{ name: 'Лист1', data: [
        [{ v: 'Товар' }, { v: 'Цена' }],
        [{ v: 'Кофе' }, { v: '100', t: 'n', nf: '#,##0.00' }],
      ] }] }),
    }];
    M.activeId = 'd1';
    const html: string = M.renderExcel(M.docs[0]);
    expect(html).toContain('Кофе');
    expect(html).toContain('100,00');          // формат применён при отрисовке
    expect(html).not.toContain('docs-loading');
  });

  it('документ, ждущий загрузки, показывает спиннер вместо пустой таблицы', () => {
    installQuotaStorage(5_000_000);
    const M: any = boot();
    M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: '', updated_at: 1 }];
    M.activeId = 'd1';
    M.pendingContent.add('d1');
    const html: string = M.renderEditor(M.docs[0]);
    expect(html).toContain('docs-loading');
    expect(html).toContain('Загружаем «Прайс»');
    // Пустой сетки в DOM быть не должно — иначе первая правка затрёт документ.
    expect(html).not.toContain('docs-excel-body');
  });
});

describe('сервер недоступен — редактор не должен зависать и терять данные', () => {
  it('при 400 от БД документ не остаётся вечно в состоянии загрузки', async () => {
    installQuotaStorage(5_000_000);
    dbState.failReads = true;              // ровно то, что было в проде: 400
    const M: any = boot();
    M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: '', updated_at: 1 }];
    M.activeId = 'd1';
    M.pendingContent.add('d1');
    M.render = () => {};

    await M.syncFromDb();

    expect(M.pendingContent.has('d1'), 'спиннер завис бы навсегда').toBe(false);
    expect(M.docs[0].content, 'должен подставиться пустой лист, а не остаться пустая строка').not.toBe('');
  });

  it('пустой ответ БД тоже снимает состояние загрузки', async () => {
    installQuotaStorage(5_000_000);
    dbState.rows = [];
    const M: any = boot();
    M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: '', updated_at: 1 }];
    M.pendingContent.add('d1');
    M.render = () => {};

    await M.syncFromDb();
    expect(M.pendingContent.has('d1')).toBe(false);
  });

  it('РЕГРЕССИЯ: не влезающая версия не стирает уже сохранённую копию', () => {
    const store = installQuotaStorage(120_000);
    const M: any = boot();
    const ok  = bigExcel(20);              // помещается
    M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: ok, updated_at: 1 }];
    M.activeId = 'd1';
    M.save();
    expect(store.get('docs_v2_CO__doc_d1')).toBe(ok);

    // Пользователь дописал строк — новая версия уже не влезает.
    M.docs[0].content = bigExcel(400);
    M.save();

    // Старая копия обязана уцелеть: она единственное, что переживёт F5.
    expect(store.get('docs_v2_CO__doc_d1'), 'сохранённая копия уничтожена').toBe(ok);
  });
});

describe('восстановление содержимого из ключа чужой области', () => {
  it('находит документ, сохранённый до загрузки компании', () => {
    installQuotaStorage(5_000_000);
    const content = bigExcel(10);
    // Индекс — в области компании, а содержимое осталось под ключом без неё:
    // так получалось, когда сохранение происходило до готовности companyService.
    localStorage.setItem('docs_v2_CO', JSON.stringify([
      { id: 'd1', type: 'excel', title: 'Полки', updated_at: 1000 },
    ]));
    localStorage.setItem('docs_v2__doc_d1', content);

    const M: any = boot();
    expect(M.docs[0].content, 'содержимое не подобрано из чужого ключа').toBe(content);
    expect(M.pendingContent.has('d1'), 'документ не должен считаться потерянным').toBe(false);
  });

  it('подобранное содержимое переносится в текущую область при сохранении', () => {
    installQuotaStorage(5_000_000);
    const content = bigExcel(10);
    localStorage.setItem('docs_v2_CO', JSON.stringify([
      { id: 'd1', type: 'excel', title: 'Полки', updated_at: 1000 },
    ]));
    localStorage.setItem('docs_v2__doc_d1', content);

    const M: any = boot();
    M.activeId = 'd1';
    M.save();
    expect(localStorage.getItem('docs_v2_CO__doc_d1')).toBe(content);
  });

  it('чужой документ не подбирается по чужому id', () => {
    installQuotaStorage(5_000_000);
    localStorage.setItem('docs_v2_CO', JSON.stringify([
      { id: 'd1', type: 'excel', title: 'Полки', updated_at: 1000 },
    ]));
    localStorage.setItem('docs_v2__doc_ДРУГОЙ', bigExcel(10));

    const M: any = boot();
    expect(M.pendingContent.has('d1')).toBe(true);
    expect(M.docs[0].content).toBe('');
  });
});
