import { describe, it, expect, beforeEach } from 'vitest';
import { SupportSpamGuard, SUBSTANTIVE_LEN } from '@/services/supportSpamGuard';

const LONG = 'У меня не грузятся остатки по Ozon уже второй день подряд, помогите';
const SHORT = 'ау';

describe('SupportSpamGuard', () => {
  let g: SupportSpamGuard;
  beforeEach(() => { g = new SupportSpamGuard(); });

  const send = (text: string, now: number, hasAttachment = false, awaiting = true) =>
    g.register({ text, hasAttachment, awaitingOperator: awaiting, now });

  it('не мешает подробно описывать проблему несколькими длинными сообщениями', () => {
    expect(LONG.length).toBeGreaterThanOrEqual(SUBSTANTIVE_LEN);
    let t = 0;
    for (let i = 0; i < 6; i++) {
      // разный текст, отправлен быстро — но каждый содержательный
      expect(send(LONG + ' #' + i, (t += 1000))).toBe(0);
    }
    expect(g.spamScore).toBe(0);
  });

  it('не штрафует вложения, даже если подпись короткая', () => {
    let t = 0;
    for (let i = 0; i < 5; i++) {
      expect(send('вот скрин', (t += 500), true)).toBe(0);
    }
  });

  it('гасит очередь коротких сообщений подряд', () => {
    let t = 0;
    expect(send('привет', (t += 100))).toBe(0);      // score 1
    expect(send('ну что', (t += 100))).toBe(0);      // score 2
    const wait = send('алло', (t += 100));           // score 3 → пауза
    expect(wait).toBe(10);
    expect(g.cooldownLeft(t)).toBe(10);
  });

  it('увеличивает паузу при продолжении спама и упирается в минуту', () => {
    let t = 0;
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) waits.push(send(SHORT + i, (t += 100)));
    expect(waits.filter(w => w > 0)).toEqual([10, 20, 30, 40, 50, 60, 60, 60, 60, 60]);
  });

  it('считает повтор одного и того же текста спамом даже с паузами', () => {
    let t = 0;
    // длинный текст, но трижды один и тот же и с большими интервалами
    expect(send(LONG, (t += 60000))).toBe(0);
    expect(send(LONG, (t += 60000))).toBe(0);
    expect(send(LONG, (t += 60000))).toBe(0);
    expect(send(LONG, (t += 60000))).toBe(10);
  });

  it('не копит штраф, пока оператор отвечает', () => {
    let t = 0;
    for (let i = 0; i < 8; i++) {
      expect(send(SHORT, (t += 100), false, /* awaiting */ false)).toBe(0);
    }
    expect(g.spamScore).toBe(0);
  });

  it('содержательное сообщение снимает накопленный штраф', () => {
    let t = 0;
    send('эй', (t += 100));                 // 1
    send('ну', (t += 100));                 // 2
    expect(g.spamScore).toBe(2);
    send(LONG, (t += 100));                 // содержательное → 1
    expect(g.spamScore).toBe(1);
    expect(send('ало', (t += 100))).toBe(0); // 2 — ещё в пределах бесплатных
  });

  it('ответ оператора обнуляет паузу', () => {
    let t = 0;
    send('а', (t += 100)); send('б', (t += 100));
    expect(send('в', (t += 100))).toBe(10);
    g.reset();
    expect(g.cooldownLeft(t)).toBe(0);
    expect(g.spamScore).toBe(0);
  });

  it('короткие сообщения с большими паузами не считаются спамом', () => {
    let t = 0;
    for (let i = 0; i < 6; i++) {
      // разный текст, интервал больше порога очереди
      expect(send('ок' + i, (t += 30000))).toBe(0);
    }
    expect(g.spamScore).toBe(0);
  });
});
