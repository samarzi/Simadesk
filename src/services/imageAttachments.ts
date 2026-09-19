/**
 * imageAttachments — картинки, которые пользователь прислал ассистенту.
 *
 * Модель видит изображение, но вернуть его байты не может: в ответ она пишет
 * только текст. Поэтому вставить присланное фото в документ она сможет лишь
 * через ссылку — короткий идентификатор, который мы сами выдали вложению
 * («img1») и который умеем развернуть обратно в data:URL при вызове
 * инструмента. Здесь и живёт эта таблица соответствий.
 *
 * Только память вкладки: data:URL весят сотни килобайт, в localStorage им
 * не место (там и так тесно от кеша документов).
 */

export interface AttachedImage {
  /** Ссылка для модели: img1, img2 … */
  id: string;
  name: string;
  dataUrl: string;
  at: number;
}

const MAX_KEPT = 8;

class ImageAttachments {
  private items: AttachedImage[] = [];
  private seq = 0;

  /** Зарегистрировать вложение и получить ссылку для модели. */
  add(name: string, dataUrl: string): AttachedImage {
    // Одно и то же изображение, присланное повторно, не плодит ссылок.
    const same = this.items.find(i => i.dataUrl === dataUrl);
    if (same) return same;
    const item: AttachedImage = { id: `img${++this.seq}`, name: name || `Изображение ${this.seq}`, dataUrl, at: Date.now() };
    this.items.push(item);
    if (this.items.length > MAX_KEPT) this.items = this.items.slice(-MAX_KEPT);
    return item;
  }

  list(): AttachedImage[] { return [...this.items]; }

  /**
   * Развернуть ссылку модели в картинку.
   * Понимает «img2», «2», имя файла и пустую ссылку (= последняя присланная).
   */
  resolve(ref?: string | null): AttachedImage | null {
    if (!this.items.length) return null;
    const r = String(ref ?? '').trim();
    if (!r || /^(last|последн\w*)$/i.test(r)) return this.items[this.items.length - 1];
    const byId = this.items.find(i => i.id.toLowerCase() === r.toLowerCase());
    if (byId) return byId;
    const num = r.match(/^(?:img)?(\d+)$/i);
    if (num) {
      const byNum = this.items.find(i => i.id === `img${num[1]}`);
      if (byNum) return byNum;
      const idx = parseInt(num[1], 10) - 1;
      if (idx >= 0 && idx < this.items.length) return this.items[idx];
    }
    const byName = this.items.find(i => i.name.toLowerCase() === r.toLowerCase());
    if (byName) return byName;
    // Уже готовый data:URL модель прислать не может, но вдруг это ссылка https://
    if (/^https:\/\//i.test(r)) return { id: 'url', name: r, dataUrl: r, at: Date.now() };
    return null;
  }

  clear(): void { this.items = []; }
}

export const imageAttachments = new ImageAttachments();
