import { describe, it, expect } from 'vitest';
import { computeTargetPrice } from '@/modules/repricer/pricing';
import type { RepricerRule } from '@/modules/repricer/types';

const BASE: Omit<RepricerRule, 'type'> = {
  id: 'test',
  name: 'test',
  mp: 'ozon',
  products: [],
};

describe('computeTargetPrice() — target', () => {
  it('returns targetPrice directly', () => {
    const rule = { ...BASE, type: 'target' as const, targetPrice: 1500 };
    expect(computeTargetPrice(rule, { stock: 10, cost: null })).toBe(1500);
  });

  it('returns null when targetPrice is absent', () => {
    const rule = { ...BASE, type: 'target' as const };
    expect(computeTargetPrice(rule, { stock: 10, cost: null })).toBeNull();
  });
});

describe('computeTargetPrice() — margin', () => {
  it('multiplies cost by multiplier and rounds', () => {
    const rule = { ...BASE, type: 'margin' as const, marginMultiplier: 2 };
    expect(computeTargetPrice(rule, { stock: 5, cost: 500 })).toBe(1000);
  });

  it('returns null when cost is null', () => {
    const rule = { ...BASE, type: 'margin' as const, marginMultiplier: 2 };
    expect(computeTargetPrice(rule, { stock: 5, cost: null })).toBeNull();
  });

  it('returns null when marginMultiplier is 0/absent', () => {
    const rule = { ...BASE, type: 'margin' as const, marginMultiplier: 0 };
    expect(computeTargetPrice(rule, { stock: 5, cost: 500 })).toBeNull();
  });

  it('clamps to minPrice', () => {
    const rule = { ...BASE, type: 'margin' as const, marginMultiplier: 1.5, minPrice: 900 };
    expect(computeTargetPrice(rule, { stock: 5, cost: 500 })).toBe(900);
  });

  it('clamps to maxPrice', () => {
    const rule = { ...BASE, type: 'margin' as const, marginMultiplier: 3, maxPrice: 1200 };
    expect(computeTargetPrice(rule, { stock: 5, cost: 500 })).toBe(1200);
  });
});

describe('computeTargetPrice() — stock (multi-tier)', () => {
  const tiers = [
    { maxStock: 5, price: 2000 },
    { maxStock: 20, price: 1500 },
    { maxStock: 50, price: 1200 },
  ];
  const rule = { ...BASE, type: 'stock' as const, stockTiers: tiers };

  it('picks the first tier whose maxStock >= stock', () => {
    expect(computeTargetPrice(rule, { stock: 3, cost: null })).toBe(2000);
    expect(computeTargetPrice(rule, { stock: 5, cost: null })).toBe(2000);
    expect(computeTargetPrice(rule, { stock: 6, cost: null })).toBe(1500);
    expect(computeTargetPrice(rule, { stock: 20, cost: null })).toBe(1500);
    expect(computeTargetPrice(rule, { stock: 21, cost: null })).toBe(1200);
  });

  it('uses last tier when stock exceeds all thresholds', () => {
    expect(computeTargetPrice(rule, { stock: 100, cost: null })).toBe(1200);
  });
});

describe('computeTargetPrice() — stock (legacy single-tier)', () => {
  const rule = {
    ...BASE,
    type: 'stock' as const,
    stockThreshold: 10,
    highStockPrice: 1800,
    lowStockPrice: 1200,
  };

  it('uses highStockPrice when stock <= threshold', () => {
    expect(computeTargetPrice(rule, { stock: 10, cost: null })).toBe(1800);
    expect(computeTargetPrice(rule, { stock: 1, cost: null })).toBe(1800);
  });

  it('uses lowStockPrice when stock > threshold', () => {
    expect(computeTargetPrice(rule, { stock: 11, cost: null })).toBe(1200);
  });

  it('returns null when no tiers and no threshold', () => {
    const plain = { ...BASE, type: 'stock' as const };
    expect(computeTargetPrice(plain, { stock: 5, cost: null })).toBeNull();
  });
});

describe('computeTargetPrice() — schedule (multi-period)', () => {
  // Monday 14:30 = day 1, 870 minutes
  const monday14h30 = new Date('2026-07-27T14:30:00');

  const rule = {
    ...BASE,
    type: 'schedule' as const,
    schedulePeriods: [
      { days: [1, 2, 3, 4, 5], fromTime: '09:00', toTime: '18:00', price: 1000 },
      { days: [6, 0], fromTime: '10:00', toTime: '20:00', price: 800 },
    ],
  };

  it('matches weekday daytime period', () => {
    expect(computeTargetPrice(rule, { stock: 5, cost: null, now: monday14h30 })).toBe(1000);
  });

  it('returns null when outside all periods', () => {
    const monday22h = new Date('2026-07-27T22:00:00');
    expect(computeTargetPrice(rule, { stock: 5, cost: null, now: monday22h })).toBeNull();
  });

  it('matches weekend period', () => {
    const sunday12h = new Date('2026-07-26T12:00:00'); // Sunday
    expect(computeTargetPrice(rule, { stock: 5, cost: null, now: sunday12h })).toBe(800);
  });
});

describe('computeTargetPrice() — schedule (legacy weekday/weekend)', () => {
  const rule = {
    ...BASE,
    type: 'schedule' as const,
    weekdayPrice: 1100,
    weekendPrice: 900,
  };

  it('returns weekdayPrice on Monday', () => {
    const monday = new Date('2026-07-27T10:00:00');
    expect(computeTargetPrice(rule, { stock: 5, cost: null, now: monday })).toBe(1100);
  });

  it('returns weekendPrice on Sunday', () => {
    const sunday = new Date('2026-07-26T10:00:00');
    expect(computeTargetPrice(rule, { stock: 5, cost: null, now: sunday })).toBe(900);
  });
});

describe('computeTargetPrice() — formula', () => {
  it('evaluates a simple formula', () => {
    const rule = { ...BASE, type: 'formula' as const, formula: 'cost_price * 2' };
    expect(computeTargetPrice(rule, { stock: 5, cost: 400 })).toBe(800);
  });

  it('returns null when formula is absent', () => {
    const rule = { ...BASE, type: 'formula' as const };
    expect(computeTargetPrice(rule, { stock: 5, cost: 400 })).toBeNull();
  });

  it('returns null when formula uses cost_price but cost is null', () => {
    const rule = { ...BASE, type: 'formula' as const, formula: 'cost_price * 1.5' };
    expect(computeTargetPrice(rule, { stock: 5, cost: null })).toBeNull();
  });

  it('can use stock variable', () => {
    const rule = { ...BASE, type: 'formula' as const, formula: 'stock * 10' };
    expect(computeTargetPrice(rule, { stock: 7, cost: null })).toBe(70);
  });
});
