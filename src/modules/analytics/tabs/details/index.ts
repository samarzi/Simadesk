import { DetailCtx, DetailKey, isDetailKey, DETAIL_KEYS } from './shared';
import { renderRevenueDetail }   from './revenue';
import { renderGrossDetail }     from './gross';
import { renderProfitDetail }    from './profit';
import { renderMarginDetail }    from './margin';
import { renderDeliveredDetail } from './delivered';
import { renderExpensesDetail }  from './expenses';

export type { DetailCtx, DetailKey };
export { isDetailKey, DETAIL_KEYS };

export function renderDetail(key: DetailKey, ctx: DetailCtx): string {
  switch (key) {
    case 'revenue':   return renderRevenueDetail(ctx);
    case 'gross':     return renderGrossDetail(ctx);
    case 'profit':    return renderProfitDetail(ctx);
    case 'margin':    return renderMarginDetail(ctx);
    case 'delivered': return renderDeliveredDetail(ctx);
    case 'expenses':  return renderExpensesDetail(ctx);
  }
}
