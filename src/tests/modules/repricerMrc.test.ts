import { describe, it, expect } from 'vitest';
import { mrcEffectiveTarget, wbSellerPriceForMrc, type RepricerRule } from '@/modules/RepricerModule';

function makeRule(overrides: Partial<RepricerRule> = {}): RepricerRule {
  return {
    id: 'r1',
    marketplace: 'wb',
    storeId: 's1',
    storeName: 'Store',
    productId: 'p1',
    vendorCode: 'VC1',
    productTitle: 'Product',
    type: 'mrc',
    status: 'active',
    ...overrides,
  } as RepricerRule;
}

describe('mrcEffectiveTarget()', () => {
  it('returns mrcPrice as-is when mrcBuffer is not set', () => {
    const rule = makeRule({ mrcPrice: 1000 });
    expect(mrcEffectiveTarget(rule)).toBe(1000);
  });

  it('raises the target price to compensate for mrcBuffer', () => {
    // target * (1 - 10/100) = 1000  =>  target = 1000 / 0.9 ≈ 1111.11 -> round 1111
    const rule = makeRule({ mrcPrice: 1000, mrcBuffer: 10 });
    expect(mrcEffectiveTarget(rule)).toBe(1111);
  });

  it('ignores out-of-range mrcBuffer values (<=0 or >=100)', () => {
    expect(mrcEffectiveTarget(makeRule({ mrcPrice: 1000, mrcBuffer: 0 }))).toBe(1000);
    expect(mrcEffectiveTarget(makeRule({ mrcPrice: 1000, mrcBuffer: 100 }))).toBe(1000);
  });
});

describe('wbSellerPriceForMrc()', () => {
  it('raises seller price so the buyer sees exactly targetShowcase after seller discount', () => {
    // targetShowcase=1000, discount=20% => sellerPrice = ceil(1000 / 0.8) = 1250
    const sellerPrice = wbSellerPriceForMrc(1000, 20);
    expect(sellerPrice).toBe(1250);

    // Applying the seller discount back to sellerPrice must reproduce targetShowcase
    // (within 1 rub, since both sides round).
    const buyerPrice = sellerPrice * (1 - 20 / 100);
    expect(Math.abs(buyerPrice - 1000)).toBeLessThanOrEqual(1);
  });

  it('returns targetShowcase unchanged when there is no discount', () => {
    expect(wbSellerPriceForMrc(1000, 0)).toBe(1000);
  });

  it('falls back to a 15% markup when discount is 100% or more', () => {
    expect(wbSellerPriceForMrc(1000, 100)).toBe(1150);
  });

  it('does not double the discount when chained with mrcEffectiveTarget (regression)', () => {
    // Regression for the WB MRC "double discount" bug: applyRule() used to take the
    // already-discount-adjusted seller price from computePriceForProduct() and divide
    // it again by (1 - discount/100), inflating the price by ~the discount %.
    const rule = makeRule({ mrcPrice: 1000, mrcBuffer: 0 });
    const discount = 20;

    const targetShowcase = mrcEffectiveTarget(rule); // 1000
    const sellerPrice = wbSellerPriceForMrc(targetShowcase, discount); // 1250

    // applyRule() must send sellerPrice as-is — NOT sellerPrice / (1 - discount/100) again.
    const wrongDoubled = Math.round(sellerPrice / (1 - discount / 100));
    expect(sellerPrice).not.toBe(wrongDoubled);
    expect(sellerPrice).toBe(1250);
  });
});
