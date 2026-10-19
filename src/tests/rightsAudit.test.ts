import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { assess, boundedBytes, loadAuditImage, observations, parseMegaPortfolio, permittedImageUrl, portfolioMatches, runRightsAudit, russianChecks, type Portfolio } from '../../backend/functions/telegram-auth/rights-audit';

const PHOTO = 'https://basket-45.wbbasket.ru/photo.webp';
const png = Uint8Array.from([137,80,78,71,13,10,26,10,...Array(30).fill(0)]);
const imageFetcher = vi.fn(async () => new Response(png));
const observation = { name: 'Рик и Морти', type: 'персонаж', source: 'photo' as const, evidence: 'Старик с голубыми волосами и мальчик в жёлтой футболке', location: 'принт в центре', confidence: .95, use_context: 'printed_design' };
const portfolio: Portfolio = { entries: [], status: 'live', checked_at: '2026-10-19T00:00:00Z', sources: [] };
beforeEach(() => { vi.stubGlobal('crypto', webcrypto); vi.clearAllMocks(); });

it('loads image bytes with their real format, hashes them and refuses SSRF / redirects', async () => {
  for (const url of ['http://ir.ozone.ru/p.jpg','https://ir.ozone.ru.evil.test/a','https://127.0.0.1/a','https://ir.ozone.ru@localhost/a','https://ir.ozone.ru:8443/a','https://seller.example/a']) expect(permittedImageUrl(url)).toBe(false);
  for (const url of [PHOTO,'https://ir.ozone.ru/a.jpg','https://cdn1.ozone.ru/a.jpg','https://avatars.mds.yandex.net/a']) expect(permittedImageUrl(url)).toBe(true);
  const loaded = await loadAuditImage(PHOTO, imageFetcher as typeof fetch);
  expect(loaded.proof).toMatchObject({ status: 'sent', bytes: png.length, mime: 'image/png' });
  expect(loaded.proof.sha256).toHaveLength(64);
  expect(loaded.dataUrl).toContain('data:image/png;base64,');
  expect(imageFetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
  await expect(loadAuditImage('https://localhost/x', imageFetcher as typeof fetch)).rejects.toThrow();
  expect(imageFetcher).toHaveBeenCalledOnce();
});

it('rejects HTML masquerading as an image and limits streamed bytes', async () => {
  await expect(loadAuditImage(PHOTO, (async () => new Response('<html>This is not an image</html>', { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch)).rejects.toThrow('JPEG');
  await expect(boundedBytes(new Response(new Uint8Array(100)), 50)).rejects.toThrow('слишком большой');
  await expect(boundedBytes(new Response('redirect', { status: 302 }), 50)).rejects.toThrow('302');
});

it('does not exempt foreign characters and never gives an unavailable photo a clean result', () => {
  expect(assess([observation], { status: 'sent', url: PHOTO }, true)).toBe('high');
  expect(assess([observation], { status: 'failed', url: PHOTO }, false)).toBe('insufficient');
  expect(assess([], { status: 'sent', url: PHOTO }, false)).toBe('insufficient');
  expect(assess([], { status: 'sent', url: PHOTO }, true)).toBe('none');
  expect(assess([{ ...observation, name: 'Неустановленная иллюстрация' }], { status: 'sent', url: PHOTO }, true)).toBe('medium');
});

it('matches public sources without converting them into authority or a licence', () => {
  const entries = parseMegaPortfolio('<a href="/brands/naruto/">Наруто</a><a href="/brands/kino/">КИНО</a><a href="https://evil.test/brands/x/">Fake</a><a href="/brands/naruto/">Подробнее</a>');
  expect(entries).toHaveLength(2);
  const p = { ...portfolio, entries };
  const hits = portfolioMatches([{ ...observation, name: 'Naruto Uzumaki' }], p);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ agency: 'MegaLicense', url: 'https://megalicense.ru/brands/naruto/', authority: 'unverified', territory: 'unverified', categories: 'unverified' });
  expect(portfolioMatches([{ ...observation, name: 'Кино', type: 'слово', evidence: 'билет в кино' }], p)).toHaveLength(0);
  expect(portfolioMatches([observation], p)).toHaveLength(0); // unknown is not a legal exemption
});

it('requires real quoted card text and preserves all supported observations', () => {
  expect(observations({ objects: [{ ...observation, source: 'title', evidence: 'Руки вверх' }] }, 'text', { title: 'Наруто футболка' })).toHaveLength(0);
  expect(observations({ objects: [{ ...observation, source: 'title', evidence: 'Наруто' }, { ...observation, source: 'description', evidence: 'Рик и Морти' }] }, 'text', { title: 'Наруто футболка', description: 'Принт Рик и Морти' })).toHaveLength(2);
});

it('separates copyright, trademarks, band names and common slogans in Russian checks', () => {
  expect(russianChecks(observation)).toContain('не требует регистрации');
  expect(russianChecks({ ...observation, type: 'логотип' })).toContain('МКТУ');
  expect(russianChecks({ ...observation, type: 'название группы' })).toContain('само по себе не доказывает');
  expect(russianChecks({ ...observation, type: 'слоган' })).toContain('Не любая короткая фраза');
  expect(assess([{ ...observation, type: 'текстовая разметка', name: 'Информационные надписи' }], { status: 'sent', url: PHOTO }, true)).toBe('none');
});

const fetcher = vi.fn(async (url: string | URL | Request) => {
  if (String(url) === 'https://megalicense.ru/') return new Response('<a href="/brands/naruto/">Наруто</a>');
  if (String(url) === 'https://brandmonitor.ru/') return new Response('Customer testimonial: Wenger SA and Victorinox AG');
  return new Response(png);
});
function answer(data: unknown, model = 'test-vision:free') { return { model, choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }; }

it('runs independent visual and text passes, sends bytes, reports grounding and does not accept invented owners', async () => {
  const complete = vi.fn(async (body: Record<string, unknown>) => {
    const serialized = JSON.stringify(body);
    return serialized.includes('image_url') ? answer({ image_observed: true, visual_description: 'Голубые волосы, белый халат, жёлтая футболка, принт на чёрном текстиле', detected_text: '', objects: [observation], rights_holder: 'Invented', risk: 'none' }) : answer({ objects: [{ name: 'Руки Вверх', type: 'название группы', source: 'title', evidence: 'Руки Вверх', confidence: .9 }] });
  });
  const result = await runRightsAudit({ photo_url: PHOTO, title: 'Футболка Руки Вверх' }, 'auto', complete, fetcher as typeof fetch);
  expect(complete).toHaveBeenCalledTimes(2);
  const visualBody = JSON.stringify(complete.mock.calls[0][0]);
  expect(visualBody).toContain('data:image/png;base64,');
  expect(visualBody).not.toContain('Футболка Руки Вверх');
  expect(visualBody).not.toContain(PHOTO);
  expect(JSON.stringify(complete.mock.calls[1][0])).not.toContain('image_url');
  const finding = JSON.parse(result.choices[0].message.content);
  expect(finding).toMatchObject({ risk: 'high', rights_holder: '', error: null, details: { jurisdiction: 'RU', legal_status: 'unverified', image: { status: 'sent', model_observed: true }, agencies: { status: 'unknown' } } });
  expect(finding.details.objects).toHaveLength(2);
  expect(result.usage.total_tokens).toBe(60);
});

it('keeps title findings when photo download fails, without claiming visual success', async () => {
  const complete = vi.fn(async () => answer({ objects: [{ name: 'Рик и Морти', type: 'название', source: 'title', evidence: 'Рик и Морти', confidence: .9 }] }));
  const result = await runRightsAudit({ photo_url: 'https://localhost/secret', title: 'Рик и Морти' }, 'auto', complete, fetcher as typeof fetch);
  const f = JSON.parse(result.choices[0].message.content);
  expect(f).toMatchObject({ risk: 'insufficient', details: { image: { status: 'failed', model_observed: false } } });
  expect(f.error).toContain('не поддерживается');
  expect(f.details.objects[0].source).toBe('title');
  expect(complete).toHaveBeenCalledOnce();
});

it('marks a failed or truncated pass incomplete instead of clearing a card', async () => {
  for (const failure of ['reject', 'truncated', 'no-objects']) {
    const complete = vi.fn(async (body: Record<string, unknown>) => {
      if (JSON.stringify(body).includes('image_url')) return answer({ image_observed: true, visual_description: 'Белая футболка без принта', objects: [] });
      if (failure === 'reject') throw new Error('upstream unavailable');
      const result = answer(failure === 'no-objects' ? {} : { objects: [] });
      if (failure === 'truncated') Object.assign(result.choices[0], { finish_reason: 'length' });
      return result;
    });
    const result = await runRightsAudit({ photo_url: PHOTO, title: 'Товар' }, 'auto', complete, fetcher as typeof fetch);
    expect(JSON.parse(result.choices[0].message.content).risk).toBe('insufficient');
  }
});
