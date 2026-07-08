/**
 * Чистая логика шлюза принятия решений для МРЦ (без Deno.serve/Supabase) — вынесена
 * из index.ts в отдельный модуль, чтобы её можно было покрыть `deno test` без
 * поднятия HTTP-сервера (Deno.serve выполняется на верхнем уровне index.ts).
 */

import {
  MRC_DEVIATION_THRESHOLD,
  MRC_DEVIATION_MIN_RUB,
  MRC_MAX_CONSECUTIVE_ANOMALIES,
  MRC_HEALTHY_READS_TO_RESUME,
} from '../../../src/modules/repricer/types.ts';
import type { MrcCellState } from '../../../src/modules/repricer/types.ts';

const PRODUCT_COOLDOWN_MS = 3_600_000; // 1 час между корректировками одной ячейки (только сервер)

export function emptyState(): MrcCellState {
  return { lastUpdateAt: null, consecutiveAnomalies: 0, consecutiveHealthy: 0, paused: false };
}

/** Витринная цена отклонилась от МРЦ? Порог: max(5₽, МРЦ×1%) — как в utils.ts:mrcShowcaseDeviated. */
export function deviated(showcase: number, target: number): boolean {
  if (target <= 0 || showcase <= 0) return false;
  const threshold = Math.max(MRC_DEVIATION_MIN_RUB, target * MRC_DEVIATION_THRESHOLD);
  return Math.abs(showcase - target) > threshold;
}

export function isCooling(lastUpdateAt: string | null): boolean {
  if (!lastUpdateAt) return false;
  return Date.now() - new Date(lastUpdateAt).getTime() < PRODUCT_COOLDOWN_MS;
}

/**
 * Единый явный шлюз решения "можно ли сейчас действовать с этой ячейкой" — слой между
 * получением данных (DATA LAYER) и расчётом цены (EXECUTION LAYER), одинаковый для
 * WB/Ozon/ЯМ. Мутирует state (счётчики и paused) — вызывающий обязан считать рулправило
 * "затронутым" (touchedRuleIds) после каждого вызова, иначе обновлённые счётчики не
 * переживут текущий запуск функции (persistRules пишет только затронутые правила).
 *
 *   - invalidReason задан или showcase неизвестен → аномалия: consecutiveAnomalies++,
 *     consecutiveHealthy=0. После MRC_MAX_CONSECUTIVE_ANOMALIES подряд аномалий —
 *     ячейка переходит в paused (автоматика остановлена для неё).
 *   - иначе → здоровое чтение: consecutiveHealthy++, consecutiveAnomalies=0. Если ячейка
 *     была paused — после MRC_HEALTHY_READS_TO_RESUME подряд здоровых чтений пауза
 *     снимается автоматически (а не только вручную, см. clearMrcPause на клиенте) —
 *     иначе разовая нормализация данных (например, WB на полчаса прислал верный discount,
 *     а у нас уже сотни ячеек на паузе) требовала бы вручную снимать паузу с каждой.
 *   - paused (и не снята в этом цикле) → paused, цену не считаем и не трогаем.
 *   - кулдаун → cooldown (недавно уже корректировали).
 *   - не отклонилось от МРЦ → ok.
 *   - иначе → needs_adjust (можно считать и применять новую цену).
 */
export type GateStatus = 'safe_mode' | 'cooldown' | 'ok' | 'needs_adjust' | 'paused';
export type GateResult = { status: GateStatus; reason?: string };

export function evaluateGate(
  state: MrcCellState,
  showcase: number | null,
  target: number,
  invalidReason?: string,
): GateResult {
  const isAnomaly = !!invalidReason || showcase == null;
  const reason = invalidReason ?? (showcase == null ? 'no_fresh_data' : undefined);

  if (isAnomaly) {
    state.consecutiveAnomalies += 1;
    state.consecutiveHealthy = 0;
  } else {
    state.consecutiveHealthy += 1;
    state.consecutiveAnomalies = 0;
  }

  if (state.paused) {
    if (!isAnomaly && state.consecutiveHealthy >= MRC_HEALTHY_READS_TO_RESUME) {
      state.paused = false;
      state.pausedReason = undefined;
      state.pausedAt = undefined;
      // не возвращаем — продолжаем обычную оценку ниже на основе текущего (здорового) чтения
    } else {
      if (isAnomaly) state.pausedReason = reason; // отражаем актуальную причину, пока ячейка на паузе
      return { status: 'paused', reason: state.pausedReason };
    }
  }

  if (isAnomaly) {
    if (state.consecutiveAnomalies >= MRC_MAX_CONSECUTIVE_ANOMALIES) {
      state.paused = true;
      state.pausedReason = reason;
      state.pausedAt = new Date().toISOString();
      return { status: 'paused', reason };
    }
    return { status: 'safe_mode', reason };
  }

  if (isCooling(state.lastUpdateAt)) return { status: 'cooldown' };
  if (!deviated(showcase as number, target)) return { status: 'ok' };
  return { status: 'needs_adjust' };
}
