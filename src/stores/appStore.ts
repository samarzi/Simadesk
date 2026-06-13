import { Box } from '@/types';
import { apiService } from '@/services/api';

// ── Generic reactive store ─────────────────────────────────────────────────

export class Store<T> {
  private value: T;
  private listeners: ((value: T) => void)[] = [];

  constructor(initialValue: T) {
    this.value = initialValue;
  }

  get(): T { return this.value; }

  set(newValue: T): void {
    this.value = newValue;
    this.notify();
  }

  update(updater: (current: T) => T): void {
    this.value = updater(this.value);
    this.notify();
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.push(listener);
    listener(this.value);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i > -1) this.listeners.splice(i, 1);
    };
  }

  private notify(): void {
    this.listeners.forEach(l => l(this.value));
  }
}

// ── Stores ─────────────────────────────────────────────────────────────────

export const boxes = new Store<Box[]>([]);
export const loading = new Store<boolean>(false);

// ── Box actions ────────────────────────────────────────────────────────────

export const boxActions = {
  async loadBoxes(): Promise<void> {
    try {
      loading.set(true);
      const list = await apiService.getBoxes();
      boxes.set(list || []);
    } finally {
      loading.set(false);
    }
  },

  addBox(box: Box): void {
    boxes.update(current => [...current, box]);
  },

  updateBox(id: string, updates: Partial<Box>): void {
    boxes.update(current =>
      current.map(b => b.id === id ? { ...b, ...updates } : b),
    );
  },

  removeBox(id: string): void {
    boxes.update(current => current.filter(b => b.id !== id));
  },

  findBox(id: string): Box | undefined {
    return boxes.get().find(b => b.id === id);
  },
};

// Keep loading store in sync with apiService loading state
apiService.onLoadingChange(isLoading => loading.set(isLoading));
