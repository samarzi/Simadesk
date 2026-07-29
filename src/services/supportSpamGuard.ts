/**
 * Защита чата поддержки от спама в ожидании оператора.
 *
 * Задача тонкая: погасить очередь коротких сообщений и повторы одного и того же
 * вопроса, но НЕ мешать пользователю подробно описывать проблему несколькими
 * сообщениями и вложениями. Поэтому штрафуются только:
 *   • короткие сообщения, отправленные вплотную друг к другу;
 *   • дубли (тот же текст, что уже отправляли недавно).
 * Развёрнутый текст и любые вложения штраф наоборот снимают.
 */

/** Длина, начиная с которой сообщение считается содержательным. */
export const SUBSTANTIVE_LEN = 40;
/** Пауза между сообщениями, ниже которой короткие идут «очередью». */
export const BURST_GAP_MS = 8000;
/** Сколько штрафных очков разрешено до первой паузы. */
export const FREE_SCORE = 2;

export interface SendInfo {
  text: string;
  hasAttachment: boolean;
  /** Ждём ли ответа оператора (последнее сообщение — наше). */
  awaitingOperator: boolean;
  now: number;
}

export class SupportSpamGuard {
  private score = 0;
  private lastSendAt = 0;
  private recent: string[] = [];
  private cooldownUntil = 0;

  /** Сообщение содержательное: есть вложение или развёрнутый текст. */
  static isSubstantive(text: string, hasAttachment: boolean): boolean {
    return hasAttachment || text.trim().length >= SUBSTANTIVE_LEN;
  }

  /** Оператор ответил (или чат начат заново) — все штрафы снимаются. */
  reset(): void {
    this.score = 0;
    this.recent = [];
    this.cooldownUntil = 0;
  }

  cooldownLeft(now: number): number {
    return Math.max(0, Math.ceil((this.cooldownUntil - now) / 1000));
  }

  /** Текущий штрафной счёт — для диагностики и тестов. */
  get spamScore(): number { return this.score; }

  /**
   * Учесть отправленное сообщение.
   * Возвращает длительность назначенной паузы в секундах (0 — паузы нет).
   */
  register({ text, hasAttachment, awaitingOperator, now }: SendInfo): number {
    const norm = text.trim().toLowerCase();
    const gap = now - this.lastSendAt;
    this.lastSendAt = now;

    // Оператор уже отвечал — счёт спама не копим
    if (!awaitingOperator) {
      this.score = 0;
      this.recent = [norm];
      return 0;
    }

    // Вложение — всегда труд пользователя, а не спам. Пять скриншотов подряд с
    // одной подписью «вот скрин» дублями не считаем.
    if (hasAttachment) {
      this.recent = [...this.recent, norm].slice(-3);
      this.score = Math.max(0, this.score - 1);
      return 0;
    }

    const isDuplicate = norm.length > 0 && this.recent.includes(norm);
    this.recent = [...this.recent, norm].slice(-3);

    if (SupportSpamGuard.isSubstantive(text, hasAttachment) && !isDuplicate) {
      // Пользователь реально описывает проблему — снимаем накопленный штраф
      this.score = Math.max(0, this.score - 1);
      return 0;
    }

    if (isDuplicate || gap < BURST_GAP_MS) this.score++;

    if (this.score <= FREE_SCORE) return 0;

    // Пауза растёт с каждым лишним сообщением: 10 с, 20 с, … максимум минута
    const seconds = Math.min(60, 10 * (this.score - FREE_SCORE));
    this.cooldownUntil = now + seconds * 1000;
    return seconds;
  }
}
