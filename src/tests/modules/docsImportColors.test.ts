/**
 * Сквозной путь цвета: байты xlsx → импорт → хранение → отрисовка.
 *
 * Разбор стилей и палитра проверялись по отдельности и работали, но
 * пользователь всё равно видел таблицу без цветов. Этот тест проходит всю
 * цепочку целиком — он ловит потерю на любом стыке.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import JSZip from 'jszip';

vi.mock('@/services/dbClient', () => ({ dbFetch: vi.fn(async () => []) }));
vi.mock('@/services/companyService', () => ({ companyService: { getActiveId: () => 'CO', onChange: () => () => {} } }));
vi.mock('@/services/aiPageContext', () => ({ aiPage: { register: () => {}, unregister: () => {} } }));
vi.mock('@/services/selectionContext', () => ({ selectionCtx: { set: () => {}, clear: () => {} } }));
vi.mock('@/utils/toast', () => ({ showToast: () => {} }));

import { renderBook } from './sheetHarness';
import { DocsModule } from '@/modules/DocsModule';

/** xlsx как его пишет Excel: жёлтая заливка + красный жирный шрифт в A1/B1. */
async function xlsxWithColors(fillXml = '<fgColor rgb="FFFFFF00"/>', theme?: string): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${theme ? '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ''}
</Types>`);
  if (theme) zip.file('xl/theme/theme1.xml', theme);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${theme ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>' : ''}
</Relationships>`);
  zip.file('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFF0000"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid">${fillXml}<bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
</styleSheet>`);
  zip.file('xl/worksheets/sheet1.xml', `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" s="1" t="inlineStr"><is><t>Цветная</t></is></c><c r="B1" s="1"><v>42</v></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Обычная</t></is></c></row>
</sheetData></worksheet>`);
  return zip.generateAsync({ type: 'arraybuffer' });
}

function fakeFile(buf: ArrayBuffer, name = 'Прайс.xlsx'): File {
  return { name, arrayBuffer: async () => buf } as unknown as File;
}

let M: any;
let added: any[];

beforeEach(() => {
  localStorage.clear();
  added = [];
  M = Object.create(DocsModule.prototype);
  Object.assign(M, { dirty: new Set(), serverKnown: new Set(), recentSyncTimers: new Map(), memberNames: new Map(), xlSelMemo: {}, bookCache: null, wbEval: null, srvV2: false, pendingContent: new Set(), warnedNoPersist: new Set(), recent: [] });
  M.root = document.createElement('div');
  M.docs = []; M.recent = []; M.activeId = null; M.loadedCompanyId = 'CO';
  M.saveTimer = null; M.activeSheetIdx = 0;
  M.pendingContent = new Set(); M.warnedNoPersist = new Set();
  M.xlUndoStack = []; M.xlRedoStack = []; M.xlSheetScroll = {};
  M.fxRows = null; M.fxEval = null;
  M.render = () => {};
  M.addDoc = (doc: any) => { added.push(doc); M.docs.push(doc); M.activeId = doc.id; };
});

describe('цвет доживает от файла до экрана', () => {
  it('импорт сохраняет заливку и цвет шрифта в модели', async () => {
    await M.importFile(fakeFile(await xlsxWithColors()));
    expect(added, 'документ не создан').toHaveLength(1);
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s, 'стиль не дошёл до модели').toBeTruthy();
    expect(cell.s).toContain('background-color:#ffff00');
    expect(cell.s).toContain('color:#ff0000');
    expect(cell.s).toContain('font-weight:bold');
  });

  it('содержимое хранится с палитрой, а не со стилем в каждой ячейке', async () => {
    await M.importFile(fakeFile(await xlsxWithColors()));
    const raw = JSON.parse(added[0].content);
    expect(raw.sheets[0].styles, 'палитра стилей не записана').toBeTruthy();
    expect(raw.sheets[0].data[0][0].si).toBe(0);
  });

  it('отрисованная ячейка несёт цвет в инлайновом стиле', async () => {
    await M.importFile(fakeFile(await xlsxWithColors()));
    const sheet = M.parseExcelContent(added[0].content).sheets[0];
    const { root, editor } = renderBook({ sheets: [sheet] });
    const html: string = root.querySelector('td[data-r="0"][data-c="0"]')!.outerHTML;
    editor.destroy();
    expect(html).toContain('background-color:#ffff00');
    expect(html).toContain('color:#ff0000');
  });

  it('ячейка без оформления остаётся без стиля', async () => {
    await M.importFile(fakeFile(await xlsxWithColors()));
    const sheet = M.parseExcelContent(added[0].content).sheets[0];
    expect(sheet.data[1][0].s).toBeUndefined();
  });

  it('цвет переживает повторное сохранение документа', async () => {
    await M.importFile(fakeFile(await xlsxWithColors()));
    const ec = M.parseExcelContent(added[0].content);
    const again = M.parseExcelContent(M.serializeExcel(ec));
    expect(again.sheets[0].data[0][0].s).toContain('background-color:#ffff00');
  });
});

/** Тема Excel по умолчанию: в XML порядок dk1, lt1, dk2, lt2, accent1… */
const THEME = `<?xml version="1.0" encoding="UTF-8"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">
<a:themeElements>
<a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2>
<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>
<a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>
<a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="Office">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>
</a:fontScheme>
<a:fmtScheme name="Office">
<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>
</a:fmtScheme>
</a:themeElements>
</a:theme>`;

describe('индексная палитра — так красят выгрузки из 1С и старый Excel', () => {
  it('заливка по номеру цвета больше не теряется', async () => {
    // indexed="13" в стандартной палитре — жёлтый ffff00
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor indexed="13"/>')));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s, 'индексный цвет не разобран — файл открылся без заливки').toContain('background-color:#ffff00');
  });

  it('разные номера дают разные цвета', async () => {
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor indexed="11"/>')));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s).toContain('background-color:#00ff00');
  });

  it('автоматические цвета системы заливкой не считаются', async () => {
    // 64 и 65 означают «авто», а не цвет палитры
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor indexed="64"/>')));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s ?? '').not.toContain('background-color');
  });
});

describe('цвета темы читаются по правильным индексам', () => {
  it('accent1 (theme="4") — синий из темы', async () => {
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor theme="4"/>', THEME)));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s).toContain('background-color:#4472c4');
  });

  it('РЕГРЕССИЯ: theme="3" это dk2, а не lt2', async () => {
    // В XML порядок dk1,lt1,dk2,lt2 — но индексы ссылаются попарно наоборот.
    // Раньше тёмный заголовок 44546A приезжал светлым E7E6E6.
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor theme="3"/>', THEME)));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s, 'тёмный цвет темы подменён светлым').toContain('background-color:#44546a');
  });

  it('theme="2" это lt2', async () => {
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor theme="2"/>', THEME)));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s).toContain('background-color:#e7e6e6');
  });

  it('оттенок темы применяется поверх базового цвета', async () => {
    await M.importFile(fakeFile(await xlsxWithColors('<fgColor theme="4" tint="0.4"/>', THEME)));
    const cell = M.parseExcelContent(added[0].content).sheets[0].data[0][0];
    expect(cell.s).toMatch(/background-color:#[0-9a-f]{6}/);
    expect(cell.s, 'оттенок не применён — цвет совпал с базовым').not.toContain('#4472c4');
  });
});
