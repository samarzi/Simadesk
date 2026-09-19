/**
 * Неизвестное действие не должно быть тупиком.
 *
 * Модель придумала название по аналогии («excel_move_image», когда страница
 * знает только вставку) и получила глухое «Действие недоступно» — ни ей, ни
 * пользователю не понятно, что делать дальше.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { aiPage } from '@/services/aiPageContext';

const cap = (names: string[]) => ({
  page: 'docs',
  title: 'Редактор',
  describe: () => '',
  actions: names.map(name => ({
    name, description: '', args: '{}', run: async () => `сделано: ${name}`,
  })),
});

beforeEach(() => { aiPage.register(cap(['excel_insert_image', 'excel_clear_cells', 'word_insert'])); });

describe('запуск действия страницы', () => {
  it('выполняет зарегистрированное действие', async () => {
    expect(await aiPage.run('excel_insert_image', {})).toEqual({ summary: 'сделано: excel_insert_image' });
  });

  it('на выдуманное имя предлагает похожие', async () => {
    await expect(aiPage.run('excel_move_image', {})).rejects.toThrow(/excel_insert_image/);
  });

  it('подсказывает перезагрузить страницу', async () => {
    await expect(aiPage.run('чего_то_такого', {})).rejects.toThrow(/перезагруз/i);
  });

  it('сначала ближайшее по смыслу', async () => {
    try { await aiPage.run('excel_image_move', {}); expect.unreachable(); }
    catch (e: any) {
      const list = e.message.slice(e.message.indexOf('Похожие'));
      expect(list.indexOf('excel_insert_image')).toBeLessThan(list.indexOf('excel_clear_cells'));
      expect(list).not.toContain('word_insert');
    }
  });
});
