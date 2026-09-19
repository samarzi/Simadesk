/**
 * Подготовка картинок для документов редактора.
 *
 * Содержимое документа целиком лежит в одной строке JSON/HTML: и в кеше
 * localStorage (квота ~5 МБ на весь домен), и в колонке docs_documents.content.
 * Фотография с телефона — это 3–6 МБ, а в base64 ещё на треть больше, так что
 * вставлять её как есть нельзя: документ перестанет помещаться и в кеш, и в
 * запрос. Поэтому перед вставкой картинка ужимается до разумного кадра и
 * пережимается в JPEG (PNG остаётся PNG только если в нём есть прозрачность).
 *
 * Если canvas недоступен (тесты в jsdom, экзотический браузер) — отдаём
 * оригинал: пусть лучше картинка вставится большой, чем не вставится вовсе.
 */

export interface PreparedImage {
  /** data:URL, готовый к записи в документ. */
  dataUrl: string;
  /** Размер для показа в документе, px. Может отсутствовать, если не смогли измерить. */
  w?: number;
  h?: number;
}

/** Картинку какого вида вообще можно вставлять. */
export function isSafeImageSrc(src: string): boolean {
  return /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(src) || /^https:\/\//i.test(src);
}

const LOAD_TIMEOUT_MS = 5000;

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  // Без таймаута зависшая загрузка подвешивает и вставку: jsdom картинки не
  // грузит вовсе, а https-ссылка может просто не ответить — ни onload,
  // ни onerror тогда не придут никогда.
  const timer = setTimeout(() => reject(new Error('Изображение не загрузилось')), LOAD_TIMEOUT_MS);
  img.onload = () => { clearTimeout(timer); resolve(img); };
  img.onerror = () => { clearTimeout(timer); reject(new Error('Не удалось открыть изображение')); };
  img.src = src;
});

/**
 * Ужать картинку под документ.
 * @param maxSide   максимальная сторона в пикселях самого файла
 * @param maxDisplay максимальная сторона кадра, в котором картинка показывается
 */
export async function prepareImage(src: string, maxSide = 1000, maxDisplay = 260): Promise<PreparedImage> {
  if (!isSafeImageSrc(src)) throw new Error('Недопустимый источник изображения');
  try {
    const img = await loadImage(src);
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    if (!nw || !nh) return { dataUrl: src };

    const scale = Math.min(1, maxSide / Math.max(nw, nh));
    const cw = Math.max(1, Math.round(nw * scale));
    const ch = Math.max(1, Math.round(nh * scale));

    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { dataUrl: src, ...displaySize(nw, nh, maxDisplay) };
    // GIF теряет анимацию при пережатии — оставляем как есть.
    const keepAsIs = /^data:image\/gif/i.test(src);
    ctx.drawImage(img, 0, 0, cw, ch);
    const png = canvas.toDataURL('image/png');
    const jpg = canvas.toDataURL('image/jpeg', 0.82);
    const out = keepAsIs ? src : (jpg.length < png.length ? jpg : png);
    // Пережатие не помогло (картинка и так мелкая) — берём меньшее из двух.
    const dataUrl = out.length < src.length ? out : src;
    return { dataUrl, ...displaySize(nw, nh, maxDisplay) };
  } catch {
    return { dataUrl: src };
  }
}

function displaySize(nw: number, nh: number, maxDisplay: number): { w: number; h: number } {
  const k = Math.min(1, maxDisplay / Math.max(nw, nh));
  return { w: Math.max(1, Math.round(nw * k)), h: Math.max(1, Math.round(nh * k)) };
}

/** Прочитать File как data:URL. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Ошибка чтения файла'));
    reader.readAsDataURL(file);
  });
}
