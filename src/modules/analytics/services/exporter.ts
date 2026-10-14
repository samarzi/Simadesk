/**
 * Выгрузка аналитики в Excel / JSON.
 * exceljs грузится лениво — только когда пользователь нажал «Скачать».
 */

export type Cell = string | number | null;

export interface Sheet {
  name: string;
  /** Первая строка — заголовки. */
  rows: Cell[][];
  /** Формат числовых колонок по индексу: 'money' | 'money2' | 'pct' | 'qty' | 'int'. */
  formats?: Record<number, 'money' | 'money2' | 'pct' | 'qty' | 'int'>;
}

const NUM_FMT = {
  money:  '#,##0 "₽";-#,##0 "₽"',
  money2: '#,##0.00 "₽";-#,##0.00 "₽"',
  pct:    '0.00"%"',
  qty:    '#,##0.0',
  int:    '#,##0',
} as const;

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Имя файла: «simadesk-analytics-<что>-<дата>.xlsx». */
export function exportFileName(what: string, ext: string): string {
  const stamp = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `simadesk-${what}-${stamp}.${ext}`;
}

export async function exportXlsx(filename: string, sheets: Sheet[]): Promise<void> {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SimaDesk';
  wb.created = new Date();
  for (const sh of sheets) {
    // Excel не допускает в имени листа : \ / ? * [ ] и длину > 31
    const ws = wb.addWorksheet(sh.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31));
    sh.rows.forEach(r => ws.addRow(r));
    const header = ws.getRow(1);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF2F7' } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    const cols = Math.max(...sh.rows.map(r => r.length), 0);
    for (let c = 1; c <= cols; c++) {
      const col = ws.getColumn(c);
      const fmt = sh.formats?.[c - 1];
      if (fmt) col.numFmt = NUM_FMT[fmt];
      const width = Math.max(...sh.rows.map(r => String(r[c - 1] ?? '').length), 6);
      col.width = Math.min(60, width + 2);
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

export function exportJson(filename: string, data: unknown): void {
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
}
