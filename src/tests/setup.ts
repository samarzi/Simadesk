/**
 * Vitest global setup.
 * Runs before every test file.
 */

// Provide stub env variables so modules that read import.meta.env don't throw
import { vi } from 'vitest';

// @ts-expect-error — patching import.meta.env for tests
import.meta.env.VITE_API_URL = 'https://test.simadesk.ru';
// @ts-expect-error
import.meta.env.VITE_API_KEY = 'test-key';

// Silence console.log/warn in tests unless DEBUG=true
if (!process.env.DEBUG) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}
