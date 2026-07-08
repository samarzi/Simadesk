import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { emptyState, evaluateGate } from './gate.ts';

Deno.test('здоровое чтение без отклонения от МРЦ → ok', () => {
  const state = emptyState();
  const r = evaluateGate(state, 1000, 1000);
  assertEquals(r.status, 'ok');
  assertEquals(state.consecutiveHealthy, 1);
  assertEquals(state.consecutiveAnomalies, 0);
});

Deno.test('здоровое чтение с отклонением от МРЦ → needs_adjust', () => {
  const state = emptyState();
  const r = evaluateGate(state, 1200, 1000);
  assertEquals(r.status, 'needs_adjust');
});

Deno.test('недавно скорректировано (кулдаун) → cooldown, несмотря на отклонение', () => {
  const state = emptyState();
  state.lastUpdateAt = new Date().toISOString();
  const r = evaluateGate(state, 1200, 1000);
  assertEquals(r.status, 'cooldown');
});

Deno.test('одна аномалия (showcase=null) → safe_mode, причина no_fresh_data', () => {
  const state = emptyState();
  const r = evaluateGate(state, null, 1000);
  assertEquals(r.status, 'safe_mode');
  assertEquals(r.reason, 'no_fresh_data');
  assertEquals(state.consecutiveAnomalies, 1);
});

Deno.test('одна аномалия с явной причиной (invalidReason) → safe_mode с этой причиной', () => {
  const state = emptyState();
  const r = evaluateGate(state, 1000, 1000, 'discount_out_of_range');
  assertEquals(r.status, 'safe_mode');
  assertEquals(r.reason, 'discount_out_of_range');
});

Deno.test('здоровое чтение после аномалии сбрасывает consecutiveAnomalies', () => {
  const state = emptyState();
  evaluateGate(state, null, 1000); // аномалия
  assertEquals(state.consecutiveAnomalies, 1);
  evaluateGate(state, 1000, 1000); // здоровое
  assertEquals(state.consecutiveAnomalies, 0);
  assertEquals(state.consecutiveHealthy, 1);
});

Deno.test('3 аномалии подряд → переход в paused на 3-й, не раньше', () => {
  const state = emptyState();
  const r1 = evaluateGate(state, null, 1000);
  assertEquals(r1.status, 'safe_mode');
  const r2 = evaluateGate(state, null, 1000);
  assertEquals(r2.status, 'safe_mode');
  const r3 = evaluateGate(state, null, 1000);
  assertEquals(r3.status, 'paused');
  assertEquals(state.paused, true);
  assertEquals(state.pausedReason, 'no_fresh_data');
  assertEquals(typeof state.pausedAt, 'string');
});

Deno.test('пока paused: аномалия продолжает возвращать paused и обновляет pausedReason', () => {
  const state = emptyState();
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000); // → paused, reason no_fresh_data
  const r = evaluateGate(state, 1000, 1000, 'discount_out_of_range'); // другая причина, всё ещё аномалия
  assertEquals(r.status, 'paused');
  assertEquals(r.reason, 'discount_out_of_range');
  assertEquals(state.paused, true);
});

Deno.test('пока paused: 1-2 здоровых чтения подряд НЕ снимают паузу', () => {
  const state = emptyState();
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000); // → paused

  const r1 = evaluateGate(state, 1000, 1000); // здоровое #1
  assertEquals(r1.status, 'paused');
  assertEquals(state.paused, true);

  const r2 = evaluateGate(state, 1000, 1000); // здоровое #2
  assertEquals(r2.status, 'paused');
  assertEquals(state.paused, true);
});

Deno.test('пока paused: 3 здоровых чтения подряд снимают паузу автоматически и сразу оценивают текущее чтение', () => {
  const state = emptyState();
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000); // → paused

  evaluateGate(state, 1000, 1000); // здоровое #1, ещё paused
  evaluateGate(state, 1000, 1000); // здоровое #2, ещё paused
  const r3 = evaluateGate(state, 1000, 1000); // здоровое #3 → авто-выход из паузы

  assertEquals(state.paused, false);
  assertEquals(state.pausedReason, undefined);
  assertEquals(state.pausedAt, undefined);
  // На том же вызове, которым снялась пауза, ячейка сразу оценивается по текущим данным
  assertEquals(r3.status, 'ok');
});

Deno.test('авто-выход из паузы с отклонением от МРЦ → needs_adjust в тот же вызов', () => {
  const state = emptyState();
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000); // → paused

  evaluateGate(state, 1200, 1000);
  evaluateGate(state, 1200, 1000);
  const r3 = evaluateGate(state, 1200, 1000); // 3-е здоровое, но отклоняется от МРЦ

  assertEquals(state.paused, false);
  assertEquals(r3.status, 'needs_adjust');
});

Deno.test('после снятия паузы новая серия из 3 аномалий снова ставит на паузу', () => {
  const state = emptyState();
  for (let i = 0; i < 3; i++) evaluateGate(state, null, 1000);
  assertEquals(state.paused, true);
  for (let i = 0; i < 3; i++) evaluateGate(state, 1000, 1000);
  assertEquals(state.paused, false);

  evaluateGate(state, null, 1000);
  evaluateGate(state, null, 1000);
  const r = evaluateGate(state, null, 1000);
  assertEquals(r.status, 'paused');
  assertEquals(state.paused, true);
});
