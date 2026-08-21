import { describe, it, expect } from 'vitest';
import { needsConfirmation, describePendingAction, CONFIRM_REQUIRED_ACTIONS } from '@/services/aiActionPolicy';

describe('needsConfirmation — что нельзя выполнять молча', () => {
  it('массовое создание задач требует подтверждения', () => {
    // Инцидент: на вопрос «какие товары закончились?» было молча создано 20 задач
    expect(needsConfirmation('create_oos_tasks')).toBe(true);
    expect(needsConfirmation('create_daily_brief')).toBe(true);
    expect(needsConfirmation('run_risk_audit')).toBe(true);
  });

  it('массовое изменение цен и остатков требует подтверждения', () => {
    expect(needsConfirmation('bulk_price_change')).toBe(true);
    expect(needsConfirmation('bulk_price_filtered')).toBe(true);
    expect(needsConfirmation('apply_price_delta')).toBe(true);
    expect(needsConfirmation('mp_bulk_update_stock')).toBe(true);
  });

  it('необратимое и уходящее наружу требует подтверждения', () => {
    expect(needsConfirmation('delete_task')).toBe(true);
    expect(needsConfirmation('invite_team_member')).toBe(true);
    expect(needsConfirmation('simastore_publish')).toBe(true);
    expect(needsConfirmation('reply_all_unanswered')).toBe(true);
  });

  it('чтение данных выполняется свободно — иначе ассистент бесполезен', () => {
    for (const name of [
      'mp_find_product', 'mp_stock_health', 'mp_compare_prices', 'mp_get_stores',
      'business_snapshot', 'fetch_analytics', 'fetch_reviews', 'get_ad_stats',
      'daily_checklist', 'list_repricer_rules', 'navigate_to',
    ]) {
      expect(needsConfirmation(name), name).toBe(false);
    }
  });

  it('точечные адресные правки не требуют подтверждения — они обратимы', () => {
    // пользователь сам называет артикул и значение, есть откат через «отмени»
    expect(needsConfirmation('mp_update_stock')).toBe(false);
    expect(needsConfirmation('mp_update_price')).toBe(false);
    expect(needsConfirmation('set_price')).toBe(false);
    expect(needsConfirmation('mark_task_done')).toBe(false);
  });

  it('неизвестное действие не блокируется по умолчанию', () => {
    expect(needsConfirmation('какое-то_новое_действие')).toBe(false);
  });
});

describe('describePendingAction — текст карточки подтверждения', () => {
  it('для OOS-задач объясняет группировку, а не просто «создам задачи»', () => {
    const t = describePendingAction('create_oos_tasks', {});
    expect(t).toMatch(/на маркетплейс/);
  });

  it('называет маркетплейс и размер изменения цены', () => {
    const t = describePendingAction('bulk_price_change', { mp: 'wb', delta: 10, percent: true });
    expect(t).toContain('WB');
    expect(t).toContain('10%');
  });

  it('различает рубли и проценты', () => {
    expect(describePendingAction('bulk_price_change', { mp: 'ozon', delta: 500 })).toContain('500 ₽');
  });

  it('для удаления предупреждает о необратимости', () => {
    const t = describePendingAction('delete_task', { title: 'Проверить остатки' });
    expect(t).toContain('Проверить остатки');
    expect(t).toMatch(/нельзя/i);
  });

  it('публикация и снятие витрины описаны по-разному', () => {
    const on = describePendingAction('simastore_publish', { publish: true });
    const off = describePendingAction('simastore_publish', { publish: false });
    expect(on).not.toBe(off);
    expect(off).toMatch(/перестанет/);
  });

  it('показывает количество позиций в массовом обновлении остатков', () => {
    const t = describePendingAction('mp_bulk_update_stock', { mp: 'yandex', items: [{}, {}, {}] });
    expect(t).toContain('3');
  });

  it('для действия без своего описания использует человеческую подпись', () => {
    expect(describePendingAction('какое_то_действие', {}, 'Понятное имя')).toContain('Понятное имя');
  });

  it('каждое требующее подтверждения действие имеет непустое описание', () => {
    for (const name of CONFIRM_REQUIRED_ACTIONS) {
      const t = describePendingAction(name, { items: [], delta: 1, mp: 'wb' });
      expect(t.length, name).toBeGreaterThan(10);
    }
  });
});
