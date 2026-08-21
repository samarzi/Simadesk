/**
 * Потоковая озвучка — Сима начинает говорить, пока ответ ещё печатается.
 *
 * Раньше озвучка ждала весь ответ модели, затем синтезировала весь текст одним
 * запросом и только потом играла: пользователь несколько секунд смотрел на
 * готовое сообщение в тишине.
 *
 * Здесь текст режется на фразы по мере стриминга. Как только готова первая
 * фраза — она уходит на синтез и играет, а следующие синтезируются параллельно,
 * пока звучит текущая. Звук стартует примерно на первой строке ответа.
 */

import { edgeTtsSynthesize, edgeTtsPlayBuffer, edgeTtsStop, edgeTtsGeneration } from './edgeTts';

/**
 * Минимальная длина первой фразы. Совсем короткие реплики («Готово.») звучат
 * рвано, поэтому копим хотя бы столько символов, прежде чем начать говорить.
 */
const FIRST_CHUNK_MIN = 12;
/** Последующие фразы делаем длиннее — так речь льётся ровнее. */
const NEXT_CHUNK_MIN = 45;
/**
 * Если предложение всё не кончается — режем по запятой/пробелу.
 * Для первой фразы порог низкий: иначе длинное вступление без точки
 * заставило бы пользователя ждать в тишине, ради чего всё и затевалось.
 */
const HARD_SPLIT_FIRST = 90;
const HARD_SPLIT_NEXT = 220;

/**
 * Найти длину префикса, который уже можно отправлять на синтез.
 * Возвращает 0, если готовой фразы пока нет.
 *
 * `done` = текст больше не дописывается, можно забирать остаток целиком.
 */
export function takeSpeakableChunk(buffer: string, isFirst: boolean, done: boolean): number {
  const text = buffer;
  if (!text.trim()) return 0;
  if (done) return text.length;

  const min = isFirst ? FIRST_CHUNK_MIN : NEXT_CHUNK_MIN;

  // Граница предложения: .!?… + пробел. Десятичные дроби (1.5) не режем.
  const sentenceRe = /[.!?…]["»)]?\s/g;
  let best = 0;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(text)) !== null) {
    const end = m.index + m[0].length;
    const before = text[m.index - 1];
    const after = text[end];
    // «1.5» / «12. » внутри числа — не конец предложения
    if (/\d/.test(before ?? '') && /\d/.test(after ?? '')) continue;
    if (end >= min) { best = end; break; }
  }
  if (best) return best;

  // Предложение затянулось — режем по запятой, затем по пробелу.
  const hardAt = isFirst ? HARD_SPLIT_FIRST : HARD_SPLIT_NEXT;
  if (text.length >= hardAt) {
    const window = text.slice(0, hardAt);
    const comma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '));
    if (comma >= min) return comma + 2;
    const space = window.lastIndexOf(' ');
    if (space >= min) return space + 1;
  }
  return 0;
}

/** Текст, который вообще не имеет смысла озвучивать. */
function isSpeakable(s: string): boolean {
  return /[\p{L}\p{N}]/u.test(s);
}

export interface TtsStreamOptions {
  rate: number;
  voice: string;
  /** Готовит текст к произношению (снятие markdown, эмодзи и т.п.). */
  clean: (s: string) => string;
  /** Речь фактически началась — можно подсветить кнопку. */
  onStart?: () => void;
  /** Очередь опустела и вход закрыт. */
  onEnd?: () => void;
}

/**
 * Сессия потоковой озвучки одного сообщения.
 * Живёт от начала стриминга до конца воспроизведения.
 */
export class TtsStreamSession {
  private pending: Array<Promise<ArrayBuffer | null>> = [];
  private draining = false;
  private inputClosed = false;
  private cancelled = false;
  private started = false;
  private spokenChars = 0;
  private isFirst = true;
  private readonly gen: number;

  constructor(private opts: TtsStreamOptions) {
    // Фиксируем поколение: если кто-то вызовет edgeTtsStop (новый запрос,
    // ручной стоп), эта сессия перестанет и синтезировать, и играть.
    this.gen = edgeTtsGeneration();
  }

  private get alive(): boolean {
    return !this.cancelled && this.gen === edgeTtsGeneration();
  }

  /**
   * Скормить накопленный видимый текст сообщения (целиком, а не дельту).
   * Сессия сама отслеживает, что уже озвучено.
   */
  feed(fullVisibleText: string): void {
    if (!this.alive || this.inputClosed) return;
    // Текст может укоротиться: например, начал печататься служебный JSON и был
    // вырезан. Тогда просто ждём — назад отыгрывать нечего.
    if (fullVisibleText.length <= this.spokenChars) return;
    this.pumpFrom(fullVisibleText, false);
  }

  /** Вход закрыт: доозвучить остаток и завершиться. */
  finish(fullVisibleText: string): void {
    if (!this.alive || this.inputClosed) return;
    this.inputClosed = true;
    if (fullVisibleText.length > this.spokenChars) {
      this.pumpFrom(fullVisibleText, true);
    }
    this.drain();
  }

  cancel(): void {
    this.cancelled = true;
    this.pending = [];
  }

  /** Успела ли сессия что-то произнести — по этому решаем, нужен ли обычный TTS. */
  get hasSpoken(): boolean { return this.started; }

  private pumpFrom(fullText: string, done: boolean): void {
    // За один вызов можем нарезать несколько готовых фраз.
    for (let guard = 0; guard < 32; guard++) {
      const rest = fullText.slice(this.spokenChars);
      if (!rest) break;
      const take = takeSpeakableChunk(rest, this.isFirst, done);
      if (!take) break;
      const raw = rest.slice(0, take);
      this.spokenChars += take;
      this.isFirst = false;
      const clean = this.opts.clean(raw);
      if (clean && isSpeakable(clean)) this.enqueue(clean);
      if (done) break; // остаток забрали целиком
    }
    this.drain();
  }

  private enqueue(text: string): void {
    // Синтез стартует сразу — следующая фраза готовится, пока играет текущая.
    const job = edgeTtsSynthesize(text, this.opts.rate, this.opts.voice)
      .catch(() => null);
    this.pending.push(job);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length) {
        if (!this.alive) return;
        const job = this.pending.shift()!;
        const buf = await job;
        if (!this.alive) return;
        if (!buf) continue;
        if (!this.started) { this.started = true; this.opts.onStart?.(); }
        await edgeTtsPlayBuffer(buf);
      }
    } finally {
      this.draining = false;
    }
    // Очередь пуста. Если вход закрыт и ничего не подъехало — сессия окончена.
    if (this.alive && this.inputClosed && !this.pending.length) {
      this.opts.onEnd?.();
    }
  }
}

export { edgeTtsStop as ttsStreamStopAll };
