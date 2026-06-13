# Design Document

## Introduction

This design addresses the bug in AnalyticsModule where Yandex.Market revenue calculation uses `priceForCustomer` (customer price) instead of the actual seller payout. The fix ensures accurate profit calculation that matches actual Yandex.Market payments of 460K instead of the current incorrect 1.2M.

## Design Approach

### Option 1: Modify Existing `calcYmRevenue` Method (Recommended)
**Pros**: Minimal changes, backward compatible, fixes the core issue
**Cons**: Requires understanding of Yandex.Market payout data structure

### Option 2: New API Integration
**Pros**: Most accurate data directly from source
**Cons**: Complex implementation, requires API keys, rate limiting

### Option 3: Hybrid Approach
**Pros**: Falls back to corrected calculation when API unavailable
**Cons**: More complex implementation

**Selected Approach**: Option 1 with fallback to transaction `amount` field where available.

## Architecture

### Current Architecture Issue
```typescript
// Current buggy implementation
private static calcYmRevenue(rawOrder: any): number {
  const items: any[] = rawOrder?.items ?? [];
  let rev = 0;
  for (const it of items) {
    const count = it.count ?? 1;
    if (it.priceForCustomer) {
      rev += it.priceForCustomer * count; // BUG: This is customer price, not seller payout
    }
    // ... rest of logic
  }
  return rev;
}
```

### Proposed Architecture
1. **Primary Data Source**: Transaction `amount` field (actual payout)
2. **Secondary Source**: Corrected calculation from `raw_json` using seller payout data
3. **Fallback**: Historical data with calibrated commission rates

## Component Design

### 1. Modified `calcYmRevenue` Method

```typescript
/**
 * Calculates Yandex.Market revenue using seller payout data instead of customer price
 * Uses hierarchy: transaction.amount > corrected accruals > priceForCustomer (as last resort)
 */
private static calcYmRevenueCorrected(tx: MpTransaction, rawOrder: any): number {
  // 1. First priority: actual payout amount from transaction
  if (tx.amount && tx.amount > 0) {
    return tx.amount;
  }
  
  // 2. Second priority: corrected accruals from raw_json (seller payout)
  const items: any[] = rawOrder?.items ?? [];
  let sellerPayout = 0;
  
  for (const it of items) {
    const count = it.count ?? 1;
    
    // Look for seller payout data in item.prices
    const sellerPrice = (it.prices ?? []).find((p: any) => p.type === 'SELLER' || p.type === 'AGENCY');
    if (sellerPrice?.total) {
      // total is already for all units
      sellerPayout += sellerPrice.total;
    } else if (sellerPrice?.costPerItem) {
      sellerPayout += sellerPrice.costPerItem * count;
    }
    // If no seller price found, fall back to priceForCustomer (with warning)
    else if (it.priceForCustomer) {
      console.warn(`[Analytics] Using priceForCustomer as fallback for YM item: ${it.sku}`);
      sellerPayout += it.priceForCustomer * count;
    }
  }
  
  // Apply any deductions already accounted for in raw_json
  const commissions = AnalyticsModule.calcYmCommissions(rawOrder);
  const totalDeductions = commissions.commission + commissions.delivery + commissions.other;
  
  // Return positive value (revenue should be positive)
  return Math.max(0, sellerPayout - totalDeductions);
}
```

### 2. Enhanced Revenue Calculation in `buildAnalytics`

```typescript
// In buildAnalytics() method:
let revenue = Math.max(0, tx.accruals_for_sale || 0);
let commission = Math.abs(tx.sale_commission || 0);

if (store.mp === 'yandex' && (tx.raw_json as any)) {
  // Use corrected revenue calculation
  revenue = Math.max(0, AnalyticsModule.calcYmRevenueCorrected(tx, tx.raw_json));
  
  // Calculate commissions from raw_json if not available
  if (commission === 0) {
    const ymC = AnalyticsModule.calcYmCommissions(tx.raw_json);
    commission = ymC.commission;
    // Store delivery and other for proper expense categorization
    (tx as any).__ymDelivery = ymC.delivery;
    (tx as any).__ymOther = ymC.other;
  }
}
```

### 3. Validation Layer

