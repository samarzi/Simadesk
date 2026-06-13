import { Product } from '@/types';

interface CacheEntry {
  boxId: string;
  products: Product[];
  savedAt: number;
}

const DB_NAME = 'simadesk-cache';
const STORE = 'products';
const TTL = 20 * 60 * 1000; // 20 minutes

class IdbCache {
  private db: IDBDatabase | null = null;

  async open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = e => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'boxId' });
        }
      };
      req.onsuccess = e => { this.db = (e.target as IDBOpenDBRequest).result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  }

  async get(boxId: string): Promise<Product[] | null> {
    if (!this.db) return null;
    return new Promise(resolve => {
      const req = this.db!.transaction(STORE, 'readonly').objectStore(STORE).get(boxId);
      req.onsuccess = () => {
        const entry: CacheEntry | undefined = req.result;
        resolve(entry && Date.now() - entry.savedAt < TTL ? entry.products : null);
      };
      req.onerror = () => resolve(null);
    });
  }

  async set(boxId: string, products: Product[]): Promise<void> {
    if (!this.db) return;
    return new Promise(resolve => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ boxId, products, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async remove(boxId: string): Promise<void> {
    if (!this.db) return;
    return new Promise(resolve => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(boxId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  /** Clear the entire cache (e.g. on logout or full refresh). */
  async clear(): Promise<void> {
    if (!this.db) return;
    return new Promise(resolve => {
      const tx = this.db!.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}

export const idbCache = new IdbCache();
