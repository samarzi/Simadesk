import { AI_AUTO, AI_SCOPE_LABELS, aiModelLabel, cachedAiCatalog, filterAiModels, loadAiCatalog, modelCompatible, selectedAiModel, setAiModel, type AiScope, type ModelRequirements } from '@/services/aiModels';
import '@/styles/ai-model-picker.css';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const tokens = (n: number | null) => n == null ? 'не указан' : new Intl.NumberFormat('ru-RU', { notation: 'compact' }).format(n);
const icon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6" y="6" width="12" height="12" rx="3"/><path d="M9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></svg>';

export function aiModelButton(scope: AiScope, requirements: ModelRequirements = {}): string {
  return `<button type="button" class="sd-model-button" data-ai-model-picker="${scope}" data-vision="${!!requirements.vision}" data-tools="${!!requirements.tools}" title="Выбрать модель OpenRouter: ${esc(AI_SCOPE_LABELS[scope])}">${icon}<span>${esc(aiModelLabel(scope))}</span><span aria-hidden="true">⌄</span></button>`;
}

export function refreshAiModelButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-ai-model-picker]').forEach(btn => {
    const scope = btn.dataset.aiModelPicker as AiScope;
    if (!AI_SCOPE_LABELS[scope]) return;
    btn.innerHTML = `${icon}<span>${esc(aiModelLabel(scope))}</span><span aria-hidden="true">⌄</span>`;
  });
}

let installed = false;
let active: HTMLDialogElement | null = null;
export function installAiModelPicker(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('click', e => {
    const btn = (e.target as Element)?.closest<HTMLElement>('[data-ai-model-picker]');
    if (!btn || btn.hasAttribute('disabled')) return;
    const scope = btn.dataset.aiModelPicker as AiScope;
    if (!AI_SCOPE_LABELS[scope]) return;
    openAiModelPicker(scope, { vision: btn.dataset.vision === 'true', tools: btn.dataset.tools === 'true' }, btn);
  });
  window.addEventListener('sd_ai_model_changed', refreshAiModelButtons);
}

