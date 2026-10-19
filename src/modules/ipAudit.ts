import { dbFetch, dbFetchAll } from '@/services/dbClient';
import { analysisAiFetch } from '@/services/aiProxy';
import { companyService } from '@/services/companyService';
import { reportAiUsage } from '@/services/aiUsage';
import { isFreeAiModel, recordAiSpend } from '@/services/aiTokenQuota';
import { exportXlsx, exportFileName } from './analytics/services/exporter';
import { AI_AUTO, loadAiCatalog, modelCompatible, selectedAiModel } from '@/services/aiModels';
import { aiModelButton } from '@/components/aiModelPicker';

export interface AuditCard {
  uid: string; mp: 'wb' | 'ozon' | 'yandex'; storeId: string; storeName: string;
  vendorCode: string; name: string; photoUrls: string[];
  nmId?: number; productId?: number;
}
type Risk = 'high' | 'medium' | 'low' | 'none' | 'insufficient';
type Review = 'unreviewed' | 'needs_review' | 'object_confirmed' | 'not_confirmed' | 'permitted' | 'needs_documents' | 'closed';
interface Run { id: string; company_id?: string; status: string; scope: string; total: number; processed: number; errors: number; created_at: string; finished_at?: string | null; product_keys: string[]; model_id: string; }
interface Finding {
  id: string; run_id: string; marketplace: string; store_id: string; product_id: string; vendor_code: string;
  product_name: string; product_brand: string; product_description: string; product_url: string | null;
  photo_url: string | null; photo_index: number; fingerprint: string; risk: Risk; object_type: string;
  object_name: string; rights_holder: string; reason: string; confidence: number | null;
  detected_text: string; details: Record<string, unknown>; error: string | null;
  review_status: Review; review_comment: string; evidence_url: string; created_at: string;
}
interface Reference { id: string; name: string; rights_holder: string; object_type: string; source_url: string; image_url: string; notes: string; }
const RISK_LABEL: Record<Risk, string> = { high: 'Высокий приоритет', medium: 'Средний приоритет', low: 'Низкий приоритет', none: 'Признаков нет', insufficient: 'Недостаточно данных' };
const REVIEW_LABEL: Record<Review, string> = { unreviewed: 'Не проверено', needs_review: 'Требует проверки', object_confirmed: 'Объект подтверждён', not_confirmed: 'Не подтверждено', permitted: 'Разрешено', needs_documents: 'Нужны документы', closed: 'Закрыто' };
const clean = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
const safeUrl = (s: string | null | undefined) => /^https:\/\//i.test(s ?? '') ? s || '' : '';
const productLink = (c: AuditCard): string => c.mp === 'wb' && c.nmId ? `https://www.wildberries.ru/catalog/${c.nmId}/detail.aspx` : '';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class IpAudit {
  runs: Run[] = [];
  findings: Finding[] = [];
  references: Reference[] = [];
  busy = false;
  message = '';
  section: 'overview' | 'results' | 'history' | 'references' | 'settings' = 'overview';
  filter = 'all';
  search = '';
  selectedRun = '';
  private stop = false;
  private companyId = '';
  private selectedStores: Set<string> | null = null;
  private shown = 100;
  private selectedFindings: Set<string> = new Set();
  constructor(private cards: () => AuditCard[], private description: (c: AuditCard) => Promise<string>, private paint: () => void) {}

  async load(): Promise<void> {
    const cid = companyService.getActiveId() ?? '';
    if (!cid) return;
    if (this.busy && this.companyId === cid) return;
    if (this.companyId !== cid) {
      this.stop = true; this.selectedRun = ''; this.selectedFindings.clear(); this.runs = []; this.findings = []; this.references = [];
      try {
        const saved = localStorage.getItem(`sd_ip_audit_stores_${cid}`);
        this.selectedStores = saved ? new Set(JSON.parse(saved) as string[]) : null;
      } catch { this.selectedStores = null; }
    }
    this.companyId = cid;
    try {
      const [runs, findings, refs] = await Promise.all([
        dbFetchAll<Run>(`ip_audit_runs?company_id=eq.${cid}&select=*&order=created_at.desc`),
        dbFetchAll<Finding>(`ip_audit_findings?company_id=eq.${cid}&select=*&order=created_at.desc`),
        dbFetchAll<Reference>(`ip_audit_references?company_id=eq.${cid}&select=*&order=created_at.desc`),
      ]);
      if (cid !== companyService.getActiveId()) return;
      this.runs = runs; this.findings = findings; this.references = refs;
      if (!this.selectedRun && runs.length) this.selectedRun = runs[0].id;
      this.message = '';
    } catch (e) { this.message = `Не удалось загрузить аудит: ${e instanceof Error ? e.message : String(e)}`; }
    this.paint();
  }

  setSection(v: typeof this.section): void { this.section = v; this.paint(); }
  setFilter(v: string): void { this.filter = v; this.shown = 100; this.paint(); }
  setSearch(v: string): void { this.search = v; this.shown = 100; this.paint(); }
  setRun(v: string): void { this.selectedRun = v; this.selectedFindings.clear(); this.shown = 100; this.paint(); }
  requestStop(): void { this.stop = true; this.message = 'Останавливаем после текущей карточки…'; this.paint(); }
  toggleSelect(id: string): void {
    if (this.selectedFindings.has(id)) this.selectedFindings.delete(id);
    else this.selectedFindings.add(id);
    this.paint();
  }
  selectAll(filtered: Finding[]): void {
    const ids = new Set(filtered.map(f => f.id));
    if (ids.size === this.selectedFindings.size && [...ids].every(id => this.selectedFindings.has(id))) {
      this.selectedFindings.clear();
    } else {
      this.selectedFindings = ids;
    }
    this.paint();
  }
  async bulkReview(status: Review, comment: string): Promise<void> {
    if (!this.selectedFindings.size) return;
    for (const id of this.selectedFindings) {
      const f = this.findings.find(x => x.id === id);
      if (f) {
        await dbFetch(`ip_audit_findings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ review_status: status, review_comment: comment, reviewed_at: new Date().toISOString() }) });
        Object.assign(f, { review_status: status, review_comment: comment });
      }
    }
    const count = this.selectedFindings.size;
    this.selectedFindings.clear();
    this.message = `Обновлено ${count} записей`;
    this.paint();
  }
  private storeIds(): Set<string> { return new Set(this.cards().map(c => c.storeId)); }
  private chosenStores(): Set<string> { return this.selectedStores ?? this.storeIds(); }
  private saveStores(): void {
    localStorage.setItem(`sd_ip_audit_stores_${this.companyId}`, JSON.stringify([...this.chosenStores()]));
    this.paint();
  }
  toggleStore(id: string): void {
    const chosen = this.chosenStores();
    if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
    this.selectedStores = chosen; this.saveStores();
  }
  toggleMarketplace(mp: AuditCard['mp']): void {
    const chosen = this.chosenStores();
    const ids = [...new Set(this.cards().filter(c => c.mp === mp).map(c => c.storeId))];
    const all = ids.every(id => chosen.has(id));
    for (const id of ids) if (all) chosen.delete(id); else chosen.add(id);
    this.selectedStores = chosen; this.saveStores();
  }

  async start(scope: 'sample' | 'all' | 'new' | 'selected', selection = ''): Promise<void> {
    if (this.busy) return;
    if (!this.companyId) await this.load();
    const cid = this.companyId;
    const chosen = this.chosenStores();
    const all = this.cards().filter(c => chosen.has(c.storeId));
    let cards = scope === 'selected' ? all.filter(c => c.vendorCode === selection.trim() || c.uid === selection.trim()) : all;
    if (scope === 'sample') {
      const buckets = (['wb', 'ozon', 'yandex'] as const).map(mp => cards.filter(c => c.mp === mp));
      const balanced: AuditCard[] = [];
      while (balanced.length < 50 && buckets.some(b => b.length)) for (const bucket of buckets) {
        const next = bucket.shift(); if (next && balanced.length < 50) balanced.push(next);
      }
      cards = balanced;
    }
    if (scope === 'new') {
      const done = new Set(this.findings.filter(f => !f.error && f.details?.audit_version === 'ru-photo-v4' && f.photo_index === -1).map(f => `${f.marketplace}:${f.store_id}:${f.product_id}`));
      cards = cards.filter(c => !done.has(`${c.mp}:${c.storeId}:${c.uid}`));
    }
    if (!cards.length) { this.message = 'Нет карточек для выбранной проверки.'; this.paint(); return; }
    if (scope === 'all' && !this.runs.some(r => r.scope === 'sample' && r.status === 'completed')) {
      this.message = 'Сначала завершите пробную проверку 50 карточек и просмотрите результаты.'; this.paint(); return;
    }
    this.busy = true; this.message = 'Готовим проверку…'; this.paint();
    try {
      const modelId = selectedAiModel('rights');
      if (modelId !== AI_AUTO) {
        const model = (await loadAiCatalog()).models.find(m => m.id === modelId);
        if (!model || !modelCompatible(model, { vision: true })) throw new Error('Выберите модель с поддержкой фото или режим Авто.');
      }
      if (cid !== companyService.getActiveId()) throw new Error('Компания изменилась. Запустите проверку заново.');
      const rows = await dbFetch<Run[]>('ip_audit_runs', { method: 'POST', body: JSON.stringify({ company_id: cid, scope, total: cards.length, product_keys: cards.map(c => c.uid), model_id: modelId }) });
      const run = rows[0];
      this.runs.unshift(run); this.selectedRun = run.id; this.section = 'results'; this.paint();
      await this.execute(run, cards);
    } catch (e) { this.busy = false; this.message = `Запуск не удался: ${e instanceof Error ? e.message : String(e)}`; this.paint(); }
  }

  async resume(id: string): Promise<void> {
    if (this.busy) return;
    const run = this.runs.find(r => r.id === id);
    if (!run) return;
    this.selectedRun = id; this.section = 'results';
    const targets = new Set(run.product_keys ?? []);
    const cards = this.cards().filter(c => {
      if (!targets.has(c.uid)) return false;
      const saved = this.findings.filter(f => f.run_id === id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid && !f.error);
      return !saved.some(f => f.photo_index === -1) && saved.length < (c.photoUrls.length || 1);
    });
    await this.execute(run, cards);
  }

  private async execute(run: Run, cards: AuditCard[]): Promise<void> {
    const runCompany = run.company_id || this.companyId;
    this.busy = true; this.stop = false; this.message = 'Проверяем карточки последовательно…'; this.paint();
    try {
      await this.patchRun(run, { status: 'running' });
      const completed = new Set(this.cards().filter(c => {
        if (!(run.product_keys ?? []).includes(c.uid)) return false;
        const saved = this.findings.filter(f => f.run_id === run.id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid && !f.error);
        return saved.some(f => f.photo_index === -1) || saved.length >= (c.photoUrls.length || 1);
      }).map(c => c.uid));
      let transientErrors = 0;
      let consecutiveErrors = 0;
      for (const c of cards) {
        if (this.stop || runCompany !== companyService.getActiveId()) break;
        let cardHadError = false;
        try {
          let desc = '', descriptionError = '';
          try { desc = await this.description(c); }
          catch (e) { descriptionError = `Описание маркетплейса не загружено: ${e instanceof Error ? e.message : String(e)}`; }
          if (this.findings.some(f => f.run_id === run.id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid && f.photo_index === -1 && !f.error)) {
            completed.add(c.uid);
            continue;
          }
          const photos = [...new Set(c.photoUrls.filter(safeUrl))];
          const fingerprint = await this.hash(`ru-photo-v4\n${run.id}\n${run.model_id}\n${JSON.stringify(this.references)}\n${c.name}\n${desc}\n${photos.join('\n')}`);
          // Send the complete photo set in one model request and save one card-level result.
          const result = await this.analyze(c, desc, photos, run.model_id);
          if (descriptionError) {
            result.details.description_error = descriptionError;
            result.error = [result.error, descriptionError].filter(Boolean).join('; ');
            if (result.risk === 'none' || result.risk === 'low') result.risk = 'insufficient';
          }
          if (runCompany !== companyService.getActiveId()) { this.stop = true; break; }
          const row = { company_id: runCompany, run_id: run.id, marketplace: c.mp, store_id: c.storeId,
            product_id: c.uid, vendor_code: c.vendorCode, product_name: c.name, product_brand: '',
            product_description: desc, product_url: productLink(c), photo_url: photos[0] ?? null, photo_index: -1,
            fingerprint, ...result };
          const saved = await dbFetch<Finding[]>('ip_audit_findings?on_conflict=run_id,marketplace,store_id,product_id,photo_index', {
            method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row),
          });
          this.findings = this.findings.filter(f => f.id !== saved[0].id);
          this.findings.unshift(saved[0]);
          if (result.error) cardHadError = true;
          this.paint();
          await pause(450);
        } catch (e) { transientErrors++; cardHadError = true; this.message = `Ошибка карточки ${c.vendorCode}: ${e instanceof Error ? e.message : String(e)}`; }
        if (runCompany !== companyService.getActiveId()) { this.stop = true; break; }
        run.errors = this.findings.filter(f => f.run_id === run.id && f.error).length + transientErrors;
        if (this.findings.some(f => f.run_id === run.id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid && f.photo_index === -1 && !f.error)) completed.add(c.uid);
        run.processed = completed.size;
        await this.patchRun(run, { processed: run.processed, errors: run.errors });
        this.paint();
        consecutiveErrors = cardHadError ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= 5) throw new Error('Пять карточек подряд завершились ошибкой. Проверьте доступ к ИИ и фото, затем продолжите.');
      }
      const complete = !this.stop && run.processed >= run.total;
      await this.patchRun(run, { status: complete ? 'completed' : 'paused', finished_at: complete ? new Date().toISOString() : null });
      this.message = complete ? run.errors ? `Обход завершён. Ошибок: ${run.errors}. Повторите незавершённые проверки кнопкой «Продолжить».` : 'Проверка завершена.' : 'Проверка приостановлена. Её можно продолжить.';
    } catch (e) {
      this.message = `Проверка прервана: ${e instanceof Error ? e.message : String(e)}`;
      await this.patchRun(run, { status: 'paused' }).catch(() => {});
    } finally { this.busy = false; this.paint(); }
  }

  private async patchRun(run: Run, patch: Partial<Run>): Promise<void> {
    await dbFetch(`ip_audit_runs?id=eq.${run.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
    Object.assign(run, patch);
  }
  private async hash(input: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  private async analyze(c: AuditCard, desc: string, photos: string[], modelId: string): Promise<Pick<Finding, 'risk'|'object_type'|'object_name'|'rights_holder'|'reason'|'confidence'|'detected_text'|'details'|'error'>> {
    if (photos.some(photo => !safeUrl(photo))) return { risk: 'insufficient', object_type: '', object_name: '', rights_holder: '', reason: 'Недопустимый URL фотографии', confidence: null, detected_text: '', details: {}, error: 'Недоступный URL' };
    try {
      const res = await analysisAiFetch({ model: modelId, rights_audit: {
        photo_urls: photos, title: c.name, description: desc, marketplace: c.mp,
        references: this.references.slice(0, 100),
      } }, undefined, 'rights');
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(String(detail.error?.message ?? `ИИ ответил HTTP ${res.status}`));
      }
      const body = await res.json();
      const raw = body.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') throw new Error('Пустой ответ ИИ');
      const data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      const actualModels = Array.isArray(data.details?.actual_models) ? data.details.actual_models.map(String) : [String(body.model || modelId)];
      const freeModels = actualModels.length > 0 && actualModels.every(isFreeAiModel);
      const usage = reportAiUsage('Анализ прав', body, { model: String(body.model || modelId), free: freeModels });
      if (usage) recordAiSpend(usage, body.model || modelId);
      if (data.details?.audit_version !== 'ru-photo-v4') throw new Error('Сервер не подтвердил проверку всех фото и источников для РФ. Обновите страницу и повторите.');
      const risk: Risk = ['high','medium','low','none','insufficient'].includes(data.risk) ? data.risk : 'insufficient';
      return { risk, object_type: String(data.object_type ?? ''), object_name: String(data.object_name ?? ''),
        rights_holder: '', reason: String(data.reason ?? ''),
        confidence: typeof data.confidence === 'number' && Number.isFinite(data.confidence) ? Math.max(0, Math.min(1, data.confidence)) : null,
        detected_text: String(data.detected_text ?? ''),
        details: { ...(data.details && typeof data.details === 'object' ? data.details : {}), actual_model: body.model || modelId },
        error: typeof data.error === 'string' ? data.error : null };
    } catch (e) { return { risk: 'insufficient', object_type: '', object_name: '', rights_holder: '', reason: 'Анализ не завершён', confidence: null, detected_text: '', details: {}, error: e instanceof Error ? e.message : String(e) }; }
  }

  async review(id: string, status: Review, comment: string, evidence: string): Promise<void> {
    const f = this.findings.find(x => x.id === id); if (!f) return;
    await dbFetch(`ip_audit_findings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ review_status: status, review_comment: comment, evidence_url: evidence, reviewed_at: new Date().toISOString() }) });
    Object.assign(f, { review_status: status, review_comment: comment, evidence_url: evidence }); this.paint();
  }
  async searchSource(id: string): Promise<void> {
    const f = this.findings.find(x => x.id === id);
    if (!f) return;
    this.message = `Ищем информацию об объекте: ${f.object_name || f.rights_holder}...`;
    this.paint();
    try {
      const searchQuery = f.object_name || f.rights_holder || f.object_type;
      if (!searchQuery) {
        this.message = 'Нет названия объекта для поиска';
        this.paint();
        return;
      }
      // Используем встроенный web_search для поиска информации
      const searchTerms = [
        `${searchQuery} товарный знак`,
        `${searchQuery} интеллектуальная собственность`,
        `${searchQuery} официальный сайт`
      ];
      const results: string[] = [];
      for (const term of searchTerms.slice(0, 2)) {
        try {
          // Для простоты - формируем поисковые URL
          results.push(`https://www.google.com/search?q=${encodeURIComponent(term)}`);
          results.push(`https://search.rusprofile.ru/search?q=${encodeURIComponent(term)}`);
        } catch { /* ignore */ }
      }
      if (results.length) {
        f.details.search_sources = results;
        await dbFetch(`ip_audit_findings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ details: f.details }) });
        this.message = 'Подготовлены ссылки для самостоятельного поиска. Источники ещё не проверены.';
      } else {
        this.message = 'Не удалось найти источники';
      }
    } catch (e) {
      this.message = `Ошибка поиска: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.paint();
  }
  async addReference(form: HTMLFormElement): Promise<void> {
    const data = new FormData(form);
    const name = String(data.get('name') ?? '').trim(); if (!name) return;
    try {
      const rows = await dbFetch<Reference[]>('ip_audit_references', { method: 'POST', body: JSON.stringify({ company_id: this.companyId, name,
        rights_holder: String(data.get('rights_holder') ?? ''), object_type: String(data.get('object_type') ?? ''),
        source_url: String(data.get('source_url') ?? ''), image_url: String(data.get('image_url') ?? ''), notes: String(data.get('notes') ?? '') }) });
      this.references.unshift(rows[0]); this.message = 'Эталон добавлен как пользовательский источник.'; this.paint();
    } catch (e) { this.message = e instanceof Error ? e.message : String(e); this.paint(); }
  }
  async export(onlyRisk: boolean): Promise<void> {
    const list = this.findings.filter(f => (!this.selectedRun || f.run_id === this.selectedRun) && (!onlyRisk || ['high','medium','low','insufficient'].includes(f.risk)));
    await exportXlsx(exportFileName('ip-audit', 'xlsx'), [{ name: 'Аудит прав', rows: [
      ['МП','Артикул','Название','Все фото карточки','Объект','Тип','Правообладатель','Приоритет проверки','Основание','Источник','Ручная проверка','Комментарий','Дата','Юрисдикция','Фото передано','Контрольные суммы фото','Публичные упоминания агентств','Источники агентств','Правовой статус'],
      ...list.map(f => [f.marketplace, f.vendor_code, f.product_name,
        (Array.isArray(f.details?.photo_results) ? (f.details.photo_results as { url?: string }[]).map(p => p.url).filter(Boolean).join('; ') : f.photo_url), f.object_name, f.object_type,
        f.rights_holder, RISK_LABEL[f.risk], f.reason, f.evidence_url, REVIEW_LABEL[f.review_status], f.review_comment, f.created_at,
        String(f.details?.jurisdiction || ''), (f.details?.image as { status?: string })?.status || '',
        (Array.isArray(f.details?.photo_results) ? (f.details.photo_results as { sha256?: string }[]).map(p => p.sha256).filter(Boolean).join('; ') : (f.details?.image as { sha256?: string })?.sha256) || '',
        ((f.details?.agencies as { matches?: { agency: string; name: string }[] })?.matches || []).map(m => `${m.agency}: ${m.name}`).join('; '),
        ((f.details?.agencies as { matches?: { url: string }[] })?.matches || []).map(m => m.url).join('; '), 'Права, лицензия и полномочия представителя не проверены']),
    ] }]);
  }
  filteredFindings(): Finding[] {
    const run = this.runs.find(r => r.id === this.selectedRun) ?? this.runs[0];
    const q = this.search.toLowerCase();
    return this.findings.filter(f => f.run_id === run?.id && (this.filter === 'all' || f.risk === this.filter) &&
      (!q || [f.vendor_code, f.product_name, f.object_name].some(v => v.toLowerCase().includes(q))));
  }
  selectFiltered(): void { this.selectAll(this.filteredFindings()); }
  more(): void { this.shown += 100; this.paint(); }
  chooseAll(all: boolean): void { this.selectedStores = all ? null : new Set(); this.saveStores(); }
  private renderStores(): string {
    const chosen = this.chosenStores();
    return `<div class="ca-scope-head"><div><b>Магазины для проверки</b><p>Фото, названия и описания только из отмеченных магазинов.</p></div><div><button class="ca-text-btn" onclick="window.myAnalysisModule?.ipChooseAll(true)">Все</button><button class="ca-text-btn" onclick="window.myAnalysisModule?.ipChooseAll(false)">Снять выбор</button></div></div><div class="ca-scope-grid">${(['wb','ozon','yandex'] as const).map(mp => {
      const stores = [...new Map(this.cards().filter(c => c.mp === mp).map(c => [c.storeId, { id: c.storeId, name: c.storeName }])).values()];
      if (!stores.length) return '';
      return `<div class="ca-scope-group"><label class="ca-scope-mp"><input type="checkbox" ${stores.every(st => chosen.has(st.id)) ? 'checked' : ''} onchange="window.myAnalysisModule?.ipToggleMarketplace('${mp}')">${mp === 'wb' ? 'Wildberries' : mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет'}</label>${stores.map(st => `<label><input type="checkbox" ${chosen.has(st.id) ? 'checked' : ''} onchange="window.myAnalysisModule?.ipToggleStore('${st.id}')"><span>${clean(st.name)}</span><small>${this.cards().filter(c => c.storeId === st.id).length}</small></label>`).join('')}</div>`;
    }).join('') || '<p class="ca-muted">Нет синхронизированных товаров. Подключите магазины и обновите каталог.</p>'}</div>`;
  }
  render(): string {
    const run = this.runs.find(r => r.id === this.selectedRun) ?? this.runs[0];
    const latest = run ? this.findings.filter(f => f.run_id === run.id) : [];
    const count = this.cards().filter(c => this.chosenStores().has(c.storeId)).length;
    const risks = latest.filter(f => f.risk === 'high' || f.risk === 'medium').length;
    const status: Record<string, string> = { running: 'Выполняется', paused: 'Приостановлено', completed: 'Завершено', failed: 'Ошибка' };
    const scopes: Record<string, string> = { sample: 'Пробная проверка', all: 'Весь каталог', new: 'Новые карточки', selected: 'По артикулу' };
    const date = (v: string) => new Date(v).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    let out = `<div class="ca-body ip-audit">${this.message ? `<div class="ip-notice" role="status">${clean(this.message)}</div>` : ''}`;
    if (this.section === 'overview') {
      out += `<div class="ca-intro"><div><span class="ca-eyebrow">РОССИЯ · ФОТО · НАЗВАНИЕ · ОПИСАНИЕ</span><h1>Проверьте, что требует внимания</h1><p>Распознавание каждого фото, проверка текста и сопоставление с открытыми источниками MegaLicense и BrandMonitor. Сохраняйте документы и результат проверки.</p></div><div class="ip-shield">◇</div></div>
        <div class="ca-metrics"><div><span>Карточек в выборе</span><b>${count}</b></div><div><span>Проверено карточек</span><b>${latest.length}</b></div><div><span>Требуют внимания</span><b class="ca-warning">${risks}</b></div><div><span>Сохранённых проверок</span><b>${this.runs.length}</b></div></div>
        <section class="ca-surface">${this.renderStores()}<div class="ca-launch"><select id="ip-scope" class="ca-search" aria-label="Объём проверки"><option value="sample">Пробная · до 50 карточек</option><option value="new">Только новые карточки</option><option value="all" ${!this.runs.some(r => r.scope === 'sample' && r.status === 'completed') ? 'disabled' : ''}>Весь выбранный каталог</option></select><button class="ca-primary" onclick="window.myAnalysisModule?.ipStart(document.getElementById('ip-scope').value)" ${this.busy || !count ? 'disabled' : ''}>${this.busy ? 'Проверяем…' : 'Начать проверку'} <span>→</span></button></div></section>
        <section class="ca-surface ip-single"><div><b>Проверить конкретный товар</b><p>Артикул продавца в выбранных магазинах</p></div><input id="ip-article" class="ca-search" placeholder="Артикул"><button class="ca-btn" onclick="window.myAnalysisModule?.ipStart('selected',document.getElementById('ip-article').value)" ${this.busy ? 'disabled' : ''}>Проверить</button></section>
        ${run ? `<section class="ca-surface ip-last-run"><div><small>ПОСЛЕДНЯЯ ПРОВЕРКА</small><b>${date(run.created_at)} · ${status[run.status] || clean(run.status)}</b><span>${run.processed} из ${run.total} карточек · ошибок ${run.errors}</span></div><button class="ca-btn" onclick="window.myAnalysisModule?.ipChooseRun('${run.id}')">Открыть результаты →</button></section>` : ''}
        <p class="ca-footnote">Проверка для рынка РФ. Иностранные персонажи и группы тоже могут охраняться. Высокий приоритет означает необходимость проверить документы, а отсутствие в открытом портфеле агентства не означает разрешение. Для полного каталога сначала завершите пробную проверку.</p>`;
    } else if (this.section === 'settings') {
      out += `<section class="ca-surface"><div class="ca-setting-line"><div><h2>Модель для анализа прав</h2><p>Авто выбирает бесплатную модель с поддержкой фото. В отчёте видны фактические модели обоих этапов.</p></div>${aiModelButton('rights', { vision: true })}</div></section><section class="ca-surface">${this.renderStores()}</section><section class="ca-surface"><h2>Как проходит проверка для РФ</h2><p>Проверяются все фотографии карточки. Сервер загружает JPEG, PNG или WebP с CDN Wildberries, Ozon и Яндекс Маркета и передаёт сам файл модели. Распознавание фото выполняется без названия и описания; текст анализируется отдельно. Недоступное фото не получает положительную оценку.</p><p>Открытый каталог MegaLicense и поимённые отзывы BrandMonitor обновляются при проверках с кэшем до 6 часов. Это неполные публичные сведения. Договоры, доверенности, территория, категории и сроки автоматически не подтверждаются; реестры ФИПС/ВОИС автоматически не опрашиваются.</p><p>Авторское право на персонаж, рисунок, обложку или фотографию проверяется отдельно от товарного знака и МКТУ. Перепродажа оригинального товара отличается от изготовления вещи с чужим принтом. Иностранное происхождение и параллельный импорт не дают общего разрешения использовать чужую графику.</p><p>Эталоны — ваши материалы, а не доказательство прав. Для визуального сравнения передаются до 3 эталонных фото с поддерживаемых источников; доступность каждого указана в результате. Ссылки на другие хосты не загружаются. Решение по жалобе принимает маркетплейс. Сведения о лицензии и полномочиях нужно подтвердить документами.</p></section>`;
    } else if (this.section === 'history') {
      out += `<div class="ca-page-heading"><h2>История проверок</h2><span>${this.runs.length} заданий</span></div><div class="ip-history">${this.runs.map(r => `<article class="ca-surface ip-history-row"><div><b>${date(r.created_at)}</b><small>${scopes[r.scope] || clean(r.scope)} · ${clean(r.model_id === 'auto' ? 'Авто · бесплатная' : r.model_id)}</small></div><span class="ip-status">${status[r.status] || clean(r.status)}</span><span>${r.processed}/${r.total}</span><button class="ca-btn" onclick="window.myAnalysisModule?.ipChooseRun('${r.id}')">Открыть</button>${r.status !== 'completed' || r.errors > 0 ? `<button class="ca-btn" onclick="window.myAnalysisModule?.ipResume('${r.id}')" ${this.busy ? 'disabled' : ''}>Продолжить</button>` : ''}</article>`).join('') || '<div class="ca-empty"><b>Проверок пока нет</b><p>Начните с пробной проверки во вкладке «Проверка».</p></div>'}</div>`;
    } else if (this.section === 'references') {
      out += `<div class="ca-page-heading"><div><h2>Ваши эталоны</h2><p>Объекты и источники, с которыми нужно сопоставлять товары.</p></div><span>${this.references.length} объектов</span></div><details class="ca-surface" data-key="new-reference"><summary>+ Добавить объект</summary><form class="ip-ref-form" onsubmit="event.preventDefault();window.myAnalysisModule?.ipAddReference(this)"><label>Объект<input name="name" required placeholder="Название объекта"></label><label>Правообладатель<input name="rights_holder" placeholder="Если известен"></label><label>Тип<input name="object_type" placeholder="Бренд, персонаж, принт"></label><label>Источник<input name="source_url" type="url" placeholder="https://…"></label><label>Эталонное фото<input name="image_url" type="url" placeholder="https://…"></label><label>Заметки<input name="notes" placeholder="На что обратить внимание"></label><button class="ca-primary">Добавить эталон</button></form></details><div class="ip-reference-list">${this.references.map(r => `<article class="ca-surface ip-reference">${safeUrl(r.image_url) ? `<img src="${clean(r.image_url)}" loading="lazy" alt="">` : '<span class="ip-ref-symbol">◇</span>'}<div><b>${clean(r.name)}</b><small>${clean(r.object_type)} · ${clean(r.rights_holder || 'Правообладатель не указан')}</small>${r.notes ? `<p>${clean(r.notes)}</p>` : ''}</div>${safeUrl(r.source_url) ? `<a href="${clean(r.source_url)}" target="_blank" rel="noopener noreferrer">Источник ↗</a>` : ''}</article>`).join('')}</div><p class="ca-footnote">Эталоны — предоставленные вами материалы. Их сведения не считаются подтверждёнными автоматически.</p>`;
    } else {
      const filtered = this.filteredFindings();
      out += `<div class="ip-results-toolbar"><input id="ip-search" type="search" class="ca-search" placeholder="Артикул, товар или объект…" value="${clean(this.search)}" oninput="window.myAnalysisModule?.ipSearch(this.value)"><select class="ca-search" aria-label="Уровень риска" onchange="window.myAnalysisModule?.ipFilter(this.value)">${[['all','Все результаты'],...Object.entries(RISK_LABEL)].map(([v,l]) => `<option value="${v}" ${this.filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select><button class="ca-btn" onclick="window.myAnalysisModule?.ipExport(false)">Экспорт Excel</button>${this.busy ? '<button class="ca-btn" onclick="window.myAnalysisModule?.ipStop()">Остановить</button>' : run && (run.status !== 'completed' || run.errors > 0) ? `<button class="ca-btn" onclick="window.myAnalysisModule?.ipResume('${run.id}')">Продолжить</button>` : ''}</div>
        ${run ? `<div class="ip-progress"><div><b>${status[run.status] || clean(run.status)}</b><span>${run.processed} из ${run.total} карточек · ${latest.length} фото · ошибок ${run.errors}</span></div><progress max="${Math.max(1,run.total)}" value="${run.processed}"></progress></div>` : ''}
        ${filtered.length ? `<div class="ip-bulk-actions"><label><input type="checkbox" onchange="window.myAnalysisModule?.ipSelectAll()" ${filtered.every(f => this.selectedFindings.has(f.id)) ? 'checked' : ''}> Выбрать все</label><span>${this.selectedFindings.size} выбрано · ${filtered.length} результатов</span>${this.selectedFindings.size ? `<select id="ip-bulk-status">${Object.entries(REVIEW_LABEL).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select><input id="ip-bulk-comment" placeholder="Общий комментарий"><button class="ca-btn" onclick="window.myAnalysisModule?.ipBulkReview()">Применить</button>` : ''}</div>` : ''}
        <div class="ip-result-list">${filtered.slice(0,this.shown).map(f => this.renderFinding(f)).join('') || '<div class="ca-empty"><b>Результатов пока нет</b><p>Запустите проверку или измените фильтры.</p></div>'}</div>${filtered.length > this.shown ? '<button class="ca-btn ca-more" onclick="window.myAnalysisModule?.ipMore()">Показать ещё 100</button>' : ''}`;
    }
    return out + '</div>';
  }
  private renderFinding(f: Finding): string {
    const ref = this.references.find(r => r.id === f.details?.reference_id);
    const sources = Array.isArray(f.details?.search_sources) ? f.details.search_sources as string[] : [];
    const matchScore = f.details?.match_score;
    const cardPhotos = Array.isArray(f.details?.photo_results) ? f.details.photo_results as { photo_number: number; url: string; status: string; model_observed: boolean }[] : [];
    const photoLabel = f.photo_index === -1 && f.details?.audit_version === 'ru-photo-v4' ? `вся карточка · ${cardPhotos.length ? `${cardPhotos.length} фото` : 'без фото'}` : f.photo_index >= 0 ? `фото ${f.photo_index + 1}` : 'без фото';
    return `<article class="ip-finding"><div class="ip-finding-select"><input type="checkbox" aria-label="Выбрать результат" ${this.selectedFindings.has(f.id) ? 'checked' : ''} onchange="window.myAnalysisModule?.ipToggleSelect('${f.id}')"></div><details data-key="finding-${f.id}"><summary>${safeUrl(f.photo_url) ? `<img src="${clean(f.photo_url)}" loading="lazy" alt="">` : '<span class="ip-no-photo">◇</span>'}<span class="ip-finding-title"><b>${clean(f.product_name)}</b><small>${clean(f.marketplace.toUpperCase())} · ${clean(f.vendor_code)} · ${photoLabel}</small><span>${clean(f.object_name || f.reason || 'Объект не определён')}</span></span><span class="ip-risk ip-risk-${f.risk}">${RISK_LABEL[f.risk]}</span><span class="ip-expand">⌄</span></summary>
      <div class="ip-finding-body"><div class="ip-evidence"><div>${safeUrl(f.photo_url) ? `<a href="${clean(f.photo_url)}" target="_blank" rel="noopener noreferrer"><img src="${clean(f.photo_url)}" loading="lazy" alt="Фото товара"></a><small>Фото товара</small>` : ''}</div>${ref && safeUrl(ref.image_url) ? `<div><img src="${clean(ref.image_url)}" loading="lazy" alt="Эталон"><small>${clean(ref.name)}</small></div>` : ''}<div class="ip-reason"><b>${clean(f.object_name || 'Объект не назван')}</b><p>${clean(f.reason)}</p>${f.error ? `<p class="ca-error">${clean(f.error)}</p>` : ''}<small>${clean(f.object_type)} · ${clean(f.rights_holder || 'Правообладатель не установлен')}</small>${matchScore != null ? `<small>Оценка сходства ИИ: ${Math.round(Number(matchScore)*100)}%</small>` : ''}<small>${clean(f.detected_text)}</small></div></div>
      ${this.renderAuditEvidence(f)}
      ${f.details?.visual_description ? `<p><b>Что увидела модель:</b> ${clean(f.details.visual_description)}</p>` : ''}${f.details?.additional_checks ? `<details class="ip-legal-checks"><summary>Что проверить по правам в РФ</summary><p>${clean(f.details.additional_checks)}</p></details>` : ''}
      <div class="ip-result-meta"><span>Статус: ${REVIEW_LABEL[f.review_status]}</span>${f.confidence != null ? `<span>Уверенность распознавания: ${Math.round(f.confidence*100)}% · не вероятность блокировки</span>` : ''}${f.details?.actual_model ? `<span>Модель: ${clean(f.details.actual_model)}</span>` : ''}${safeUrl(f.product_url) ? `<a href="${clean(f.product_url)}" target="_blank" rel="noopener noreferrer">Открыть товар ↗</a>` : ''}</div>
      ${sources.length ? `<div class="ip-sources"><b>Ссылки для самостоятельного поиска</b>${sources.filter(s => safeUrl(s)).map((url,i) => `<a href="${clean(url)}" target="_blank" rel="noopener noreferrer">Поиск ${i+1} ↗</a>`).join('')}</div>` : ''}
      <div class="ip-review"><label>Результат проверки<select id="ip-status-${f.id}">${Object.entries(REVIEW_LABEL).map(([v,l]) => `<option value="${v}" ${f.review_status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label>Комментарий<input id="ip-comment-${f.id}" value="${clean(f.review_comment)}" placeholder="Ваш вывод"></label><label>Документ или источник<input id="ip-evidence-${f.id}" value="${clean(f.evidence_url)}" placeholder="https://…"></label><button class="ca-btn" onclick="window.myAnalysisModule?.ipReview('${f.id}')">Сохранить</button><button class="ca-text-btn" onclick="window.myAnalysisModule?.ipSearchSource('${f.id}')">Подготовить поиск ↗</button></div></div></details></article>`;
  }
  private renderAuditEvidence(f: Finding): string {
    if (f.details?.audit_version !== 'ru-photo-v3' && f.details?.audit_version !== 'ru-photo-v4') return `<div class="ip-proof ip-proof-warning">${f.error ? 'Проверка не завершена: фото и источники по РФ не подтверждены. Повторите проверку.' : 'Предыдущая версия проверки: загрузка фото и источники по РФ не подтверждены. Запустите новую проверку этого товара.'}</div>`;
    const image = f.details.image as { status: string; bytes?: number; sha256?: string; model_observed?: boolean };
    const objects = f.details.objects as { name: string; type: string; source: string; evidence: string; location?: string; ru_checks?: string }[];
    const agencies = f.details.agencies as { matches: { agency: string; name: string; url: string; kind: string; note: string }[]; catalog_status: string; checked_at: string; coverage: string; sources: { url: string; status: string }[] };
    const refs = f.details.reference_images as { id: string; status: string; error?: string }[];
    const laws = f.details.legal_sources as { title: string; url: string }[];
    const models = f.details.actual_models as string[];
    const photos = Array.isArray(f.details.photo_results) ? f.details.photo_results as { photo_number: number; url: string; status: string; model_observed: boolean; visual_description?: string; detected_text?: string; error?: string }[] : [];
    const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString('ru-RU') : 'не установлена';
    return `<div class="ip-proof ${image?.status === 'sent' && image.model_observed ? '' : 'ip-proof-warning'}"><b>РФ · ${image?.status === 'sent' && image.model_observed ? 'Файл фото передан, модель описала изображение' : 'Визуальная проверка не завершена'}</b><span>${image?.bytes ? `${Math.round(image.bytes / 1024)} КБ · ` : ''}${date(f.details.checked_at)}</span>${image?.sha256 ? `<small title="Контрольная сумма переданного файла">SHA-256: ${clean(image.sha256)}</small>` : ''}${models?.length ? `<small>Фото / текст: ${models.map(m => clean(m)).join(' / ')}</small>` : ''}</div>
      ${photos.length ? `<div class="ip-object-grid ip-photo-results">${photos.map(p => `<div>${safeUrl(p.url) ? `<a href="${clean(p.url)}" target="_blank" rel="noopener noreferrer"><img src="${clean(p.url)}" loading="lazy" alt="Фото ${p.photo_number}"></a>` : ''}<small>ФОТО ${p.photo_number} · ${p.status === 'sent' && p.model_observed ? 'просмотрено моделью' : 'не проверено'}</small>${p.visual_description ? `<p>${clean(p.visual_description)}</p>` : ''}${p.detected_text ? `<small>Текст на фото: ${clean(p.detected_text)}</small>` : ''}${p.error ? `<p class="ca-error">${clean(p.error)}</p>` : ''}</div>`).join('')}</div>` : ''}
      ${objects?.length ? `<div class="ip-object-grid">${objects.map(o => `<div><small>${o.source === 'photo' ? `ФОТО ${Number((o as { photo_number?: number }).photo_number || 0) || '—'}` : o.source === 'title' ? 'В НАЗВАНИИ' : 'В ОПИСАНИИ'} · ${clean(o.type)}</small><b>${clean(o.name)}</b><p>${clean(o.evidence)}</p>${o.location ? `<small>${clean(o.location)}</small>` : ''}${o.ru_checks ? `<p><b>Проверка для РФ</b>${clean(o.ru_checks)}</p>` : ''}</div>`).join('')}</div>` : ''}
      <div class="ip-agencies"><b>Представители и публичные источники</b>${agencies?.matches?.length ? agencies.matches.map(m => `<div><a href="${clean(safeUrl(m.url))}" target="_blank" rel="noopener noreferrer">${clean(m.agency)} · ${clean(m.name)} ↗</a><span>${m.kind === 'portfolio' ? 'Есть в открытом каталоге' : 'Есть поимённый отзыв на сайте'}</span><p>${clean(m.note)}</p></div>`).join('') : '<p>Связь найденных объектов с MegaLicense или BrandMonitor по доступным публичным сведениям не установлена. Это не означает отсутствия прав или разрешение на продажу.</p>'}<small>Данные каталога: ${date(agencies?.checked_at)}${agencies?.catalog_status !== 'live' ? ' · часть источников недоступна или сведения устарели' : ''}. ${clean(agencies?.coverage)}</small><p class="ip-source-links">${(agencies?.sources || []).map(s => `<a href="${clean(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${s.url.includes('megalicense') ? 'MegaLicense' : 'BrandMonitor'} · ${s.status === 'live' ? 'источник загружен' : 'недоступен'} ↗</a>`).join('')}</p><small>Охрана объекта, действующий правообладатель, лицензия и полномочия на претензии не установлены автоматически.</small></div>
      ${refs?.length ? `<details class="ip-legal-checks"><summary>Эталонные изображения</summary>${refs.map(r => `<p>${clean(this.references.find(x => x.id === r.id)?.name || r.id)}: ${r.status === 'sent' ? 'файл передан для сравнения' : clean(r.error || 'не загружен')}</p>`).join('')}</details>` : ''}
      <p class="ip-source-links">${(laws || []).map(l => `<a href="${clean(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer">${clean(l.title)} ↗</a>`).join('')}</p>`;
  }
}
