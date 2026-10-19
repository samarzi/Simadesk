/** OpenRouter catalog metadata used by the Analysis screen. Pricing is intentionally discarded. */
import { authService } from '@/services/authService';
export interface AnalysisModel {
  id: string;
  name: string;
  description: string;
  context_length: number | null;
  created: number | null;
  knowledge_cutoff: string | null;
  expiration_date: string | null;
  input_modalities: string[];
  output_modalities: string[];
  modality: string;
  tokenizer: string;
  instruct_type: string;
  supported_parameters: string[];
  max_completion_tokens: number | null;
  is_moderated: boolean | null;
}

export const ANALYSIS_MODEL_KEY = 'sd_analysis_model';
export const ANALYSIS_DEFAULT_MODEL = 'openai/gpt-4o-mini';
let catalogPromise: Promise<AnalysisModel[]> | null = null;

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function selectedAnalysisModel(): string {
  return localStorage.getItem(ANALYSIS_MODEL_KEY) || ANALYSIS_DEFAULT_MODEL;
}

export function modelSupportsText(model: AnalysisModel): boolean {
  return model.input_modalities.includes('text') && model.output_modalities.includes('text');
}

export function modelSupportsImages(model: AnalysisModel): boolean {
  return modelSupportsText(model) && model.input_modalities.includes('image');
}

export function loadAnalysisModels(force = false): Promise<AnalysisModel[]> {
  if (force || !catalogPromise) {
    catalogPromise = fetch(`${import.meta.env.VITE_API_URL}/functions/v1/ai-models`, {
      headers: { Authorization: `Bearer ${authService.getAccessToken() ?? ''}` },
    })
      .then(async res => {
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(String(detail.error ?? `Каталог моделей недоступен (HTTP ${res.status})`));
        }
        const json = await res.json();
        if (!Array.isArray(json.data)) throw new Error('Некорректный ответ каталога моделей');
        return json.data.filter((m: any) => typeof m.id === 'string').map((m: any): AnalysisModel => {
          const modality = String(m.architecture?.modality ?? '');
          return {
            id: m.id, name: String(m.name ?? m.id), description: String(m.description ?? ''),
            context_length: m.context_length != null && Number.isFinite(Number(m.context_length)) ? Number(m.context_length) : null,
            created: m.created != null && Number.isFinite(Number(m.created)) ? Number(m.created) : null,
            knowledge_cutoff: m.knowledge_cutoff == null ? null : String(m.knowledge_cutoff),
            expiration_date: m.expiration_date == null ? null : String(m.expiration_date),
            input_modalities: arrayOfStrings(m.architecture?.input_modalities).length
              ? arrayOfStrings(m.architecture.input_modalities)
              : modality.split('->')[0]?.split('+').filter(Boolean) ?? [],
            output_modalities: arrayOfStrings(m.architecture?.output_modalities).length
              ? arrayOfStrings(m.architecture.output_modalities)
              : modality.split('->')[1]?.split('+').filter(Boolean) ?? [],
            modality,
            tokenizer: String(m.architecture?.tokenizer ?? ''),
            instruct_type: String(m.architecture?.instruct_type ?? ''),
            supported_parameters: arrayOfStrings(m.supported_parameters),
            max_completion_tokens: m.top_provider?.max_completion_tokens != null && Number.isFinite(Number(m.top_provider.max_completion_tokens)) ? Number(m.top_provider.max_completion_tokens) : null,
            is_moderated: typeof m.top_provider?.is_moderated === 'boolean' ? m.top_provider.is_moderated : null,
          };
        });
      }).catch(e => { catalogPromise = null; throw e; });
  }
  return catalogPromise;
}
