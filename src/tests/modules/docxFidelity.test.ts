/**
 * Word: «открыл → сохранил» без потерь.
 *
 * Жалоба пользователя: пустые строки при открытии исчезали, а сохранённый
 * файл выглядел иначе. Импорт шёл через mammoth (он выбрасывает пустые
 * абзацы и всё оформление), экспорт писал страницу Letter вместо A4.
 */
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { readDocx, writeDocx, htmlToWordXml } from '@/modules/docs/docxIO';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function makeDocx(body: string, styles = '', numbering = ''): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr></w:body></w:document>`);
  zip.file('word/styles.xml', `<?xml version="1.0"?><w:styles ${W}>
    <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="28"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
    <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="C00000"/><w:sz w:val="36"/></w:rPr></w:style>
    ${styles}</w:styles>`);
  if (numbering) zip.file('word/numbering.xml', `<?xml version="1.0"?><w:numbering ${W}>${numbering}</w:numbering>`);
  const u8 = await zip.generateAsync({ type: 'uint8array' });
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

const P = (text: string, ppr = '', rpr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${text ? `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>` : ''}</w:p>`;

describe('импорт .docx', () => {
  it('пустые абзацы сохраняются (раньше вырезались)', async () => {
    const { html } = await readDocx(await makeDocx(P('Первый') + P('') + P('') + P('Второй')));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const ps = [...doc.querySelectorAll('p')].map(p => p.textContent);
    expect(ps).toEqual(['Первый', '', '', 'Второй']);
  });

  it('шрифт документа, размер страницы и поля читаются', async () => {
    const { meta } = await readDocx(await makeDocx(P('Текст')));
    expect(meta.font).toEqual({ name: 'Times New Roman', size: 14 });
    expect(meta.page).toMatchObject({ w: 11906, h: 16838, left: 1701, right: 850 });
  });

  it('стиль заголовка разворачивается в явное оформление', async () => {
    const { html } = await readDocx(await makeDocx(P('Глава 1', '<w:pStyle w:val="Heading1"/>')));
    expect(html).toMatch(/<h1[^>]*>.*Глава 1/);
    expect(html).toContain('color:#c00000');
    expect(html).toContain('font-size:18pt');
  });

  it('выравнивание, интервалы и прямое оформление прогонов', async () => {
    const { html } = await readDocx(await makeDocx(
      P('По центру', '<w:jc w:val="center"/><w:spacing w:after="240" w:line="360" w:lineRule="auto"/>', '<w:i/><w:highlight w:val="yellow"/><w:color w:val="0000FF"/>')));
    expect(html).toContain('text-align:center');
    expect(html).toContain('margin-bottom:12pt');
    expect(html).toContain('line-height:1.5');
    expect(html).toContain('font-style:italic');
    expect(html).toContain('background-color:#ffff00');
    expect(html).toContain('color:#0000ff');
  });

  it('нумерованный и маркированный списки с уровнями', async () => {
    const numbering = `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num>`;
    const li = (t: string, lvl: number) => P(t, `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="5"/></w:numPr>`);
    const { html } = await readDocx(await makeDocx(li('Один', 0) + li('Вложенный', 1) + li('Два', 0), '', numbering));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('ol > li')).toHaveLength(2);
    expect(doc.querySelector('ol > li > ul > li')?.textContent).toBe('Вложенный');
  });

  it('таблица с объединёнными ячейками и заливкой', async () => {
    const tc = (t: string, pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr>${P(t)}</w:tc>`;
    const tbl = `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr>${tc('Шапка', '<w:gridSpan w:val="2"/><w:shd w:fill="D9E2F3"/>')}</w:tr>
      <w:tr>${tc('А', '<w:vMerge w:val="restart"/>')}${tc('1')}</w:tr>
      <w:tr>${tc('', '<w:vMerge/>')}${tc('2')}</w:tr></w:tbl>`;
    const { html } = await readDocx(await makeDocx(tbl));
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const th = doc.querySelector('td[colspan="2"]') as HTMLElement;
    expect(th.textContent).toBe('Шапка');
    expect(th.getAttribute('style')).toContain('#d9e2f3');
    expect(doc.querySelector('td[rowspan="2"]')?.textContent).toBe('А');
    expect(doc.querySelectorAll('tr')[2].querySelectorAll('td')).toHaveLength(1);
  });
});

describe('экспорт .docx', () => {
  it('страница A4 с полями из документа, а не Letter', async () => {
    const bytes = await writeDocx('<p>Текст</p>', { meta: { page: { w: 11906, h: 16838, top: 1134, right: 850, bottom: 1134, left: 1701 } } });
    const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string');
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>');
    expect(xml).toContain('w:left="1701"');
  });

  it('текст без обёртки на верхнем уровне не теряется', () => {
    const { xml } = htmlToWordXml('Просто текст<p>Абзац</p>');
    expect(xml).toContain('Просто текст');
  });

  it('пустой абзац остаётся пустым абзацем', () => {
    const { xml } = htmlToWordXml('<p>А</p><p><br></p><p>Б</p>');
    expect(xml.match(/<w:p>/g)?.length).toBe(3);
  });

  it('вложенный список получает второй уровень, у каждого списка своя нумерация', () => {
    const { xml, numXml } = htmlToWordXml('<ol><li>Один<ul><li>Под</li></ul></li></ol><p>x</p><ol><li>Снова один</li></ol>');
    expect(xml).toContain('<w:ilvl w:val="1"/>');
    expect((numXml.match(/<w:num w:numId=/g) ?? []).length).toBe(2);
  });

  it('объединённые ячейки таблицы → gridSpan и vMerge', () => {
    const { xml } = htmlToWordXml('<table><tr><td colspan="2">Ш</td></tr><tr><td rowspan="2">А</td><td>1</td></tr><tr><td>2</td></tr></table>');
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(xml).toContain('<w:vMerge w:val="restart"/>');
    expect(xml).toContain('<w:vMerge/>');
  });

  it('круг «экспорт → импорт» сохраняет вид', async () => {
    const html = '<h1>Отчёт</h1><p style="text-align:center"><span style="color:#ff0000;font-size:16pt">Красный</span></p><p><br></p><p>Конец</p>';
    const bytes = await writeDocx(html, {});
    const back = await readDocx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(back.html).toMatch(/<h1[^>]*>.*Отчёт/);
    expect(back.html).toContain('text-align:center');
    expect(back.html).toContain('color:#ff0000');
    expect(back.html).toContain('font-size:16pt');
    const ps = [...new DOMParser().parseFromString(back.html, 'text/html').querySelectorAll('p')].map(p => p.textContent);
    expect(ps).toEqual(['Красный', '', 'Конец']);
  });
});
