/**
 * Word-экспорт: проверяем то, что раньше молча терялось —
 * картинки, адреса ссылок, наследуемое оформление и пробелы.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { DocsModule } from '@/modules/DocsModule';

// Красный квадрат 2×3 в PNG — размеры зашиты в IHDR, их и должен прочитать код
const PNG_2x3 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA7ljmRAAAAEklEQVR4nGP8z4AATAxQxhAVAABr' +
  'FQEPAwGVfwAAAABJRU5ErkJggg==';

const HTML = `
<h1 style="color:#C00000">Заголовок</h1>
<p style="color:#1F4E79;font-family:Georgia">Обычный текст с <b>жирным</b> и <i>курсивом</i>.</p>
<p>Ссылка на <a href="https://example.com/a?x=1&amp;y=2">сайт</a> внутри абзаца.</p>
<p><img src="data:image/png;base64,${PNG_2x3}" alt="квадрат"></p>
<p>Формула H<sub>2</sub>O и степень x<sup>2</sup>.</p>
<ul><li>первый</li><li>второй</li></ul>
<table><tr><th>Колонка</th></tr><tr><td style="background-color:#FFFF00">Ячейка</td></tr></table>
`;

let files: Record<string, string> = {};
let media: string[] = [];
let docXml = '';
let relsXml = '';

beforeAll(async () => {
  const M: any = Object.create(DocsModule.prototype);
  let blob: Blob | null = null;
  M.download = (_n: string, b: Blob) => { blob = b; };

  await M.exportWordDocx({ id: 'd', type: 'word', title: 'T', content: HTML, updated_at: 0 });
  expect(blob).toBeTruthy();

  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(Buffer.from(await blob!.arrayBuffer()));
  // JSZip перечисляет и саму папку — она нам не нужна
  media = Object.keys(zip.files).filter(f => f.startsWith('word/media/') && !zip.files[f].dir);
  for (const name of ['word/document.xml', 'word/_rels/document.xml.rels', '[Content_Types].xml']) {
    files[name] = await zip.file(name)!.async('string');
  }
  docXml = files['word/document.xml'];
  relsXml = files['word/_rels/document.xml.rels'];
});

describe('картинки', () => {
  it('попадают в пакет как отдельный файл', () => {
    expect(media).toHaveLength(1);
    expect(media[0]).toMatch(/word\/media\/image1\.png$/);
  });

  it('вставляются в текст как w:drawing, а не выбрасываются', () => {
    expect(docXml).toContain('<w:drawing>');
    expect(docXml).toContain('<pic:pic');
  });

  it('размер берётся из заголовка PNG (2×3 px → EMU)', () => {
    const m = docXml.match(/<wp:extent cx="(\d+)" cy="(\d+)"\//);
    expect(m).toBeTruthy();
    expect(+m![1]).toBe(2 * 9525);
    expect(+m![2]).toBe(3 * 9525);
  });

  it('получают relationship и объявлены в Content_Types', () => {
    const rid = docXml.match(/<a:blip r:embed="(rId\d+)"/)![1];
    expect(relsXml).toContain(`Id="${rid}"`);
    expect(relsXml).toContain('Target="media/image1.png"');
    expect(files['[Content_Types].xml']).toContain('Extension="png"');
  });
});

describe('гиперссылки', () => {
  it('сохраняют адрес, а не только текст', () => {
    const rid = docXml.match(/<w:hyperlink r:id="(rId\d+)">/)?.[1];
    expect(rid).toBeTruthy();
    expect(relsXml).toContain('Target="https://example.com/a?x=1&amp;y=2"');
    expect(relsXml).toContain('TargetMode="External"');
  });

  it('текст ссылки остаётся внутри', () => {
    expect(docXml).toMatch(/<w:hyperlink[^>]*>[\s\S]*?сайт[\s\S]*?<\/w:hyperlink>/);
  });
});

describe('оформление', () => {
  it('цвет абзаца наследуется его текстом', () => {
    expect(docXml).toContain('<w:color w:val="1F4E79"/>');
  });

  it('заголовок получает стиль и свой цвет', () => {
    expect(docXml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(docXml).toContain('<w:color w:val="C00000"/>');
  });

  it('шрифт абзаца доезжает до runs', () => {
    expect(docXml).toContain('w:ascii="Georgia"');
  });

  it('нижний и верхний индексы не теряются', () => {
    expect(docXml).toContain('<w:vertAlign w:val="subscript"/>');
    expect(docXml).toContain('<w:vertAlign w:val="superscript"/>');
  });

  it('пробелы вокруг вложенных тегов сохраняются', () => {
    expect(docXml).toContain('xml:space="preserve"');
    expect(docXml).toMatch(/<w:t xml:space="preserve"> и <\/w:t>/);
  });

  it('списки получают нумерацию', () => {
    expect(docXml).toContain('<w:numPr>');
  });

  it('таблица со заливкой ячейки', () => {
    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('w:fill="FFFF00"');
  });
});
