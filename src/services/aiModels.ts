import { authService } from './authService';

export type AiScope = 'assistant' | 'quality' | 'rights' | 'storefront' | 'support' | 'prompt' | 'reviews' | 'news' | 'memory';
export const AI_AUTO = 'auto';
export const AI_SCOPE_LABELS: Record<AiScope, string> = {
  assistant: 'Ассистент Сима', quality: 'Анализ качества', rights: 'Анализ прав',
  storefront: 'Группировка товаров', support: 'Поддержка', prompt: 'Редактор промта',
  reviews: 'Ответы на отзывы', news: 'Обработка новостей', memory: 'Обновление знаний',
};
export interface AiModel {
  id: string; name: string; description: string; free: boolean;
  context: number | null; maxOutput: number | null; created: number | null;
  input: string[]; output: string[]; parameters: string[];
  knowledgeCutoff: string | null; expiration: string | null; tokenizer: string | null;
  instructType: string | null; moderated: boolean | null;
}
export interface ModelRequirements { vision?: boolean; tools?: boolean }
export interface AiCatalog { models: AiModel[]; auto: { text?: string; vision?: string; tools?: string } }
let cache: AiCatalog | null = null;
let cachedAt = 0;
let pending: Promise<AiCatalog> | null = null;
let cacheUser = '';
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const number = (v: unknown): number | null => v != null && Number.isFinite(Number(v)) ? Number(v) : null;

export function normalizeCatalog(raw: any): AiCatalog {
  if (!Array.isArray(raw?.data) || !raw.data.length) throw new Error('Каталог моделей пуст');
  return {
    models: raw.data.filter((m: any) => typeof m?.id === 'string').map((m: any): AiModel => {
      const modality = String(m.architecture?.modality ?? '').split('->');
      return {
        id: m.id, name: String(m.name || m.id), description: String(m.description || ''),
        free: m.is_free === true || m.id.endsWith(':free'),
        context: number(m.context_length), maxOutput: number(m.top_provider?.max_completion_tokens), created: number(m.created),
        input: strings(m.architecture?.input_modalities).length ? strings(m.architecture.input_modalities) : modality[0]?.split('+').filter(Boolean) ?? [],
        output: strings(m.architecture?.output_modalities).length ? strings(m.architecture.output_modalities) : modality[1]?.split('+').filter(Boolean) ?? [],
        parameters: strings(m.supported_parameters), knowledgeCutoff: m.knowledge_cutoff ?? null,
        expiration: m.expiration_date ?? null, tokenizer: m.architecture?.tokenizer ?? null,
        instructType: m.architecture?.instruct_type ?? null,
        moderated: typeof m.top_provider?.is_moderated === 'boolean' ? m.top_provider.is_moderated : null,
      };
    }),
    auto: raw.auto ?? {},
  };
}

export function selectedAiModel(scope: AiScope): string {
  try { return localStorage.getItem(`sd_ai_selection_v3_${scope}`) || AI_AUTO; }
  catch { return AI_AUTO; }
}
export function setAiModel(scope: AiScope, model: string): void {
  localStorage.setItem(`sd_ai_selection_v3_${scope}`, model || AI_AUTO);
  window.dispatchEvent(new CustomEvent('sd_ai_model_changed', { detail: { scope, model: model || AI_AUTO } }));
}
export function modelCompatible(m: AiModel, requirements: ModelRequirements = {}): boolean {
  return m.input.includes('text') && m.output.includes('text') &&
    (!requirements.vision || m.input.includes('image')) && (!requirements.tools || m.parameters.includes('tools'));
}
export function aiModelLabel(scope: AiScope): string {
  const id = selectedAiModel(scope);
  return id === AI_AUTO ? 'Авто · лучшая бесплатная' : cache?.models.find(m => m.id === id)?.name ?? id;
}
export function cachedAiCatalog(): AiCatalog | null { return cache; }
export async function loadAiCatalog(force = false): Promise<AiCatalog> {
  const user = authService.getUser()?.id ?? '';
  if (user !== cacheUser) { cache = null; pending = null; cacheUser = user; }
  if (!force && cache && Date.now() - cachedAt < 10 * 60_000) return cache;
  if (pending) return pending;
  const request = fetch(`${import.meta.env.VITE_API_URL || ''}/functions/v1/ai-models`, {
    headers: { Authorization: `Bearer ${authService.getAccessToken() ?? ''}` },
    signal: AbortSignal.timeout(30_000),
  }).then(async res => {
    const raw = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(raw.error?.message ?? raw.error ?? `Каталог недоступен (${res.status})`));
    const result = normalizeCatalog(raw);
    if (cacheUser === user) { cache = result; cachedAt = Date.now(); }
    return result;
  });
  pending = request;
  try { return await request; }
  finally { if (pending === request) pending = null; }
}

export function filterAiModels(models: AiModel[], query: string, options: {
  free?: boolean; vision?: boolean; tools?: boolean; reasoning?: boolean; minContext?: number;
} = {}): AiModel[] {
  const q = query.trim().toLocaleLowerCase();
  return models.filter(m => (!q || `${m.id} ${m.name} ${m.description}`.toLocaleLowerCase().includes(q)) &&
    (!options.free || m.free) && (!options.vision || m.input.includes('image')) &&
    (!options.tools || m.parameters.includes('tools')) && (!options.reasoning || m.parameters.includes('reasoning')) &&
    (m.context ?? 0) >= (options.minContext ?? 0));
}
