export type SelCtxType = 'excel-cells' | 'text' | 'none';

export interface SelCtx {
  type: SelCtxType;
  /** Short label shown in the Sima chip */
  label: string;
  /** Text injected into the AI system prompt */
  prompt: string;
  /** Structured data for module AI actions */
  data?: unknown;
}

const NONE: SelCtx = { type: 'none', label: '', prompt: '' };

class SelectionContextService {
  private _current: SelCtx = NONE;
  private _listeners: Array<(ctx: SelCtx) => void> = [];

  get current(): SelCtx { return this._current; }

  set(ctx: SelCtx): void {
    this._current = ctx;
    this._listeners.forEach(l => l(ctx));
  }

  clear(): void { this.set(NONE); }

  subscribe(fn: (ctx: SelCtx) => void): () => void {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }
}

export const selectionCtx = new SelectionContextService();
