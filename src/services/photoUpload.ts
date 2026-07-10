/**
 * photoUpload — загрузка фото товара в Supabase Storage.
 * Если Storage не настроен — возвращает data:URL для локального превью.
 */

import { debug } from '@/utils/debug';
import { getAuthHeaders } from './dbClient';

const API_URL = (import.meta.env.VITE_API_URL as string) || '';
const BUCKET   = 'product-photos';

/** Загрузить файл в Supabase Storage, вернуть публичный URL */
export async function uploadPhoto(file: File, productId: string): Promise<string> {
  const ext  = file.name.split('.').pop() || 'jpg';
  const path = `${productId}/${Date.now()}.${ext}`;

  try {
    const res = await fetch(`${API_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        ...getAuthHeaders(),
        'Content-Type': file.type || 'image/jpeg',
        'x-upsert': 'true',
      },
      body: file,
    });

    if (res.ok) {
      return `${API_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    }

    const err = await res.text();
    // Если бакет не существует — пробуем создать
    if (res.status === 404 || err.includes('not found') || err.includes('Bucket not found')) {
      await createBucket();
      // Retry
      const res2 = await fetch(`${API_URL}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { ...getAuthHeaders(), 'Content-Type': file.type || 'image/jpeg', 'x-upsert': 'true' },
        body: file,
      });
      if (res2.ok) return `${API_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    }
    throw new Error(`Storage upload failed: ${res.status}`);
  } catch (e: any) {
    // Fallback: вернуть data URL (только для превью, не синхронизируется с МП)
    console.warn('[photoUpload] Storage недоступен, используем data:URL:', e.message);
    return await fileToDataUrl(file);
  }
}

async function createBucket(): Promise<void> {
  try {
    await fetch(`${API_URL}/storage/v1/bucket`, {
      method: 'POST',
      headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
    });
  } catch (e) { debug.warn('[photoUpload] swallowed error', e); }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/** Проверить — это data:URL (локальное превью) или настоящий URL */
export function isDataUrl(url: string): boolean {
  return url.startsWith('data:');
}
