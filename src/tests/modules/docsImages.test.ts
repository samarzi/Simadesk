/**
 * Картинки в документах редактора.
 *
 * Пользователь прикладывал фото к сообщению и просил вставить его в ячейку, а
 * ассистент отвечал «Excel в SimaDesk не поддерживает вставку изображений».
 * Инструментов действительно не было, а модель байты картинки вернуть не может
 * — ей нужна ссылка на вложение. Здесь проверяется вся цепочка: реестр
 * вложений → инструмент → модель ячейки → разметка → чтение обратно из DOM.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db: { rows: any[] } = { rows: [] };
vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn(async () => db.rows) }));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'CO', onChange: () => () => {} } }));
vi.mock('@/services/aiPageContext', () => ({ aiPage: { register: () => {}, unregister: () => {} }, aiGlow: () => {} }));
vi.mock('@/services/selectionContext', () => ({ selectionCtx: { set: () => {}, clear: () => {} } }));
vi.mock('@/utils/toast', () => ({ showToast: () => {} }));
// canvas в jsdom нет — пережатие подменяем, проверяем логику вставки
vi.mock('@/utils/docImage', async (orig) => {
  const real = await orig<typeof import('@/utils/docImage')>();
  return {
    ...real,
    prepareImage: vi.fn(async (src: string) => ({ dataUrl: src, w: 120, h: 90 })),
  };
});

import { DocsModule } from '@/modules/DocsModule';
import { imageAttachments } from '@/services/imageAttachments';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const PNG2 = 'data:image/png;base64,AAAAdifferentBBBB==';

const sheet = (rows = 3, cols = 3) => ({
  sheets: [{ name: 'Лист1', data: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ v: '' }))) }],
});

let M: any;
beforeEach(() => {
  db.rows = [];
  localStorage.clear();
  imageAttachments.clear();
  M = Object.create(DocsModule.prototype);
  M.root = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(M.root);
  M.docs = [{ id: 'd1', type: 'excel', title: 'Прайс', content: JSON.stringify(sheet()), updated_at: 1 }];
  M.recent = []; M.activeId = 'd1'; M.loadedCompanyId = 'CO';
  M.saveTimer = null; M.activeSheetIdx = 0;
  M.pendingContent = new Set(); M.warnedNoPersist = new Set();
  M.xlUndoStack = []; M.xlRedoStack = []; M.xlSheetScroll = {};
  M.fxRows = null; M.fxEval = null; M.isFullscreen = false;
  M.xlLastSel = null;
  M.render = () => {};
});

const cellOf = (r: number, c: number) => M.parseExcelContent(M.docs[0].content).sheets[0].data[r][c];

describe('реестр присланных картинок', () => {
  it('пустая ссылка означает последнюю присланную', () => {
    imageAttachments.add('a.png', PNG);
    const b = imageAttachments.add('b.png', PNG2);
    expect(imageAttachments.resolve()?.id).toBe(b.id);
  });

  it('находит по id, по номеру и по имени файла', () => {
    const a = imageAttachments.add('логотип.png', PNG);
    expect(imageAttachments.resolve(a.id)?.dataUrl).toBe(PNG);
    expect(imageAttachments.resolve('1')?.dataUrl).toBe(PNG);
    expect(imageAttachments.resolve('логотип.png')?.dataUrl).toBe(PNG);
  });

  it('повторная отправка того же файла не плодит ссылок', () => {
    const a = imageAttachments.add('a.png', PNG);
    const again = imageAttachments.add('a.png', PNG);
    expect(again.id).toBe(a.id);
    expect(imageAttachments.list()).toHaveLength(1);
  });

  it('без вложений ничего не выдумывает', () => {
    expect(imageAttachments.resolve()).toBeNull();
    expect(imageAttachments.resolve('img1')).toBeNull();
  });
});

describe('excel_insert_image', () => {
  it('кладёт картинку в названную ячейку', async () => {
    imageAttachments.add('фото.png', PNG);
    const res = await M.aiExcelInsertImage({ cell: 'B1' });
    expect(cellOf(0, 1).img).toBe(PNG);
    expect(res.summary).toContain('B1');
  });

  it('без cell использует выделение в таблице', async () => {
    imageAttachments.add('фото.png', PNG);
    M.xlLastSel = { r1: 2, c1: 1, r2: 2, c2: 1, docId: 'd1', sheetIdx: 0 };
    await M.aiExcelInsertImage({});
    expect(cellOf(2, 1).img).toBe(PNG);
    expect(cellOf(0, 0).img).toBeUndefined();
  });

  it('растягивает столбец и строку под картинку', async () => {
    imageAttachments.add('фото.png', PNG);
    await M.aiExcelInsertImage({ cell: 'A1' });
    const sh = M.parseExcelContent(M.docs[0].content).sheets[0];
    expect(sh.colWidths[0]).toBeGreaterThanOrEqual(120);
    expect(sh.rowHeights[0]).toBeGreaterThanOrEqual(90);
  });

  it('достраивает лист, если ячейка за его краем', async () => {
    imageAttachments.add('фото.png', PNG);
    await M.aiExcelInsertImage({ cell: 'F7' });
    expect(cellOf(6, 5).img).toBe(PNG);
  });

  it('без вложения объясняет, что нужно приложить файл, и лист не трогает', async () => {
    const before = M.docs[0].content;
    await expect(M.aiExcelInsertImage({ cell: 'B1' })).rejects.toThrow(/прикреп/i);
    expect(M.docs[0].content).toBe(before);
  });

  it('отдаёт снимок для отката', async () => {
    imageAttachments.add('фото.png', PNG);
    const before = M.docs[0].content;
    const res = await M.aiExcelInsertImage({ cell: 'B1' });
    expect(res.undo.payload.before).toBe(before);
    M.aiUndoRestore(res.undo.payload);
    expect(cellOf(0, 1).img).toBeUndefined();
  });
});

describe('картинка переживает хранение и отрисовку', () => {
  it('сохраняется при сериализации вместе со стилем ячейки', async () => {
    imageAttachments.add('фото.png', PNG);
    await M.aiExcelInsertImage({ cell: 'B1' });
    const ec = M.parseExcelContent(M.docs[0].content);
    ec.sheets[0].data[0][1].s = 'background:#ff0000';
    const again = M.parseExcelContent(M.serializeExcel(ec)).sheets[0].data[0][1];
    expect(again.img).toBe(PNG);
    expect(again.imgW).toBe(120);
    expect(again.s).toBe('background:#ff0000');
  });

  it('опасный src в содержимом документа не доезжает до разметки', () => {
    const evil = JSON.stringify({ sheets: [{ name: 'Л', data: [[{ v: '', img: 'javascript:alert(1)' }]] }] });
    expect(M.parseExcelContent(evil).sheets[0].data[0][0].img).toBeUndefined();
  });

  it('рисуется тегом img внутри ячейки', () => {
    const html = M.renderCell([[{ v: '', img: PNG, imgW: 120, imgH: 90 }]], 0, 0, { v: '', img: PNG, imgW: 120, imgH: 90 });
    expect(html).toContain('class="dx-cell-img"');
    expect(html).toContain(PNG);
  });

  it('читается обратно из DOM — правка соседней ячейки её не стирает', () => {
    const td = document.createElement('td');
    td.innerHTML = `<img class="dx-cell-img" src="${PNG}" style="width:120px;height:90px">Цена`;
    const cell = M.cellFromTd(td);
    expect(cell.img).toBe(PNG);
    expect(cell.imgW).toBe(120);
    expect(cell.imgH).toBe(90);
  });

  it('applyCellToTd возвращает картинку после перерисовки текста', () => {
    const td = document.createElement('td') as HTMLTableCellElement;
    M.applyCellToTd(td, { v: '10', img: PNG, imgW: 120, imgH: 90 }, [[{ v: '10' }]]);
    expect(td.querySelector('img.dx-cell-img')).toBeTruthy();
    expect(td.innerText).toContain('10');
  });
});

describe('word_insert_image', () => {
  beforeEach(() => {
    M.docs = [{ id: 'w1', type: 'word', title: 'Письмо', content: '<p>Привет</p>', updated_at: 1 }];
    M.activeId = 'w1';
  });

  it('вставляет картинку в конец документа', async () => {
    imageAttachments.add('фото.png', PNG);
    const res = await M.aiWordInsertImage({});
    expect(M.docs[0].content).toContain('<img');
    expect(M.docs[0].content).toContain(PNG);
    expect(M.docs[0].content.indexOf('<img')).toBeGreaterThan(M.docs[0].content.indexOf('Привет'));
    expect(res.summary).toContain('фото.png');
  });

  it('умеет вставить в начало', async () => {
    imageAttachments.add('фото.png', PNG);
    await M.aiWordInsertImage({ position: 'start' });
    expect(M.docs[0].content.indexOf('<img')).toBeLessThan(M.docs[0].content.indexOf('Привет'));
  });

  it('без вложения просит приложить файл', async () => {
    await expect(M.aiWordInsertImage({})).rejects.toThrow(/прикреп/i);
  });
});
