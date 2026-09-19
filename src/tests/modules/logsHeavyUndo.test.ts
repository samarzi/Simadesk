/**
 * Снимки для отката не должны забивать localStorage.
 *
 * Редактор кладёт в undo.payload.before полное содержимое документа. На
 * таблице в 5000 ячеек это мегабайты — и каждое действие ассистента
 * переписывало ими весь журнал, выбивало из квоты кеш документов и уезжало
 * многомегабайтным POST на сервер. После команды «закрась весь лист»
 * следующий запрос к ассистенту подвисал намертво.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/authService', () => ({
  authService: { getUser: () => ({ id: 'u1', display_name: 'Тест' }), isLoggedIn: () => false },
}));
vi.mock('@/services/companyService', () => ({ companyService: { getActive: () => null } }));
vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn() }));

const { changeLog, registerUndoHandler } = await import('@/modules/LogsModule');

const BIG = 'x'.repeat(300_000);

beforeEach(() => { localStorage.clear(); });

describe('крупные снимки не попадают в localStorage', () => {
  it('мегабайтный снимок не сохраняется в журнал', () => {
    changeLog.logAction({ action: 'Оформление', details: 'весь лист', undo: { kind: 'docs', payload: { docId: 'd1', before: BIG }, label: 'Отменить' } });
    const raw = localStorage.getItem('change_log_v1') ?? '';
    expect(raw).not.toContain(BIG);
    expect(raw.length).toBeLessThan(10_000);
  });

  it('журнал не растёт от повторных тяжёлых действий', () => {
    for (let i = 0; i < 20; i++) {
      changeLog.logAction({ action: 'Оформление', details: `правка ${i}`, undo: { kind: 'docs', payload: { docId: 'd1', before: BIG }, label: 'Отменить' } });
    }
    expect((localStorage.getItem('change_log_v1') ?? '').length).toBeLessThan(50_000);
  });

  it('маленький снимок сохраняется как раньше', () => {
    changeLog.logAction({ action: 'Правка', details: 'одна ячейка', undo: { kind: 'docs', payload: { docId: 'd1', before: 'коротко' }, label: 'Отменить' } });
    expect(localStorage.getItem('change_log_v1')).toContain('коротко');
  });
});

describe('откат тяжёлого действия всё равно работает в этой вкладке', () => {
  it('обработчик получает полный снимок из памяти', async () => {
    const seen: string[] = [];
    registerUndoHandler('docs', (p: any) => { seen.push(p.before); });
    const id = changeLog.logAction({ action: 'Оформление', details: 'весь лист', undo: { kind: 'docs', payload: { docId: 'd1', before: BIG }, label: 'Отменить' } });
    const msg = await changeLog.undo(id);
    expect(seen).toEqual([BIG]);
    expect(msg).toMatch(/Отменено/);
  });

  it('после перезагрузки честно сообщаем, что откатить нельзя', async () => {
    const id = changeLog.logAction({ action: 'Оформление', details: 'весь лист', undo: { kind: 'docs', payload: { docId: 'd1', before: BIG }, label: 'Отменить' } });
    // журнал пережил перезагрузку, память вкладки — нет
    const saved = localStorage.getItem('change_log_v1')!;
    vi.resetModules();
    const fresh = await import('@/modules/LogsModule');
    localStorage.setItem('change_log_v1', saved);
    fresh.registerUndoHandler('docs', () => { throw new Error('откат не должен был запуститься'); });
    await expect(fresh.changeLog.undo(id)).resolves.toMatch(/только в этой вкладке/i);
  });
});
