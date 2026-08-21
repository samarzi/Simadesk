import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Управляемые моки движка: синтез и воспроизведение резолвим вручную. */
const synthCalls: string[] = [];
const playOrder: string[] = [];
let generation = 0;
const deferredSynth = new Map<string, (v: ArrayBuffer | null) => void>();

vi.mock('@/services/edgeTts', () => ({
  edgeTtsGeneration: () => generation,
  edgeTtsStop: () => { generation++; },
  edgeTtsSynthesize: (text: string) => {
    synthCalls.push(text);
    return new Promise<ArrayBuffer>((resolve, reject) => {
      deferredSynth.set(text, (v) => (v ? resolve(v) : reject(new Error('fail'))));
    });
  },
  edgeTtsPlayBuffer: (buf: ArrayBuffer) => {
    playOrder.push(new TextDecoder().decode(buf));
    return Promise.resolve();
  },
}));

const { TtsStreamSession } = await import('@/services/ttsStream');

/** Буфер, по которому видно, какую фразу проигрывают. */
const bufFor = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer;
const settle = () => new Promise<void>(r => setTimeout(r, 0));

const makeSession = (over: Partial<{ onStart: () => void; onEnd: () => void }> = {}) =>
  new TtsStreamSession({
    rate: 1, voice: 'v', clean: (s: string) => s.trim(),
    onStart: over.onStart, onEnd: over.onEnd,
  });

beforeEach(() => {
  synthCalls.length = 0;
  playOrder.length = 0;
  deferredSynth.clear();
  generation = 0;
});

describe('TtsStreamSession — озвучка параллельно с печатью ответа', () => {
  it('синтез первой фразы стартует до конца ответа', async () => {
    const s = makeSession();
    s.feed('Проверила остатки по всем магазинам. Дальше');
    await settle();
    expect(synthCalls).toEqual(['Проверила остатки по всем магазинам.']);
  });

  it('следующая фраза синтезируется, пока играет текущая', async () => {
    const s = makeSession();
    s.feed('Первое предложение готово. ');
    await settle();
    s.feed('Первое предложение готово. Второе предложение тоже полностью готово и проверено до конца. ');
    await settle();
    // обе отправлены на синтез, хотя первая ещё не проиграна
    expect(synthCalls).toHaveLength(2);
    expect(playOrder).toHaveLength(0);
  });

  it('фразы играют строго по порядку, даже если синтез вернулся вразнобой', async () => {
    const s = makeSession();
    s.feed('Первое предложение готово. Второе предложение тоже полностью готово и проверено до конца. ');
    await settle();
    const [a, b] = synthCalls;
    // вторая фраза синтезировалась быстрее первой
    deferredSynth.get(b)!(bufFor('B'));
    await settle();
    expect(playOrder).toEqual([]);           // ждём первую, не перескакиваем
    deferredSynth.get(a)!(bufFor('A'));
    await settle();
    expect(playOrder).toEqual(['A', 'B']);
  });

  it('onStart срабатывает один раз, на первом реально прозвучавшем куске', async () => {
    const onStart = vi.fn();
    const s = makeSession({ onStart });
    s.feed('Первое предложение готово. Второе предложение тоже полностью готово и проверено до конца. ');
    await settle();
    for (const t of [...synthCalls]) deferredSynth.get(t)!(bufFor(t));
    await settle();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('finish дочитывает хвост без точки и завершает сессию', async () => {
    const onEnd = vi.fn();
    const s = makeSession({ onEnd });
    s.feed('Готово полностью. ');
    await settle();
    s.finish('Готово полностью. Остался хвост');
    await settle();
    expect(synthCalls).toEqual(['Готово полностью.', 'Остался хвост']);
    for (const t of [...synthCalls]) deferredSynth.get(t)?.(bufFor(t));
    await settle();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('одна и та же фраза не озвучивается дважды при повторной подаче', async () => {
    const s = makeSession();
    s.feed('Первое предложение готово. ');
    await settle();
    s.feed('Первое предложение готово. '); // тот же текст пришёл снова
    await settle();
    expect(synthCalls).toEqual(['Первое предложение готово.']);
  });

  it('cancel прекращает воспроизведение очереди', async () => {
    const onEnd = vi.fn();
    const s = makeSession({ onEnd });
    s.feed('Первое предложение готово. Второе предложение тоже полностью готово и проверено до конца. ');
    await settle();
    s.cancel();
    for (const t of [...synthCalls]) deferredSynth.get(t)!(bufFor(t));
    await settle();
    expect(playOrder).toEqual([]);
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('внешний стоп (новый запрос) глушит старую сессию', async () => {
    const s = makeSession();
    s.feed('Первое предложение готово. ');
    await settle();
    generation++; // эмулируем edgeTtsStop из нового запроса
    deferredSynth.get(synthCalls[0])!(bufFor('A'));
    await settle();
    expect(playOrder).toEqual([]);
  });

  it('сбой синтеза одной фразы не роняет остальные', async () => {
    const s = makeSession();
    s.feed('Первое предложение готово. Второе предложение тоже полностью готово и проверено до конца. ');
    await settle();
    const [a, b] = synthCalls;
    deferredSynth.get(a)!(null);          // первая упала
    deferredSynth.get(b)!(bufFor('B'));
    await settle();
    expect(playOrder).toEqual(['B']);
  });

  it('после закрытия входа новые куски игнорируются', async () => {
    const s = makeSession();
    s.finish('Всё готово.');
    await settle();
    const count = synthCalls.length;
    s.feed('Всё готово. И ещё одно длинное предложение сверху. ');
    await settle();
    expect(synthCalls).toHaveLength(count);
  });
});
