import { describe, it, expect } from 'vitest';
import { takeSpeakableChunk } from '@/services/ttsStream';

/** Удобный хелпер: какой кусок реально будет отправлен на синтез. */
const chunk = (s: string, isFirst = true, done = false) =>
  s.slice(0, takeSpeakableChunk(s, isFirst, done));

describe('takeSpeakableChunk — нарезка потока на фразы для озвучки', () => {
  it('пока предложение не закончено — не отдаёт ничего', () => {
    expect(takeSpeakableChunk('Сейчас проверю остатки по', true, false)).toBe(0);
  });

  it('первая законченная фраза уходит на синтез сразу', () => {
    expect(chunk('Проверила остатки по всем магазинам. Дальше смотрю цены'))
      .toBe('Проверила остатки по всем магазинам. ');
  });

  it('очень короткий огрызок не режется — иначе речь рваная', () => {
    expect(takeSpeakableChunk('Да. Сейчас всё проверю и вернусь', true, false)).toBe(0);
  });

  it('десятичная дробь не считается концом предложения', () => {
    expect(takeSpeakableChunk('Маржа составила 12.5 процента по этому товару', true, false)).toBe(0);
  });

  it('дробь внутри фразы не мешает найти настоящий конец', () => {
    expect(chunk('Маржа составила 12.5 процента. Это ниже плана'))
      .toBe('Маржа составила 12.5 процента. ');
  });

  it('вопрос и восклицание — тоже границы фразы', () => {
    expect(chunk('Что будем делать дальше? Есть пара вариантов')).toBe('Что будем делать дальше? ');
    expect(chunk('Остатки закончились! Нужно срочно пополнить')).toBe('Остатки закончились! ');
  });

  it('закрывающая кавычка после точки остаётся в той же фразе', () => {
    expect(chunk('Товар называется «Чехол.» Дальше идёт описание товара'))
      .toBe('Товар называется «Чехол.» ');
  });

  it('последующие фразы копятся длиннее первой — речь ровнее', () => {
    const text = 'Всё готово. Остатки обновлены по трём магазинам и цены тоже.';
    // как первая — отдаём рано
    expect(takeSpeakableChunk(text, true, false)).toBe('Всё готово. '.length);
    // как последующая — ждём накопления
    expect(takeSpeakableChunk(text, false, false)).toBe(0);
  });

  it('длинное вступление без точки не заставляет ждать — режется по запятой', () => {
    const long = 'Я проверила остатки по всем подключённым магазинам на трёх маркетплейсах, '
      + 'затем сверила цены и нашла несколько расхождений';
    const got = takeSpeakableChunk(long, true, false);
    expect(got).toBeGreaterThan(0);
    expect(long.slice(0, got)).toMatch(/, $/);
  });

  it('для первой фразы порог реза ниже, чем для последующих', () => {
    // ~110 символов без единой точки: первую фразу уже режем, следующую копим
    const text = 'Я проверила остатки по всем подключённым магазинам на трёх маркетплейсах, '
      + 'затем сверила цены по каждому';
    expect(takeSpeakableChunk(text, true, false)).toBeGreaterThan(0);
    expect(takeSpeakableChunk(text, false, false)).toBe(0);
  });

  it('маркер нумерованного списка не принимается за конец фразы', () => {
    // «1. » — точка после цифры; резать здесь нельзя, иначе озвучка сыпется
    const list = '1. Проверить остатки по всем магазинам. 2. Обновить цены';
    expect(chunk(list)).toBe('1. Проверить остатки по всем магазинам. ');
  });

  it('короткое число с точкой в середине фразы не режет её', () => {
    expect(takeSpeakableChunk('Итого 5. Дальше', true, false)).toBe(0);
  });

  it('при закрытии входа остаток забирается целиком без точки', () => {
    expect(takeSpeakableChunk('Готово', false, true)).toBe('Готово'.length);
  });

  it('пустой и пробельный текст ничего не отдаёт даже при закрытии', () => {
    expect(takeSpeakableChunk('', true, true)).toBe(0);
    expect(takeSpeakableChunk('   \n  ', true, true)).toBe(0);
  });

  it('последовательная нарезка покрывает весь текст без потерь и дублей', () => {
    const text = 'Первое предложение готово. Второе предложение тоже готово. Третий хвост';
    let pos = 0;
    let isFirst = true;
    const parts: string[] = [];
    for (let i = 0; i < 10; i++) {
      const take = takeSpeakableChunk(text.slice(pos), isFirst, false);
      if (!take) break;
      parts.push(text.slice(pos, pos + take));
      pos += take;
      isFirst = false;
    }
    // финальный сброс забирает хвост
    const tail = takeSpeakableChunk(text.slice(pos), isFirst, true);
    parts.push(text.slice(pos, pos + tail));
    expect(parts.join('')).toBe(text);
  });
});
