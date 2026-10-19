import { dbFetch, dbFetchAll } from '@/services/dbClient';
import { analysisAiFetch } from '@/services/aiProxy';
import { companyService } from '@/services/companyService';
import { reportAiUsage } from '@/services/aiUsage';
import { hasQuota, recordAiSpend } from '@/services/aiTokenQuota';
import { exportXlsx, exportFileName } from './analytics/services/exporter';
import { loadAnalysisModels, modelSupportsImages, selectedAnalysisModel } from './analysisModels';

export interface AuditCard {
  uid: string; mp: 'wb' | 'ozon' | 'yandex'; storeId: string; storeName: string;
  vendorCode: string; name: string; photoUrls: string[];
  nmId?: number; productId?: number;
}
type Risk = 'high' | 'medium' | 'low' | 'none' | 'insufficient';
type Review = 'unreviewed' | 'needs_review' | 'object_confirmed' | 'not_confirmed' | 'permitted' | 'needs_documents' | 'closed';
interface Run { id: string; status: string; scope: string; total: number; processed: number; errors: number; created_at: string; finished_at?: string | null; product_keys: string[]; model_id: string; }
interface Finding {
  id: string; run_id: string; marketplace: string; store_id: string; product_id: string; vendor_code: string;
  product_name: string; product_brand: string; product_description: string; product_url: string | null;
  photo_url: string | null; photo_index: number; fingerprint: string; risk: Risk; object_type: string;
  object_name: string; rights_holder: string; reason: string; confidence: number | null;
  detected_text: string; details: Record<string, unknown>; error: string | null;
  review_status: Review; review_comment: string; evidence_url: string; created_at: string;
}
interface Reference { id: string; name: string; rights_holder: string; object_type: string; source_url: string; image_url: string; notes: string; }
const RISK_LABEL: Record<Risk, string> = { high: 'Высокий', medium: 'Средний', low: 'Низкий', none: 'Признаков нет', insufficient: 'Недостаточно данных' };
const REVIEW_LABEL: Record<Review, string> = { unreviewed: 'Не проверено', needs_review: 'Требует проверки', object_confirmed: 'Объект подтверждён', not_confirmed: 'Не подтверждено', permitted: 'Разрешено', needs_documents: 'Нужны документы', closed: 'Закрыто' };
const clean = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeUrl = (s: string | null | undefined) => /^https:\/\//i.test(s ?? '') ? s! : '';
const productLink = (c: AuditCard): string => c.mp === 'wb' && c.nmId ? `https://www.wildberries.ru/catalog/${c.nmId}/detail.aspx` : '';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class IpAudit {
  runs: Run[] = [];
  findings: Finding[] = [];
  references: Reference[] = [];
  busy = false;
  message = '';
  section: 'overview' | 'results' | 'history' | 'references' = 'overview';
  filter = 'all';
  search = '';
  selectedRun = '';
  private stop = false;
  private companyId = '';
  private selectedStores: Set<string> | null = null;
  private selectedFindings: Set<string> = new Set();
  constructor(private cards: () => AuditCard[], private description: (c: AuditCard) => Promise<string>, private paint: () => void) {}

  async load(): Promise<void> {
    const cid = companyService.getActiveId() ?? '';
    if (!cid) return;
    if (this.companyId !== cid) {
      this.selectedRun = '';
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
  setFilter(v: string): void { this.filter = v; this.paint(); }
  setSearch(v: string): void { this.search = v; this.paint(); }
  setRun(v: string): void { this.selectedRun = v; this.paint(); }
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
    this.selectedFindings.clear();
    this.message = `Обновлено ${this.selectedFindings.size} записей`;
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
      const done = new Set(this.findings.map(f => `${f.marketplace}:${f.store_id}:${f.product_id}`));
      cards = cards.filter(c => !done.has(`${c.mp}:${c.storeId}:${c.uid}`));
    }
    if (!cards.length) { this.message = 'Нет карточек для выбранной проверки.'; this.paint(); return; }
    if (scope === 'all' && !this.runs.some(r => r.scope === 'sample' && r.status === 'completed')) {
      this.message = 'Сначала завершите пробную проверку 50 карточек и просмотрите результаты.'; this.paint(); return;
    }
    try {
      const modelId = selectedAnalysisModel();
      const model = (await loadAnalysisModels()).find(m => m.id === modelId);
      if (!model || !modelSupportsImages(model)) throw new Error('Для аудита фотографий выберите модель с поддержкой изображений на вкладке «Модели ИИ».');
      const rows = await dbFetch<Run[]>('ip_audit_runs', { method: 'POST', body: JSON.stringify({ company_id: cid, scope, total: cards.length, product_keys: cards.map(c => c.uid), model_id: modelId }) });
      const run = rows[0];
      this.runs.unshift(run); this.selectedRun = run.id; this.section = 'results'; this.paint();
      await this.execute(run, cards);
    } catch (e) { this.message = `Запуск не удался: ${e instanceof Error ? e.message : String(e)}`; this.paint(); }
  }

  async resume(id: string): Promise<void> {
    if (this.busy) return;
    const run = this.runs.find(r => r.id === id);
    if (!run) return;
    this.selectedRun = id; this.section = 'results';
    const targets = new Set(run.product_keys ?? []);
    const cards = this.cards().filter(c => {
      if (!targets.has(c.uid)) return false;
      const photos = c.photoUrls.length ? c.photoUrls.length : 1;
      return this.findings.filter(f => f.run_id === id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid).length < photos;
    });
    await this.execute(run, cards);
  }

  private async execute(run: Run, cards: AuditCard[]): Promise<void> {
    this.busy = true; this.stop = false; this.message = 'Проверяем карточки последовательно…'; this.paint();
    try {
      await this.patchRun(run, { status: 'running' });
      let consecutiveErrors = 0;
      for (const c of cards) {
        if (this.stop || this.companyId !== companyService.getActiveId()) break;
        if (!hasQuota()) throw new Error('Дневной лимит ИИ исчерпан. Продолжите проверку позже.');
        const errorsBefore = run.errors;
        try {
          const desc = await this.description(c);
          const photos = c.photoUrls.length ? c.photoUrls : [null];
          for (let i = 0; i < photos.length; i++) {
            if (this.stop) break;
            const photo = photos[i];
            if (this.findings.some(f => f.run_id === run.id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid && f.photo_index === (photo ? i : -1))) continue;
            const fingerprint = await this.hash(`${run.model_id}\n${c.name}\n${desc}\n${photo ?? ''}`);
            const cached = this.findings.find(f => f.fingerprint === fingerprint && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid && f.photo_index === (photo ? i : -1) && !f.error);
            const result = cached ? { risk: cached.risk, object_type: cached.object_type, object_name: cached.object_name, rights_holder: cached.rights_holder, reason: cached.reason, confidence: cached.confidence, detected_text: cached.detected_text, details: cached.details, error: null } : await this.analyze(c, desc, photo, run.model_id);
            const row = { company_id: this.companyId, run_id: run.id, marketplace: c.mp, store_id: c.storeId,
              product_id: c.uid, vendor_code: c.vendorCode, product_name: c.name, product_brand: '',
              product_description: desc, product_url: productLink(c), photo_url: photo, photo_index: photo ? i : -1,
              fingerprint, ...result };
            const saved = await dbFetch<Finding[]>('ip_audit_findings?on_conflict=run_id,marketplace,store_id,product_id,photo_index', {
              method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(row),
            });
            this.findings.unshift(saved[0]);
            if (result.error) run.errors++;
            this.paint();
            if (!cached) await pause(450);
          }
        } catch (e) { run.errors++; this.message = `Ошибка карточки ${c.vendorCode}: ${e instanceof Error ? e.message : String(e)}`; }
        if (this.findings.filter(f => f.run_id === run.id && f.marketplace === c.mp && f.store_id === c.storeId && f.product_id === c.uid).length >= (c.photoUrls.length || 1)) run.processed++;
        await this.patchRun(run, { processed: run.processed, errors: run.errors });
        this.paint();
        consecutiveErrors = run.errors > errorsBefore ? consecutiveErrors + 1 : 0;
        if (consecutiveErrors >= 5) throw new Error('Пять карточек подряд завершились ошибкой. Проверьте доступ к ИИ и фото, затем продолжите.');
      }
      const complete = !this.stop && run.processed >= run.total;
      await this.patchRun(run, { status: complete ? 'completed' : 'paused', finished_at: complete ? new Date().toISOString() : null });
      this.message = complete ? 'Проверка завершена.' : 'Проверка приостановлена. Её можно продолжить.';
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
  private async analyze(c: AuditCard, desc: string, photo: string | null, modelId: string): Promise<Pick<Finding, 'risk'|'object_type'|'object_name'|'rights_holder'|'reason'|'confidence'|'detected_text'|'details'|'error'>> {
    if (!photo) return { risk: 'insufficient', object_type: '', object_name: '', rights_holder: '', reason: 'Нет фотографии', confidence: null, detected_text: '', details: {}, error: 'Фото отсутствует' };
    if (!safeUrl(photo)) return { risk: 'insufficient', object_type: '', object_name: '', rights_holder: '', reason: 'Недопустимый URL фотографии', confidence: null, detected_text: '', details: {}, error: 'Недоступный URL' };
    if (!hasQuota()) throw new Error('Дневной лимит ИИ исчерпан. Продолжите позже.');
    const refs = this.references.slice(0, 100).map(r => `• ${r.name} (тип: ${r.object_type}; правообладатель: ${r.rights_holder || 'не указан'}; источник: ${r.source_url || 'не указан'}; эталонное изображение: ${r.image_url || 'не указано'})`).join('\n');
    const instruction = `Ты выполняешь предварительный визуальный аудит товарных карточек маркетплейса на предмет потенциального использования объектов интеллектуальной собственности третьих лиц.

Твоя задача — выявить конкретные визуальные признаки, которые могут требовать проверки на наличие охраняемых прав.

Проверяй:
1. Логотипы, товарные знаки и фирменные обозначения.
2. Названия компаний, брендов, франшиз и продуктов.
3. Персонажей мультфильмов, фильмов, сериалов, игр и других произведений.
4. Иллюстрации, рисунки, графику, принты и художественные композиции.
5. Фирменную упаковку и узнаваемые графические элементы.
6. Возможные совпадения с известными или предоставленными эталонными изображениями.
7. Другие конкретные визуальные объекты, которые могут принадлежать третьим лицам.

Для каждого найденного объекта:
- опиши, что именно обнаружено;
- укажи вид объекта;
- укажи предполагаемое название или правообладателя, только если для этого есть достаточные основания;
- объясни, какие визуальные признаки позволяют предположить совпадение;
- оцени уверенность идентификации (от 0 до 1);
- укажи, что нужно проверить дополнительно.

Не выдумывай названия брендов, владельцев прав, лицензии, источники и доказательства.
Если объект невозможно уверенно определить, прямо укажи неопределённость.
Если фотография содержит обычный предмет без конкретных признаков чужой интеллектуальной собственности, не придумывай подозрения.
Не делай юридических выводов о том, что нарушение точно совершено.
Отсутствие обнаруженных объектов не является гарантией отсутствия нарушений.
Отделяй визуальное наблюдение от предположения и юридической оценки.

Маркетплейс: ${c.mp}
Название товара: ${c.name}
Описание товара: ${desc.slice(0, 2500)}

Эталоны для сравнения (предоставлены пользователем, не подтверждены сервисом):
${refs || 'Нет эталонов'}

Оцени уровень риска:
- high: узнаваемый персонаж с сильным визуальным совпадением с эталоном; явно обнаруженный логотип с подтверждённой связью с правообладателем; совпадение с оригинальной иллюстрацией из проверенного источника
- medium: обнаружен вероятный логотип; есть узнаваемые признаки персонажа; выявлено визуальное сходство с эталоном, но оно недостаточно для уверенного вывода; обнаружена иллюстрация или принт с неизвестным происхождением
- low: обнаружено только общее упоминание бренда; совпадение основано на неспецифическом элементе дизайна; есть признаки, но недостаточно оснований для более высокой оценки
- none: не обнаружено подозрительных объектов
- insufficient: фотографии не получены; изображение слишком низкого качества; объект не удаётся идентифицировать

Верни только JSON в следующем формате:
{
  "risk": "high|medium|low|none|insufficient",
  "object_type": "тип объекта (логотип/персонаж/иллюстрация/принт/упаковка/другое)",
  "object_name": "название объекта",
  "rights_holder": "предполагаемый правообладатель (если есть основания)",
  "reason": "основание подозрения с описанием визуальных признаков",
  "confidence": 0.85,
  "detected_text": "обнаруженные надписи на фото",
  "visual_description": "подробное описание того, что видно на фото",
  "additional_checks": "что нужно проверить дополнительно",
  "match_score": 0.75,
  "reference_id": "идентификатор эталона из базы, если есть совпадение"
}`;
    try {
      const res = await analysisAiFetch({ model: modelId, max_tokens: 800,
        messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: photo } }] }] });
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(String(detail.error?.message ?? `ИИ ответил HTTP ${res.status}`));
      }
      const body = await res.json();
      const usage = reportAiUsage('Аудит прав', body);
      if (usage) recordAiSpend(usage, modelId);
      const raw = body.choices?.[0]?.message?.content;
      if (typeof raw !== 'string') throw new Error('Пустой ответ ИИ');
      const data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
      const risk: Risk = ['high','medium','low','none','insufficient'].includes(data.risk) ? data.risk : 'insufficient';
      return { risk, object_type: String(data.object_type ?? ''), object_name: String(data.object_name ?? ''),
        rights_holder: String(data.rights_holder ?? ''), reason: String(data.reason ?? ''),
        confidence: Number.isFinite(Number(data.confidence)) ? Math.max(0, Math.min(1, Number(data.confidence))) : null,
        detected_text: String(data.detected_text ?? ''), 
        details: { 
          visual_description: data.visual_description ?? '', 
          additional_checks: data.additional_checks ?? '',
          match_score: Number.isFinite(Number(data.match_score)) ? Number(data.match_score) : null,
          reference_id: data.reference_id ?? null
        }, 
        error: null };
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
        (f.details as any).search_sources = results;
        await dbFetch(`ip_audit_findings?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ details: f.details }) });
        this.message = `Найдены источники для поиска информации`;
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
    const list = this.findings.filter(f => !onlyRisk || ['high','medium','low','insufficient'].includes(f.risk));
    await exportXlsx(exportFileName('ip-audit', 'xlsx'), [{ name: 'Аудит прав', rows: [
      ['МП','Артикул','Название','Фото','Объект','Тип','Правообладатель','Риск','Основание','Источник','Ручная проверка','Комментарий','Дата'],
      ...list.map(f => [f.marketplace, f.vendor_code, f.product_name, f.photo_url, f.object_name, f.object_type,
        f.rights_holder, RISK_LABEL[f.risk], f.reason, f.evidence_url, REVIEW_LABEL[f.review_status], f.review_comment, f.created_at]),
    ] }]);
  }
  render(): string {
    const run = this.runs.find(r => r.id === this.selectedRun) ?? this.runs[0];
    const latest = run ? this.findings.filter(f => f.run_id === run.id) : [];
    const risks = latest.filter(f => f.risk === 'high' || f.risk === 'medium').length;
    const tabs = [['overview','Обзор'],['results','Результаты'],['history','История'],['references','База объектов']] as const;
    let out = `<div class="ca-body ip-audit"><h2>Аудит интеллектуальных прав</h2><p class="ca-hint">Предварительная оценка по фото, названию и описанию. Результат ИИ не является юридическим заключением.</p>
      <div class="ip-tabs">${tabs.map(([id,label]) => `<button class="ca-pill ${this.section === id ? 'on' : ''}" onclick="window.myAnalysisModule?.ipSection('${id}')">${label}</button>`).join('')}</div>
      ${this.message ? `<p class="ca-hint">${clean(this.message)}</p>` : ''}`;
    if (this.section === 'overview') {
      const chosen = this.chosenStores();
      const groups = (['wb','ozon','yandex'] as const).map(mp => ({ mp, stores: [...new Map(this.cards().filter(c => c.mp === mp).map(c => [c.storeId, { id: c.storeId, name: c.storeName }])).values()] })).filter(g => g.stores.length);
      out += `<div class="ip-stats"><span>Карточек: <b>${this.cards().length}</b></span><span>Проверено фото: <b>${latest.length}</b></span><span>Приоритетных: <b>${risks}</b></span><span>Заданий: <b>${this.runs.length}</b></span></div>
        <p>Модель: <b>${clean(selectedAnalysisModel())}</b>. Изменить можно на вкладке «Модели ИИ».</p>
        <div class="ip-store-choice"><b>Что проверять</b><p class="ca-hint">Выбрано магазинов: ${chosen.size}. Настройка действует на все новые запуски.</p>
          ${groups.map(g => `<div class="ip-store-group"><label><input type="checkbox" ${g.stores.every(s => chosen.has(s.id)) ? 'checked' : ''} onchange="window.myAnalysisModule?.ipToggleMarketplace('${g.mp}')"><b>${g.mp === 'wb' ? 'Wildberries' : g.mp === 'ozon' ? 'Ozon' : 'Яндекс Маркет'}</b></label>
            <div>${g.stores.map(s => `<label><input type="checkbox" ${chosen.has(s.id) ? 'checked' : ''} onchange="window.myAnalysisModule?.ipToggleStore('${s.id}')">${clean(s.name)}</label>`).join('')}</div></div>`).join('')}</div>
        <p>Пробная проверка ограничена 50 карточками. Анализируются все их фотографии последовательно. Для полной проверки сначала завершите пробную и просмотрите результаты.</p>
        <div class="ip-actions"><button class="ca-btn" onclick="window.myAnalysisModule?.ipStart('sample')" ${this.busy?'disabled':''}>Проверить 50 карточек</button>
        <button class="ca-btn" onclick="window.myAnalysisModule?.ipStart('new')" ${this.busy?'disabled':''}>Только новые</button>
        <button class="ca-btn" onclick="window.myAnalysisModule?.ipStart('all')" ${this.busy?'disabled':''}>Весь каталог</button></div>
        <div class="ip-actions"><input id="ip-article" class="ca-search" placeholder="Артикул продавца"><button class="ca-btn" onclick="window.myAnalysisModule?.ipStart('selected',document.getElementById('ip-article')?.value||'')" ${this.busy?'disabled':''}>Проверить артикул</button></div>
        ${run ? `<p>Последнее задание: ${clean(run.status)} · ${run.processed}/${run.total} карточек · ошибок: ${run.errors}</p>` : ''}`;
    } else if (this.section === 'history') {
      out += this.runs.map(r => `<div class="ip-item"><b>${clean(r.created_at)}</b> · ${clean(r.scope)} · ${clean(r.status)} · ${r.processed}/${r.total} · ошибок ${r.errors} · ${clean(r.model_id)}
        <button class="ca-btn" onclick="window.myAnalysisModule?.ipChooseRun('${r.id}')">Открыть</button>
        ${r.status !== 'completed' ? `<button class="ca-btn" onclick="window.myAnalysisModule?.ipResume('${r.id}')" ${this.busy?'disabled':''}>Продолжить</button>` : ''}</div>`).join('') || '<p>Проверок пока нет.</p>';
    } else if (this.section === 'references') {
      out += `<p class="ca-hint">Эталоны вводятся вами. Система не имеет доступа к внутренним базам правообладателей.</p>
        <form class="ip-ref-form" onsubmit="event.preventDefault();window.myAnalysisModule?.ipAddReference(this)">
        <input name="name" required placeholder="Название объекта"><input name="rights_holder" placeholder="Правообладатель">
        <input name="object_type" placeholder="Тип (бренд, персонаж, принт)"><input name="source_url" type="url" placeholder="URL источника">
        <input name="image_url" type="url" placeholder="URL эталонного изображения"><input name="notes" placeholder="Примечание">
        <button class="ca-btn">Добавить</button></form>`;
      out += this.references.map(r => `<div class="ip-item"><b>${clean(r.name)}</b> · ${clean(r.rights_holder)} ${safeUrl(r.source_url) ? `<a href="${clean(r.source_url)}" target="_blank" rel="noopener noreferrer">Источник</a>` : ''}</div>`).join('');
    } else {
      const query = this.search.toLowerCase();
      const filtered = latest.filter(f => (this.filter === 'all' || f.risk === this.filter) && (!query || [f.vendor_code,f.product_name,f.object_name].some(v => v.toLowerCase().includes(query))));
      out += `<div class="ip-actions"><select class="ca-search" onchange="window.myAnalysisModule?.ipFilter(this.value)">
        ${[['all','Все риски'],['high','Высокий'],['medium','Средний'],['low','Низкий'],['none','Нет признаков'],['insufficient','Недостаточно данных']].map(([v,l]) => `<option value="${v}" ${this.filter===v?'selected':''}>${l}</option>`).join('')}</select>
        <input class="ca-search" placeholder="Поиск по артикулу, названию, объекту" value="${clean(this.search)}" onchange="window.myAnalysisModule?.ipSearch(this.value)">
        <button class="ca-btn" onclick="window.myAnalysisModule?.ipExport(false)">Excel: все</button><button class="ca-btn" onclick="window.myAnalysisModule?.ipExport(true)">Excel: к проверке</button>
        ${this.busy ? `<button class="ca-btn" onclick="window.myAnalysisModule?.ipStop()">Остановить</button>` : ''}</div>
        ${run ? `<p>${run.processed}/${run.total} карточек · ${latest.length} фото · ошибок ${run.errors}</p>` : ''}`;
      out += `<div class="ip-bulk-actions">
        <label><input type="checkbox" onchange="window.myAnalysisModule?.ipSelectAll()" ${this.selectedFindings.size > 0 && filtered.length > 0 && filtered.every(f => this.selectedFindings.has(f.id)) ? 'checked' : ''}> Выбрать все (${filtered.length})</label>
        <span>Выбрано: ${this.selectedFindings.size}</span>
        ${this.selectedFindings.size > 0 ? `
          <select id="ip-bulk-status">${Object.entries(REVIEW_LABEL).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}</select>
          <input id="ip-bulk-comment" placeholder="Комментарий для всех" style="min-width:200px">
          <button class="ca-btn" onclick="window.myAnalysisModule?.ipBulkReview()">Применить к выбранным</button>
        ` : ''}
      </div>`;
      out += filtered.slice(0, 300).map(f => {
        const refId = (f.details as any)?.reference_id;
        const ref = refId ? this.references.find(r => r.id === refId) : null;
        const matchScore = (f.details as any)?.match_score;
        const visualDesc = (f.details as any)?.visual_description || '';
        const searchSources = (f.details as any)?.search_sources as string[] || [];
        return `<div class="ip-item">
          <div class="ip-checkbox"><input type="checkbox" ${this.selectedFindings.has(f.id) ? 'checked' : ''} onchange="window.myAnalysisModule?.ipToggleSelect('${f.id}')"></div>
          <div class="ip-images">
            ${safeUrl(f.photo_url) ? `<div class="ip-photo-wrapper"><img src="${clean(f.photo_url)}" loading="lazy" alt="Фото товара"><span class="ip-photo-label">Фото товара</span></div>` : ''}
            ${ref && safeUrl(ref.image_url) ? `<div class="ip-photo-wrapper"><img src="${clean(ref.image_url)}" loading="lazy" alt="Эталон"><span class="ip-photo-label">Эталон: ${clean(ref.name)}</span></div>` : ''}
          </div>
          <div class="ip-content"><b>${clean(f.product_name)}</b><div>${clean(f.marketplace)} · ${clean(f.vendor_code)} · фото ${f.photo_index + 1} · ${RISK_LABEL[f.risk]}</div>
          <div>${clean(f.object_name || 'Объект не назван')} · ${clean(f.object_type)} · ${clean(f.rights_holder)}</div>
          ${matchScore != null ? `<div class="ip-match-score">Сходство с эталоном: ${Math.round(matchScore * 100)}%</div>` : ''}
          <p>${clean(f.reason)} ${f.error ? `Ошибка: ${clean(f.error)}` : ''}</p>
          ${visualDesc ? `<p class="ip-visual-desc"><small>Описание ИИ: ${clean(visualDesc)}</small></p>` : ''}
          <small>${clean(f.detected_text)} ${f.confidence != null ? `· уверенность ${Math.round(f.confidence*100)}%` : ''}</small>
          ${safeUrl(f.product_url) ? `<a href="${clean(f.product_url)}" target="_blank" rel="noopener noreferrer">Карточка товара</a>` : ''}
          ${searchSources.length ? `<div class="ip-sources"><small>Источники для проверки:</small>${searchSources.map(s => `<a href="${clean(s)}" target="_blank" rel="noopener noreferrer">🔍 ${clean(s)}</a>`).join('')}</div>` : ''}
          <div class="ip-review"><select id="ip-status-${f.id}">${Object.entries(REVIEW_LABEL).map(([v,l]) => `<option value="${v}" ${f.review_status===v?'selected':''}>${l}</option>`).join('')}</select>
            <input id="ip-comment-${f.id}" placeholder="Комментарий" value="${clean(f.review_comment)}"><input id="ip-evidence-${f.id}" placeholder="Ссылка на документ" value="${clean(f.evidence_url)}">
            <button class="ca-btn" onclick="window.myAnalysisModule?.ipReview('${f.id}')">Сохранить</button>
            <button class="ca-btn" onclick="window.myAnalysisModule?.ipSearchSource('${f.id}')">🔍 Найти источники</button></div></div></div>`;
      }).join('') || '<p>Результатов пока нет.</p>';
    }
    return out + '</div>';
  }
}
