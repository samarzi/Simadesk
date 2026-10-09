/**
 * Ассистент в таблице: «посчитай заказы, доходы и расходы и вынеси всё на
 * новый лист» — сценарий пользователя целиком, плюс то, что раньше было
 * сломано: числа от ассистента записывались текстом, после добавления листа
 * работа обрывалась, удаление строк не сдвигало объединения.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn(async () => []) }));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'CO', onChange: () => () => {} } }));
vi.mock('@/services/aiPageContext', () => ({ aiPage: { register: () => {}, unregister: () => {} } }));
vi.mock('@/services/selectionContext', () => ({ selectionCtx: { set: () => {}, clear: () => {} } }));
vi.mock('@/utils/toast', () => ({ showToast: () => {} }));

import { DocsModule } from '@/modules/DocsModule';

let M: any;
const book = () => M.parseExcelContent(M.docs[0].content);

beforeEach(() => {
  localStorage.clear();
  M = Object.create(DocsModule.prototype);
  Object.assign(M, { dirty: new Set(), serverKnown: new Set(), recentSyncTimers: new Map(), memberNames: new Map(), xlSelMemo: {}, bookCache: null, wbEval: null, srvV2: false, pendingContent: new Set(), warnedNoPersist: new Set(), recent: [] });
  M.root = document.createElement('div');
  M.xlUndoStack = []; M.xlRedoStack = []; M.saveTimer = null; M.activeSheetIdx = 0;
  M.render = () => {};
  const rows = [
    ['Дата', 'Товар', 'Тип', 'Сумма'],
    ['01.03.2026', 'Кофе', 'Доход', 1500],
    ['02.03.2026', 'Аренда', 'Расход', 20000],
    ['03.03.2026', 'Чай', 'Доход', 700.5],
    ['04.03.2026', 'Реклама', 'Расход', 5000],
    ['05.03.2026', 'Кофе', 'Доход', 3000],
  ];
  const data = rows.map(r => r.map(v => typeof v === 'number' ? { v: String(v), t: 'n' } : { v: String(v) }));
  M.docs = [{ id: 'd1', type: 'excel', title: 'Март', content: JSON.stringify({ sheets: [{ name: 'Выручка', data }] }), updated_at: 1 }];
  M.activeId = 'd1';
});

const evalOn = (sheetName: string, ref: string) => {
  const ec = book();
  const i = ec.sheets.findIndex((s: any) => s.name === sheetName);
  M.wbEval = null;
  return M.bookEvaluator(ec, i).evalToString('=' + ref);
};

describe('excel_create_report', () => {
  it('создаёт лист с живыми формулами итогов и разбивкой', () => {
    const res = M.aiExcelCreateReport({ groupBy: 'Тип', metrics: [{ column: 'Сумма', op: 'sum' }], newSheet: 'Итоги' });
    const ec = book();
    expect(ec.sheets.map((s: any) => s.name)).toEqual(['Выручка', 'Итоги']);
    expect(M.activeSheetIdx).toBe(1);
    const rep = ec.sheets[1];
    const flat = rep.data.flat().map((c: any) => c.v);
    expect(flat.some((v: string) => /SUM\('?Выручка'?!\$D\$2:\$D\$6\)/.test(v))).toBe(true);
    // Итоги посчитаны верно
    const totalRow = rep.data.findIndex((r: any[]) => r[0]?.v === 'Сумма: Сумма');
    expect(evalOn('Итоги', `B${totalRow + 1}`)).toBe('30200.5');
    const dohod = rep.data.findIndex((r: any[]) => r[0]?.v === 'Доход');
    expect(evalOn('Итоги', `C${dohod + 1}`)).toBe('5200.5');
    expect(evalOn('Итоги', `B${dohod + 1}`)).toBe('3');
    expect(rep.charts?.[0].kind).toBeTruthy();
    expect(res.summary).toContain('Итоги');
  });

  it('отчёт живой: правка исходных данных меняет итог', () => {
    M.aiExcelCreateReport({ metrics: [{ column: 'Сумма', op: 'sum' }], newSheet: 'Итоги' });
    M.activeSheetIdx = 0;
    M.aiExcelSetCell({ cell: 'D2', value: 2500 });
    const rep = book().sheets[1];
    const r = rep.data.findIndex((x: any[]) => x[0]?.v === 'Сумма: Сумма');
    expect(evalOn('Итоги', `B${r + 1}`)).toBe('31200.5');
  });
});

describe('значения от ассистента', () => {
  it('число записывается числом, а не текстом', () => {
    M.aiExcelSetCell({ cell: 'E2', value: '1 250,50' });
    expect(book().sheets[0].data[1][4]).toMatchObject({ v: '1250.5', t: 'n' });
    M.aiExcelSetCell({ cell: 'E3', value: 42 });
    expect(book().sheets[0].data[2][4]).toMatchObject({ v: '42', t: 'n' });
  });

  it('excel_set_range пишет на новый лист с формулами на исходный', () => {
    M.aiExcelSetRange({ sheet: 'Сводка', createSheet: true, start: 'A1', values: [['Всего', "=СУММ('Выручка'!D2:D6)"], ['Строк', '=СЧЁТЗ(Выручка!A2:A6)']] });
    expect(evalOn('Сводка', 'B1')).toBe('30200.5');
    expect(evalOn('Сводка', 'B2')).toBe('5');
  });

  it('добавление листа не обрывает работу: лист сразу активен', () => {
    M.aiExcelAddSheet({ name: 'Расходы' });
    expect(book().sheets[M.activeSheetIdx].name).toBe('Расходы');
    M.aiExcelSwitchSheet({ name: 'выруч' });
    expect(M.activeSheetIdx).toBe(0);
  });
});

describe('операции со строками и листами', () => {
  it('удаление строк по условию сдвигает формулы', () => {
    M.aiExcelSetCell({ cell: 'F1', value: '=SUM(D2:D6)' });
    M.aiExcelDeleteRows({ column: 'Тип', value_filter: 'Расход' });
    const sh = book().sheets[0];
    expect(sh.data.filter((r: any[]) => r[2]?.v === 'Расход')).toHaveLength(0);
    expect(sh.data[0][5].v).toBe('=SUM(D2:D4)');
    expect(evalOn('Выручка', 'F1')).toBe('5200.5');
  });

  it('переименование листа обновляет ссылки в формулах', () => {
    M.aiExcelSetRange({ sheet: 'Сводка', createSheet: true, start: 'A1', values: [["='Выручка'!D2"]] });
    M.aiExcelRenameSheet({ from: 'Выручка', to: 'Продажи март' });
    const s = book().sheets.find((x: any) => x.name === 'Сводка');
    expect(s.data[0][0].v).toBe("='Продажи март'!D2");
  });

  it('диаграмма по диапазону на отдельный лист', () => {
    M.aiExcelAddChart({ type: 'pie', range: 'B1:D6', title: 'Структура', targetSheet: 'Графики' });
    const ec = book();
    const g = ec.sheets.find((s: any) => s.name === 'Графики');
    expect(g.charts[0]).toMatchObject({ kind: 'pie', title: 'Структура' });
    expect(g.charts[0].series[0].valRef).toMatch(/^Выручка!D2:D6$/);
  });

  it('сортировка по убыванию суммы', () => {
    M.aiExcelSortSheet({ column: 'Сумма', order: 'desc' });
    const sums = book().sheets[0].data.slice(1, 6).map((r: any[]) => +r[3].v);
    expect(sums).toEqual([20000, 5000, 3000, 1500, 700.5]);
  });
});