export function openAiModelPicker(scope: AiScope, requirements: ModelRequirements = {}, opener?: HTMLElement): void {
  active?.close();
  active?.remove();
  const dialog = document.createElement('dialog');
  dialog.className = 'sd-model-dialog';
  active = dialog;
  dialog.setAttribute('aria-labelledby', 'sd-model-title');
  dialog.innerHTML = `<header class="sd-model-header"><div><small>OPENROUTER</small><h2 id="sd-model-title">${esc(AI_SCOPE_LABELS[scope])} · модель ИИ</h2></div><button type="button" class="sd-model-close" aria-label="Закрыть">×</button></header>
    <button type="button" class="sd-model-auto" data-select-auto><span class="sd-model-auto-icon">✦</span><span><b>Авто · лучшая бесплатная</b><small>Сервер подберёт модель под задачу и переключится на другую, если она не ответит.</small></span><span class="sd-model-auto-check"></span></button>
    <div class="sd-model-controls"><input type="search" placeholder="Поиск по названию, разработчику или возможностям…" aria-label="Поиск модели" autocomplete="off"><button type="button" data-reload title="Обновить каталог">↻</button></div>
    <div class="sd-model-filters"><label><input type="checkbox" data-filter="free" checked> Бесплатные</label><label><input type="checkbox" data-filter="vision" ${requirements.vision ? 'checked' : ''}> Фото</label><label><input type="checkbox" data-filter="tools" ${requirements.tools ? 'checked' : ''}> Инструменты</label><label><input type="checkbox" data-filter="reasoning"> Рассуждение</label><select aria-label="Сортировка"><option value="context">По контексту</option><option value="name">По имени</option><option value="new">Сначала новые</option></select></div>
    <div class="sd-model-status" role="status">Загружаем каталог…</div><div class="sd-model-list"></div>
    <footer class="sd-model-footer">${requirements.vision ? 'Для этой задачи нужна модель, которая видит изображения.' : requirements.tools ? 'Для этой задачи нужна поддержка инструментов.' : 'Выбор сохраняется для этого инструмента.'}</footer>`;
  document.body.append(dialog);
  dialog.showModal();
  const close = () => dialog.close();
  dialog.addEventListener('close', () => { dialog.remove(); if (active === dialog) active = null; opener?.focus(); });
  dialog.querySelector('.sd-model-close')!.addEventListener('click', close);
  dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close(); } });
  const search = dialog.querySelector<HTMLInputElement>('input[type=search]')!;
  const list = dialog.querySelector<HTMLElement>('.sd-model-list')!;
  const status = dialog.querySelector<HTMLElement>('.sd-model-status')!;
  const check = dialog.querySelector<HTMLElement>('.sd-model-auto-check')!;
  check.textContent = selectedAiModel(scope) === AI_AUTO ? '✓' : '';
  let catalog = cachedAiCatalog();
  let error = '';
  let loading = false;
  let shown = 50;
  const render = () => {
    const options: Record<string, boolean> = {};
    dialog.querySelectorAll<HTMLInputElement>('[data-filter]').forEach(el => { options[el.dataset.filter!] = el.checked; });
    const filtered = filterAiModels(catalog?.models ?? [], search.value, options);
    const sort = dialog.querySelector<HTMLSelectElement>('select')!.value;
    filtered.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'new' ? (b.created ?? 0) - (a.created ?? 0) : (b.context ?? 0) - (a.context ?? 0));
    const selected = selectedAiModel(scope);
    status.textContent = error || (loading ? 'Загружаем каталог OpenRouter…' : `${filtered.length} из ${catalog?.models.length ?? 0} моделей · сейчас ${aiModelLabel(scope)}`);
    status.classList.toggle('error', !!error);
    list.innerHTML = filtered.slice(0, shown).map(m => {
      const usable = modelCompatible(m, requirements);
      const capabilities = [m.free ? 'Бесплатная' : '', m.input.includes('image') ? 'Фото' : '', m.parameters.includes('tools') ? 'Инструменты' : '', m.parameters.includes('reasoning') ? 'Рассуждение' : '', `Контекст ${tokens(m.context)}`].filter(Boolean);
      return `<article class="sd-model-row${selected === m.id ? ' selected' : ''}${!usable ? ' incompatible' : ''}"><div class="sd-model-row-top"><div><b>${esc(m.name)}</b><small>${esc(m.id)}</small></div><button type="button" data-select-model="${esc(m.id)}" ${!usable || selected === m.id ? 'disabled' : ''}>${selected === m.id ? 'Выбрана ✓' : usable ? 'Выбрать' : 'Не подходит'}</button></div>
        <div class="sd-model-tags">${capabilities.map(c => `<span>${esc(c)}</span>`).join('')}</div>
        <details><summary>Возможности и описание</summary><p>${esc(m.description || 'Описание не предоставлено разработчиком.')}</p><dl><dt>Принимает</dt><dd>${esc(m.input.join(', '))}</dd><dt>Возвращает</dt><dd>${esc(m.output.join(', '))}</dd><dt>Контекст</dt><dd>${tokens(m.context)} токенов</dd><dt>Максимальный ответ</dt><dd>${tokens(m.maxOutput)} токенов</dd><dt>Параметры</dt><dd>${esc(m.parameters.join(', ') || 'не указаны')}</dd><dt>Знания до</dt><dd>${esc(m.knowledgeCutoff || 'не указано')}</dd><dt>Токенизатор</dt><dd>${esc(m.tokenizer || 'не указан')}</dd><dt>Формат инструкций</dt><dd>${esc(m.instructType || 'не указан')}</dd><dt>Модерация провайдера</dt><dd>${m.moderated == null ? 'не указана' : m.moderated ? 'да' : 'нет'}</dd><dt>Добавлена</dt><dd>${m.created ? new Date(m.created * 1000).toLocaleDateString('ru-RU') : 'не указано'}</dd><dt>Срок доступности</dt><dd>${esc(m.expiration || 'не указан')}</dd></dl></details></article>`;
    }).join('') || (!loading ? '<div class="sd-model-empty">Модели не найдены. Измените поиск или фильтры.</div>' : '');
    if (filtered.length > shown) list.insertAdjacentHTML('beforeend', '<button type="button" class="sd-model-more" data-more>Показать ещё 50</button>');
  };
  const sharedKey = ({ support: 'ai_support_model', news: 'ai_news_model', memory: 'ai_memory_model' } as Partial<Record<AiScope, string>>)[scope];
  let saving = false;
  const choose = async (model: string) => {
    if (saving) return;
    saving = true;
    try {
      if (sharedKey) {
        status.textContent = 'Сохраняем модель для фоновых заданий…';
        const { adminService } = await import('@/services/adminService');
        await adminService.saveSiteContent(sharedKey, AI_SCOPE_LABELS[scope], model);
      }
      setAiModel(scope, model); close();
    } catch (e) { status.textContent = `Не удалось сохранить: ${e instanceof Error ? e.message : String(e)}`; }
    finally { saving = false; }
  };
  dialog.querySelector('[data-select-auto]')!.addEventListener('click', () => { void choose(AI_AUTO); });
  list.addEventListener('click', e => {
    const target = e.target as Element;
    const btn = target.closest<HTMLButtonElement>('[data-select-model]');
    if (btn && !btn.disabled) void choose(btn.dataset.selectModel!);
    if (target.closest('[data-more]')) { shown += 50; render(); }
  });
  search.addEventListener('input', () => { shown = 50; render(); });
  dialog.querySelector('.sd-model-filters')!.addEventListener('change', () => { shown = 50; render(); });
  const load = async (force = false) => {
    loading = true; error = ''; render();
    try {
      if (sharedKey) {
        const { adminService } = await import('@/services/adminService');
        const saved = (await adminService.getSiteContent()).find(c => c.key === sharedKey)?.content || AI_AUTO;
        setAiModel(scope, saved);
        check.textContent = saved === AI_AUTO ? '✓' : '';
      }
      catalog = await loadAiCatalog(force); refreshAiModelButtons();
    }
    catch (e) { error = e instanceof Error ? e.message : String(e); }
    finally { loading = false; if (dialog.isConnected) render(); }
  };
  dialog.querySelector('[data-reload]')!.addEventListener('click', () => { void load(true); });
  void load();
  search.focus();
}