```typescript
/**
 * Validates Yandex.Market profit calculation against known payout patterns
 * Returns discrepancy percentage if validation fails
 */
private validateYmProfitCalculation(
  calculatedRevenue: number,
  calculatedExpenses: number,
  actualPayout: number
): { isValid: boolean; discrepancyPercent: number; warning?: string } {
  
  const calculatedNet = calculatedRevenue - calculatedExpenses;
  const discrepancy = Math.abs(calculatedNet - actualPayout);
  const discrepancyPercent = actualPayout > 0 ? (discrepancy / actualPayout) * 100 : 0;
  
  return {
    isValid: discrepancyPercent <= 10, // Allow 10% discrepancy
    discrepancyPercent,
    warning: discrepancyPercent > 10 
      ? `Yandex.Market profit discrepancy: ${discrepancyPercent.toFixed(1)}%` 
      : undefined
  };
}
```

## Data Flow

### Current (Buggy) Flow:
```
Yandex.Market Transaction → priceForCustomer → Revenue → Profit Calculation → 1.2M
```

### Proposed (Corrected) Flow:
```
Yandex.Market Transaction → Seller Payout Data → Actual Revenue → 
    Expense Categorization → Correct Profit Calculation → ~460K
```

## Integration Points

### 1. Transaction Database (mp_transactions)
- **Fields Used**: `amount`, `accruals_for_sale`, `sale_commission`, `raw_json`
- **Modifications**: None (read-only)

### 2. Cost Price Database (costPriceDb)
- **Integration**: COGS calculation remains unchanged
- **Note**: COGS is set separately in repricer, not part of this fix

### 3. Yandex.Market API (Optional Enhancement)
- **Endpoint**: `POST /reports/goods-realization/generate` for revenue validation
- **Endpoint**: `POST /reports/united-marketplace-services/generate` for expense validation
- **Fallback**: Use corrected calculations when API unavailable

## Error Handling

### Graceful Degradation Strategy:
1. **Level 1**: Use transaction `amount` field (most accurate)
2. **Level 2**: Calculate from `raw_json` seller prices (corrected)
3. **Level 3**: Fall back to `priceForCustomer` with warning (current buggy behavior)
4. **Level 4**: Use historical averages with validation warnings

### Validation Warnings:
- Display warning when discrepancy > 10%
- Provide reconciliation report
- Allow manual override for edge cases

## Testing Strategy

### Unit Tests:
1. `calcYmRevenueCorrected` with various `raw_json` structures
2. Profit validation with known payout patterns
3. Expense categorization accuracy

### Integration Tests:
1. End-to-end profit calculation for sample Yandex.Market transactions
2. Comparison with actual payout data (460K case)
3. Regression testing for WB and Ozon calculations

### Property-Based Tests:
1. Revenue calculation round-trip: parse → calculate → validate
2. Expense categorization consistency
3. Profit calculation invariants

## Performance Considerations

### Optimizations:
1. Cache corrected calculations per transaction
2. Batch processing for historical data
3. Lazy validation only when discrepancies detected

### Impact:
- Minimal performance impact (additional field lookups)
- Memory: O(1) per transaction
- CPU: Additional calculations for Yandex.Market transactions only

## Migration Plan

### Phase 1: Implementation
1. Add `calcYmRevenueCorrected` method
2. Update `buildAnalytics` to use corrected method
3. Add validation layer

### Phase 2: Validation
1. Compare results with historical data
2. Validate against known payout cases
3. Adjust commission calculations if needed

### Phase 3: Deployment
1. Deploy with feature flag
2. A/B test with sample users
3. Full rollout after validation

### Phase 4: Monitoring
1. Track profit calculation discrepancies
2. Monitor validation warnings
3. Collect user feedback

## Success Metrics

### Primary Metrics:
1. **Accuracy**: Calculated profit within 5% of actual payouts
2. **Coverage**: 95% of Yandex.Market transactions use corrected calculation
3. **Performance**: < 10% increase in calculation time

### Secondary Metrics:
1. **User Satisfaction**: Reduced support tickets about profit discrepancies
2. **Data Quality**: Increased use of actual payout data over estimated values
3. **System Health**: Validation warnings trigger appropriate user actions

## Risks and Mitigations

### Risk 1: Incorrect `raw_json` Parsing
- **Mitigation**: Extensive unit tests with real transaction samples
- **Fallback**: Transaction `amount` field as primary source

### Risk 2: Performance Impact
- **Mitigation**: Caching layer for repeated calculations
- **Monitoring**: Performance profiling in production

### Risk 3: Regression in Other Marketplaces
- **Mitigation**: Comprehensive regression test suite
- **Validation**: Cross-check WB and Ozon calculations before deployment

### Risk 4: Data Availability
- **Mitigation**: Graceful degradation with clear warnings
- **Documentation**: User guidance for data quality improvement