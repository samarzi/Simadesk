/**
 * DocsModule — редактор документов SimaDesk (Excel + Word).
 *
 * Здесь — оболочка: список открытых документов, хранение (кеш в браузере +
 * сервер), доступ (весь кабинет / только я), «Недавние» на аккаунте,
 * импорт/экспорт и связь с ассистентом. Сами редакторы — в modules/docs:
 *   sheetEditor.ts — таблица (модель книги → окно сетки, лента как в Excel);
 *   wordEditor.ts  — текст (страница A4, лента как в Word);
 *   xlsxIO.ts / docxIO.ts — чтение и запись файлов Office без потери вида.
 */

import * as XLSX from 'xlsx';
import { aiPage, type AiPageCapability, type AiActionResult } from '@/services/aiPageContext';
import { debug } from '@/utils/debug';
import { perfMark, perfTime } from '@/utils/perfLog';
import { compactValidations } from './docs/validation';
import { selectionCtx } from '@/services/selectionContext';
import { dbFetch } from '@/services/dbClient';
import { companyService } from '@/services/companyService';
import { authService } from '@/services/authService';
import { showToast } from '@/utils/toast';
import {
  formatCellValue, parseUserNumber, dateToSerial,
  type CellType,
} from '@/utils/numFormat';
import { createEvaluator, type Evaluator, type GridAccess } from '@/utils/formula';
import { prepareImage, isSafeImageSrc, fileToDataUrl } from '@/utils/docImage';
import { imageAttachments } from '@/services/imageAttachments';
import {
  type CellData, type MergeRange, type SheetData, type ExcelContent, type DocItem, type DocType, type WordMeta,
  type ChartKind, XL_ROWS, XL_COLS, colLetter as colLetterFn, letterToCol as letterToColFn, newWorkbook, ensureSize,
  parseRangeRef, rangeToRef,
} from './docs/model';
import { normalizeCss, editCss, type XStyle } from './docs/xlStyle';
import { readXlsx, writeXlsx, MAX_IMPORT_ROWS, MAX_IMPORT_COLS } from './docs/xlsxIO';
import { readDocx, writeDocx } from './docs/docxIO';
import { SheetEditor, interpretInput, buildChartFromRange, type SheetHost } from './docs/sheetEditor';
import { WordEditor, normalizeWhitespace, sanitizeHtml, type WordHost } from './docs/wordEditor';
import {
  shiftSheet, sortRows, renameSheet as renameSheetOp, cloneSheet, uniqueSheetName, nextSheetName, mergeRange,
} from './docs/sheetOps';
import { closeMenus } from './docs/ui';
import '@/styles/docs-editor.css';

export type { CellData, SheetData, ExcelContent, DocItem };

const STORAGE_KEY  = 'docs_v2';    // v2 = company-scoped
const RECENT_KEY   = 'docs_recent_v2';
const ACTIVE_KEY   = 'docs_active_v2';
const MAX_DOCS     = 20;
const MAX_RECENT   = 30;
/** Сколько символов снимков держит история отмен (≈ байт × 2). */
const UNDO_MAX_CHARS = 40_000_000;

interface RecentItem {
  id: string; title: string; type: DocType; updated_at: number;
  owner_id?: string | null; visibility?: 'company' | 'private';
}

/** Описание документа без содержимого — для «Недавних» и «Всех документов». */
interface DocMeta {
  id: string; type: DocType; title: string; updated_at: number;
  owner_id?: string | null; visibility?: 'company' | 'private'; meta?: WordMeta;
}

interface UndoSnap { docId: string; content: string; sheetIdx: number; meta?: string }

export class DocsModule {
  private root!: HTMLElement;
  private docs: DocItem[] = [];
  private activeId: string | null = null;
  private loadedCompanyId: string | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSheetIdx = 0;
  private isFullscreen = false;
  /** Недавние — только метаданные; с сервера, если он их знает. */
  private recent: RecentItem[] = [];
  /** Документы, чьё содержимое ещё не пришло из БД — их нельзя перезаписывать. */
  private pendingContent = new Set<string>();
  /** Документы, для которых последняя загрузка содержимого завершилась ошибкой. */
  private contentLoadError = new Set<string>();
  /** Документы, о непрохождении сохранения которых пользователь уже предупреждён. */
  private warnedNoPersist = new Set<string>();
  /** Изменены локально и ещё не подтверждены сервером. */
  private dirty = new Set<string>();
  private deletingDocs = new Set<string>();
  private deletedDocs = new Set<string>();
  /** Сохраняем версии одного документа строго по порядку вызовов. */
  private saveChains = new Map<string, Promise<void>>();
  /**
   * Что уже лежит в кеше браузера: id → записанная строка. save() пишет
   * только изменившиеся документы. Раньше каждое сохранение (раз в 0,8 с
   * при редактировании и ещё раз после ответа сервера) синхронно переписывало
   * содержимое ВСЕХ открытых документов — с несколькими большими таблицами
   * это десятки мегабайт записи в главном потоке и «лютые» подвисания.
   */
  private _cachedContent?: Map<string, string>;
  /** Документы, не поместившиеся в кеш, с длиной, на которой это случилось. */
  private _cacheTooBig?: Map<string, number>;
  private get cachedContent(): Map<string, string> { return this._cachedContent ??= new Map(); }
  private get cacheTooBig(): Map<string, number> { return this._cacheTooBig ??= new Map(); }
  /** Документы, которые сервер уже видел (значит, их исчезновение — удаление или закрытие доступа). */
  private serverKnown = new Set<string>();
  private xlLastSel: { r1: number; c1: number; r2: number; c2: number; docId: string; sheetIdx: number } | null = null;
  private xlUndoStack: UndoSnap[] = [];
  private xlRedoStack: UndoSnap[] = [];
  /** Где стояло выделение на каждом листе — чтобы после перерисовки вернуть его. */
  private xlSelMemo: Record<string, MergeRange> = {};
  xlSheetScroll: Record<string, Record<number, { top: number; left: number }>> = {};
  /** Вычислитель одного листа для ИИ-функций (без межлистовых ссылок). */
  private fxRows: CellData[][] | null = null;
  private fxEval: Evaluator | null = null;
  /** Разобранная книга активного документа — чтобы не разбирать JSON на каждое действие. */
  private bookCache: { docId: string; content: string; book: ExcelContent } | null = null;
  /** Вычислители листов книги (со ссылками между листами). */
  private wbEval: { book: ExcelContent; evs: Map<number, Evaluator> } | null = null;
  private sheetEditor: SheetEditor | null = null;
  private wordEditor: WordEditor | null = null;
  /** Есть ли на сервере колонки доступа (миграция 20261009_docs_access). */
  private srvV2: boolean | null = null;
  private srvV2CheckedAt = 0;
  private allDocs: DocMeta[] | null = null;
  private browseTab: 'all' | 'mine' | 'shared' | 'private' = 'all';
  private browseQuery = '';
  private memberNames = new Map<string, string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private recentSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private saveState: 'saved' | 'saving' | 'error' = 'saved';

  constructor(root: HTMLElement) {
    this.root = root;
    this.loadedCompanyId = companyService.getActiveId();
    this.load();
    window.addEventListener('beforeunload', () => this.flushSave());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this.root.style.display !== 'none') this.pollRemote(); });
    // С сервером синхронизируемся при первом открытии редактора, а не при
    // загрузке любой страницы приложения: раньше каждый F5 скачивал и
    // переписывал в браузер все открытые документы, даже если пользователь
    // был в другом разделе.
  }

  private syncedOnce = false;

  show(): void {
    this.root.style.display = '';
    const cid = companyService.getActiveId();
    if (cid !== this.loadedCompanyId) {
      this.flushSave();
      this.docs = [];
      this.recent = [];
      this.pendingContent.clear();
      this.contentLoadError.clear();
      this.cachedContent.clear();
      this.cacheTooBig.clear();
      this.serverKnown.clear();
      this.dirty.clear();
      this.srvV2 = null;
      this.srvV2CheckedAt = 0;
      this.allDocs = null;
      this.activeId = null;
      this.activeSheetIdx = 0;
      this.loadedCompanyId = cid;
      this.load();
      this.syncedOnce = false;
    }
    // Оболочка — сразу, тяжёлая таблица — следующим кадром: переход в
    // раздел не ждёт разбора многомегабайтного документа.
    this.deferMount = true;
    this.render();
    if (!this.syncedOnce) { this.syncedOnce = true; void this.syncFromDb(); }
    if (!this.pollTimer) this.pollTimer = setInterval(() => this.pollRemote(), 20_000);
  }

  hide(): void {
    this.flushSave();
    this.destroyEditors();
    this.root.style.display = 'none';
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    closeMenus();
  }

  /** Публичный геттер: id активного документа (для внешних вызовов после aiCreateDoc). */
  get activeDocId(): string | null { return this.activeId; }

  /** Создать новый документ из ассистента (кросс-страничное глобальное действие). */
  aiCreateDoc(type: DocType, title?: string): string {
    this.createDoc(type);
    if (title && this.activeId) {
      const doc = this.docs.find(d => d.id === this.activeId);
      if (doc) { doc.title = title.trim() || doc.title; this.save(); this.saveDocToDb(doc); this.render(); }
    }
    return `Создан новый ${type === 'excel' ? 'Excel' : 'Word'}-документ${title ? ` «${title}»` : ''}.`;
  }

  // ═══════════════════════════ Кеш в браузере ═══════════════════════════
  //
  // Содержимое каждого документа лежит в СВОЁМ ключе, а общий ключ хранит
  // только индекс. Переполнение квоты затрагивает лишь тот документ,
  // который не поместился.

  private sk(): string { const c = companyService.getActiveId(); return c ? `${STORAGE_KEY}_${c}` : STORAGE_KEY; }
  private rk(): string { const c = companyService.getActiveId(); return c ? `${RECENT_KEY}_${c}` : RECENT_KEY; }
  private ak(): string { const c = companyService.getActiveId(); return c ? `${ACTIVE_KEY}_${c}` : ACTIVE_KEY; }
  private ck(id: string): string { return `${this.sk()}__doc_${id}`; }

  private me(): string | null { return authService.getUser()?.id ?? null; }

  private load(): void {
    let index: any[] = [];
    try { const raw = localStorage.getItem(this.sk()); index = raw ? JSON.parse(raw) : []; }
    catch { index = []; }

    this.docs = [];
    for (const meta of index) {
      if (!meta || typeof meta.id !== 'string') continue;
      const doc: DocItem = {
        id: meta.id,
        type: meta.type === 'word' ? 'word' : 'excel',
        title: typeof meta.title === 'string' ? meta.title : 'Документ',
        content: '',
        updated_at: typeof meta.updated_at === 'number' ? meta.updated_at : 0,
        ...(meta.owner_id !== undefined ? { owner_id: meta.owner_id } : {}),
        ...(meta.visibility ? { visibility: meta.visibility === 'private' ? 'private' : 'company' } : {}),
        ...(meta.meta && typeof meta.meta === 'object' ? { meta: meta.meta } : {}),
      };
      if (meta.srv) this.serverKnown.add(doc.id);
      if (meta.dirty) this.dirty.add(doc.id);
      let content: string | null = null;
      try { content = localStorage.getItem(this.ck(meta.id)); } catch { /* ignore */ }
      // Уже лежит в своём ключе — переписывать при сохранении не нужно.
      if (content !== null) this.cachedContent.set(doc.id, content);
      if (content === null && typeof meta.content === 'string') content = meta.content;
      if (content === null) content = this.findOrphanContent(meta.id);
      if (content === null) { doc.content = ''; this.pendingContent.add(doc.id); }
      else doc.content = content;
      this.docs.push(doc);
    }

    try {
      const raw = localStorage.getItem(this.rk());
      const list = raw ? JSON.parse(raw) : [];
      this.recent = Array.isArray(list)
        ? list.filter(r => r && typeof r.id === 'string').map(r => ({
            id: r.id, title: String(r.title ?? 'Документ'), type: r.type === 'word' ? 'word' as const : 'excel' as const,
            updated_at: Number(r.updated_at) || 0,
            ...(r.owner_id !== undefined ? { owner_id: r.owner_id } : {}),
            ...(r.visibility ? { visibility: r.visibility } : {}),
          }))
        : [];
    } catch { this.recent = []; }

    const savedActive = localStorage.getItem(this.ak());
    if (savedActive && this.docs.some(d => d.id === savedActive)) this.activeId = savedActive;
    else if (!this.activeId && this.docs.length) this.activeId = this.docs[0].id;
  }

  private save(): void {
    perfTime('редактор: сохранение в браузер', () => this.saveNow(), 50);
  }

  private saveNow(): void {
    for (const doc of this.docs) {
      if (this.pendingContent.has(doc.id)) continue;
      if (this.cachedContent.get(doc.id) === doc.content) continue;   // не менялся — не пишем
      // Уже не влез в кеш и с тех пор не уменьшился — не пытаемся снова на каждом сохранении.
      const tooBig = this.cacheTooBig.get(doc.id);
      if (tooBig !== undefined && doc.content.length >= tooBig) continue;
      this.saveDocContent(doc);
    }
    try {
      const index = this.docs.map(d => ({
        id: d.id, type: d.type, title: d.title, updated_at: d.updated_at,
        ...(d.owner_id !== undefined ? { owner_id: d.owner_id } : {}),
        ...(d.visibility ? { visibility: d.visibility } : {}),
        ...(d.meta ? { meta: d.meta } : {}),
        ...(this.serverKnown.has(d.id) ? { srv: 1 } : {}),
        ...(this.dirty.has(d.id) ? { dirty: 1 } : {}),
      }));
      localStorage.setItem(this.sk(), JSON.stringify(index));
      if (this.activeId) localStorage.setItem(this.ak(), this.activeId);
    } catch (e) {
      debug.warn('[DocsModule] index save failed', e);
    }
  }

  private trySet(key: string, value: string): boolean {
    try { localStorage.setItem(key, value); return true; }
    catch { return false; }
  }

  private saveDocContent(doc: DocItem): void {
    const key = this.ck(doc.id);
    const stored = () => { this.cachedContent.set(doc.id, doc.content); this.cacheTooBig.delete(doc.id); };
    if (this.trySet(key, doc.content)) { stored(); return; }
    // Освобождаем место за счёт кеша других документов, которые уже есть на
    // сервере, от самых старых. Свой ключ НЕ трогаем: старая копия —
    // единственное, что переживёт перезагрузку. Раньше вытесненные копии
    // возвращались обратно даже после успешной записи — место не освобождалось,
    // и на каждом сохранении повторялся цикл из многомегабайтных записей.
    const victims = this.docs
      .filter(d => d.id !== doc.id && d.id !== this.activeId && this.serverKnown.has(d.id)
        && !this.pendingContent.has(d.id) && !this.dirty.has(d.id) && this.cachedContent.has(d.id))
      .sort((a, b) => a.updated_at - b.updated_at);
    const evicted: Array<{ id: string; key: string; value: string }> = [];
    for (const v of victims) {
      const vk = this.ck(v.id);
      const prev = this.cachedContent.get(v.id)!;
      try { localStorage.removeItem(vk); } catch { continue; }
      evicted.push({ id: v.id, key: vk, value: prev });
      if (this.trySet(key, doc.content)) {
        // Вытесненные документы есть на сервере — их кеш больше не держим.
        for (const e of evicted) this.cachedContent.delete(e.id);
        stored();
        return;
      }
    }
    // Не поместился даже так — возвращаем чужие копии как были.
    for (const e of evicted) this.trySet(e.key, e.value);
    this.cacheTooBig.set(doc.id, doc.content.length);
    debug.warn('[DocsModule] doc content does not fit localStorage', doc.id);
    this.saveDocToDb(doc, (ok) => {
      if (ok) { this.warnedNoPersist.delete(doc.id); return; }
      if (this.warnedNoPersist.has(doc.id)) return;
      this.warnedNoPersist.add(doc.id);
      showToast(`«${doc.title}»: не удалось сохранить ни в браузере, ни на сервере. Экспортируйте файл, чтобы не потерять правки.`, 'error');
    });
  }

  private dropDocContent(id: string): void {
    this.cachedContent.delete(id);
    this.cacheTooBig.delete(id);
    try { localStorage.removeItem(this.ck(id)); } catch { /* ignore */ }
  }

  /** Содержимое документа под чужим ключом (ключ без компании, если она не успела загрузиться). */
  private findOrphanContent(id: string): string | null {
    const suffix = `__doc_${id}`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.endsWith(suffix) || !key.startsWith(STORAGE_KEY)) continue;
        const value = localStorage.getItem(key);
        if (value) { debug.warn('[DocsModule] recovered doc content from stray key', key); return value; }
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveRecent(): void {
    try { localStorage.setItem(this.rk(), JSON.stringify(this.recent)); }
    catch { /* ignore */ }
  }

  private touchRecent(doc: DocItem, open = true): void {
    this.recent = this.recent.filter(r => r.id !== doc.id);
    this.recent.unshift({
      id: doc.id, title: doc.title, type: doc.type, updated_at: doc.updated_at,
      ...(doc.owner_id !== undefined ? { owner_id: doc.owner_id } : {}),
      ...(doc.visibility ? { visibility: doc.visibility } : {}),
    });
    if (this.recent.length > MAX_RECENT) this.recent = this.recent.slice(0, MAX_RECENT);
    this.saveRecent();
    this.syncRecentToServer(doc.id, open);
  }

  // ═══════════════════════════ Отмена (таблицы) ═══════════════════════════

  /** Глубина истории — по объёму снимков, а не по числу шагов. */
  private static readonly UNDO_MAX_STEPS = 100;

  private trimUndoStack(stack: UndoSnap[]): void {
    while (stack.length > DocsModule.UNDO_MAX_STEPS) stack.shift();
    let chars = stack.reduce((n, s) => n + s.content.length, 0);
    while (stack.length > 1 && chars > UNDO_MAX_CHARS) { chars -= stack[0].content.length; stack.shift(); }
  }

  /** Снимок документа перед изменением (для Ctrl+Z и для ИИ-действий). */
  private pushXlUndo(docId: string, sheetIdx: number, _r = 0, _c = 0): void {
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) return;
    const last = this.xlUndoStack[this.xlUndoStack.length - 1];
    if (last && last.docId === docId && last.content === doc.content) return;
    this.xlUndoStack.push({ docId, content: doc.content, sheetIdx });
    this.trimUndoStack(this.xlUndoStack);
    this.xlRedoStack = [];
  }

  private applySnap(snap: UndoSnap, pushTo: UndoSnap[]): void {
    const doc = this.docs.find(d => d.id === snap.docId);
    if (!doc) return;
    pushTo.push({ docId: doc.id, content: doc.content, sheetIdx: this.activeSheetIdx });
    this.trimUndoStack(pushTo);
    this.updateContent(doc.id, snap.content);
    if (this.activeId === doc.id) {
      this.activeSheetIdx = Math.min(snap.sheetIdx, this.getBook(doc).sheets.length - 1);
      if (this.sheetEditor) this.sheetEditor.refresh(); else this.render();
    }
  }

  private xlUndo(): void {
    const snap = this.popSnap(this.xlUndoStack);
    if (snap) this.applySnap(snap, this.xlRedoStack);
  }

  private xlRedo(): void {
    const snap = this.popSnap(this.xlRedoStack);
    if (snap) this.applySnap(snap, this.xlUndoStack);
  }

  /** Снять снимок активного документа (снимки других документов не трогаем). */
  private popSnap(stack: UndoSnap[]): UndoSnap | null {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].docId === this.activeId) return stack.splice(i, 1)[0];
    }
    return null;
  }

  // ═══════════════════════════ Сервер ═══════════════════════════

  /** Есть ли на сервере колонки доступа — проверяем один раз. */
  private async probeServer(companyId: string): Promise<boolean> {
    if (this.srvV2 === true) return true;
    if (this.srvV2 === false && Date.now() - this.srvV2CheckedAt < 30_000) return false;
    try {
      await dbFetch<unknown[]>(`docs_documents?company_id=eq.${companyId}&select=id,owner_id,visibility,meta&limit=1`);
      this.srvV2 = true;
    } catch { this.srvV2 = false; this.srvV2CheckedAt = Date.now(); }
    return this.srvV2;
  }

  private metaSelect(): string {
    return this.srvV2 ? 'id,type,title,updated_at,owner_id,visibility,meta' : 'id,type,title,updated_at';
  }

  /**
   * Синхронизация с сервером: «Недавние» и открытые вкладки — с аккаунта
   * (так их видно с любого компьютера), содержимое открытых документов —
   * свежее серверное, если на этом ПК оно старее.
   */
  private async syncFromDb(): Promise<void> {
    perfMark('редактор: синхронизация с сервером');
    const companyId = companyService.getActiveId();
    if (!companyId) { this.markContentLoadError(); return; }
    try {
      const v2 = await this.probeServer(companyId);

      // 1. Недавние с аккаунта
      let serverRecent: Array<{ doc_id: string; opened_at: number; is_open: boolean }> | null = null;
      if (v2) {
        try {
          serverRecent = await dbFetch(`docs_recent?company_id=eq.${companyId}&select=doc_id,opened_at,is_open&order=opened_at.desc&limit=${MAX_RECENT}`);
        } catch { serverRecent = null; }
      }

      // 2. Метаданные всего, что нас интересует
      const ids = new Set<string>([...this.docs.map(d => d.id), ...this.recent.map(r => r.id), ...(serverRecent ?? []).map(r => r.doc_id)]);
      const metas = ids.size
        ? await dbFetch<DocMeta[]>(`docs_documents?company_id=eq.${companyId}&id=in.(${[...ids].map(i => `"${i}"`).join(',')})&select=${this.metaSelect()}`)
        : [];
      const byId = new Map(metas.map(m => [m.id, m]));
      let changed = false;

      // 3. Вкладки, открытые на другом компьютере
      for (const r of serverRecent ?? []) {
        if (!r.is_open || this.docs.some(d => d.id === r.doc_id)) continue;
        const m = byId.get(r.doc_id);
        if (!m || this.docs.length >= MAX_DOCS) continue;
        let cached: string | null = null;
        try { cached = localStorage.getItem(this.ck(m.id)); } catch { /* ignore */ }
        this.docs.push({ id: m.id, type: m.type === 'word' ? 'word' : 'excel', title: m.title, content: cached ?? '', updated_at: cached ? 0 : m.updated_at, owner_id: m.owner_id, visibility: m.visibility, meta: m.meta && Object.keys(m.meta).length ? m.meta : undefined });
        this.pendingContent.add(m.id);
        changed = true;
      }

      // 4. Документы, исчезнувшие с сервера: удалены или владелец закрыл доступ
      for (const doc of [...this.docs]) {
        if (byId.has(doc.id)) { this.serverKnown.add(doc.id); continue; }
        if (!this.serverKnown.has(doc.id)) continue;      // ещё не выгружался — это новый документ этого ПК
        this.docs = this.docs.filter(d => d.id !== doc.id);
        this.dropDocContent(doc.id);
        this.pendingContent.delete(doc.id);
        this.serverKnown.delete(doc.id);
        if (this.activeId === doc.id) { this.activeId = this.docs[0]?.id ?? null; this.activeSheetIdx = 0; }
        showToast(`«${doc.title}» больше недоступен: его удалили или владелец сделал его личным.`, 'info');
        changed = true;
      }

      // 5. Недавние: сервер + этот ПК, только существующие документы
      const merged = new Map<string, RecentItem & { opened: number }>();
      for (const r of serverRecent ?? []) {
        const m = byId.get(r.doc_id);
        if (m) merged.set(m.id, { id: m.id, title: m.title, type: m.type, updated_at: m.updated_at, owner_id: m.owner_id, visibility: m.visibility, opened: r.opened_at });
      }
      this.recent.forEach((r, i) => {
        const m = byId.get(r.id);
        const localOnly = !m && this.docs.some(d => d.id === r.id) && !this.serverKnown.has(r.id);
        if (!m && !localOnly) return;
        if (!merged.has(r.id)) {
          merged.set(r.id, { ...r, ...(m ? { title: m.title, updated_at: m.updated_at, owner_id: m.owner_id, visibility: m.visibility } : {}), opened: Date.now() - 1000 * (i + 1) - 1e10 });
          if (m && v2) this.syncRecentToServer(r.id, this.docs.some(d => d.id === r.id));   // перенести старые локальные «Недавние» на аккаунт
        }
      });
      const nextRecent = [...merged.values()].sort((a, b) => b.opened - a.opened).slice(0, MAX_RECENT).map(({ opened: _o, ...r }) => r);
      if (JSON.stringify(nextRecent) !== JSON.stringify(this.recent)) { this.recent = nextRecent; this.saveRecent(); changed = true; }

      // 6. Содержимое: ждущие + те, что на сервере новее
      const needContent: string[] = [];
      for (const doc of this.docs) {
        const m = byId.get(doc.id);
        if (!m) continue;
        Object.assign(doc, { owner_id: m.owner_id, visibility: m.visibility, ...(m.meta && Object.keys(m.meta).length ? { meta: m.meta } : {}) });
        if (m.title && m.title !== doc.title && m.updated_at >= doc.updated_at) { doc.title = m.title; changed = true; }
        if (this.pendingContent.has(doc.id) || (m.updated_at > doc.updated_at && !this.dirty.has(doc.id))) {
          // Скачиваем только активный документ. Остальные вкладки помечаются
          // «загружается» и догружаются при переключении (openDoc). Раньше при
          // каждом открытии редактора скачивались и записывались в браузер
          // все вкладки сразу — по несколько мегабайт каждая.
          if (doc.id === this.activeId) needContent.push(doc.id);
          else { this.pendingContent.add(doc.id); changed = true; }
        }
        else if (this.dirty.has(doc.id) || doc.updated_at > m.updated_at) this.saveDocToDb(doc);   // правки этого ПК не дошли — дошлём
      }
      for (const doc of this.docs) if (!byId.has(doc.id) && !this.serverKnown.has(doc.id) && !this.pendingContent.has(doc.id) && doc.content) this.saveDocToDb(doc);
      const returned = new Set<string>();
      if (needContent.length) {
        const rows = await dbFetch<Array<{ id: string; content: string; updated_at: number; title: string }>>(
          `docs_documents?company_id=eq.${companyId}&id=in.(${needContent.map(i => `"${i}"`).join(',')})&select=id,content,updated_at,title`);
        for (const row of rows) {
          const local = this.docs.find(d => d.id === row.id);
          if (!local) continue;
          returned.add(row.id);
          if (row.content || this.pendingContent.has(row.id)) {
            const safe = row.content || local.content;
            if (safe !== local.content) changed = true;
            local.content = safe;
            local.updated_at = row.updated_at;
            local.title = row.title || local.title;
            this.pendingContent.delete(row.id);
            this.contentLoadError.delete(row.id);
            changed = true;
          }
        }
      }
      const stillPending = [...this.pendingContent].filter(id => !byId.has(id));
      if (stillPending.length) { this.resolvePending(stillPending); changed = true; }
      // Запрошенные, но не пришедшие с сервера — показываем то, что есть локально.
      const missing = needContent.filter(id => !returned.has(id) && this.pendingContent.has(id));
      if (missing.length) { this.resolvePending(missing); changed = true; }

      if (changed) {
        if (!this.activeId && this.docs.length) this.activeId = this.docs[0].id;
        this.save();
        if (this.root.style.display !== 'none') this.render();
      }
    } catch (e) {
      debug.warn('[DocsModule] syncFromDb failed', e);
      this.markContentLoadError();
      if (this.root.style.display !== 'none') this.render();
    }
  }

  private markContentLoadError(): void {
    this.contentLoadError ??= new Set<string>();
    for (const id of this.pendingContent) this.contentLoadError.add(id);
  }

  /**
   * Совместная работа: раз в 20 секунд проверяем, не изменил ли открытые
   * документы кто-то другой. Если у нас нет несохранённых правок — молча
   * подтягиваем новую версию; если есть — предупреждаем.
   */
  private async pollRemote(): Promise<void> {
    const companyId = companyService.getActiveId();
    if (!companyId || !this.docs.length || this.root.style.display === 'none') return;
    const ids = this.docs.filter(d => this.serverKnown.has(d.id)).map(d => d.id);
    if (!ids.length) return;
    try {
      const metas = await dbFetch<DocMeta[]>(`docs_documents?company_id=eq.${companyId}&id=in.(${ids.map(i => `"${i}"`).join(',')})&select=${this.metaSelect()}`);
      const byId = new Map(metas.map(m => [m.id, m]));
      const fetchIds: string[] = [];
      for (const doc of this.docs) {
        const m = byId.get(doc.id);
        if (!m) { if (this.serverKnown.has(doc.id)) { this.syncFromDb(); return; } continue; }
        if (m.updated_at > doc.updated_at) {
          if (this.dirty.has(doc.id) || this.saveTimer) {
            if (!this.warnedNoPersist.has('conflict:' + doc.id)) {
              this.warnedNoPersist.add('conflict:' + doc.id);
              showToast(`«${doc.title}» одновременно изменили на другом устройстве. Сохранится ваша версия — проверьте документ.`, 'info');
            }
          } else if (doc.id === this.activeId) fetchIds.push(doc.id);
          // Неактивную вкладку не качаем в фоне — догрузится при переключении.
          else this.pendingContent.add(doc.id);
        }
        if (m.visibility !== doc.visibility || m.owner_id !== doc.owner_id) { doc.visibility = m.visibility; doc.owner_id = m.owner_id; }
      }
      if (!fetchIds.length) return;
      const rows = await dbFetch<Array<{ id: string; content: string; updated_at: number; title: string }>>(
        `docs_documents?company_id=eq.${companyId}&id=in.(${fetchIds.map(i => `"${i}"`).join(',')})&select=id,content,updated_at,title`);
      let activeChanged = false;
      for (const row of rows) {
        const doc = this.docs.find(d => d.id === row.id);
        if (!doc || !row.content || this.dirty.has(doc.id)) continue;
        doc.content = row.content; doc.updated_at = row.updated_at; doc.title = row.title || doc.title;
        this.saveDocContent(doc);
        if (doc.id === this.activeId) activeChanged = true;
      }
      this.save();
      if (activeChanged) {
        const doc = this.activeDoc();
        if (doc?.type === 'excel' && this.sheetEditor) this.sheetEditor.refresh();
        else if (doc?.type === 'word' && this.wordEditor) this.wordEditor.refresh();
        else this.render();
      }
    } catch (e) { debug.warn('[DocsModule] poll failed', e); }
  }

  /** Сервер ответил, а документа там нет (или не ответил вовсе) — показываем, что есть. */
  private resolvePending(ids?: string[]): void {
    this.contentLoadError ??= new Set<string>();
    const list = ids ?? [...this.pendingContent];
    if (!list.length) return;
    const lost: string[] = [];
    for (const id of list) {
      this.pendingContent.delete(id);
      this.contentLoadError.delete(id);
      const doc = this.docs.find(d => d.id === id);
      if (!doc) continue;
      if (!doc.content) { doc.content = doc.type === 'word' ? '' : this.emptyExcel(); lost.push(doc.title); }
    }
    if (lost.length) {
      showToast(lost.length === 1
        ? `Не удалось загрузить содержимое «${lost[0]}» — на сервере его нет.`
        : `Не удалось загрузить содержимое ${lost.length} документов — на сервере их нет.`, 'error');
    }
  }

  /** Записать документ на сервер (upsert). */
  private saveDocToDb(doc: DocItem, done?: (ok: boolean) => void): void {
    const companyId = companyService.getActiveId();
    if (!companyId) { done?.(false); return; }
    if (this.pendingContent.has(doc.id) || this.deletingDocs.has(doc.id) || this.deletedDocs.has(doc.id)) { done?.(false); return; }
    // Пустую заготовку Excel в БД не пишем, если документ там уже есть — затрёт настоящий
    if (doc.type === 'excel' && !doc.content) { done?.(false); return; }
    this.setSaveState('saving');
    const body: Record<string, unknown> = {
      id: doc.id, company_id: companyId, type: doc.type, title: doc.title, content: doc.content, updated_at: doc.updated_at,
    };
    if (this.srvV2) {
      body.meta = doc.meta ?? {};
      // Владелец и доступ задаются только при создании: менять их может
      // лишь владелец отдельным запросом (setVisibility)
      if (!this.serverKnown.has(doc.id)) body.visibility = doc.visibility ?? 'company';
    }
    const chains = this.saveChains ?? (this.saveChains = new Map<string, Promise<void>>());
    const previous = chains.get(doc.id);
    const run = async (): Promise<void> => {
      if (this.deletingDocs.has(doc.id) || this.deletedDocs.has(doc.id)) { done?.(false); return; }
      await dbFetch<unknown>(`docs_documents`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      });
      if (this.deletingDocs.has(doc.id) || this.deletedDocs.has(doc.id)) { done?.(false); return; }
      const current = this.docs.find(d => d.id === doc.id);
      if (current && current.updated_at > Number(body.updated_at)) { done?.(true); return; }
      const first = !this.serverKnown.has(doc.id);
      this.serverKnown.add(doc.id);
      this.dirty.delete(doc.id);
      if (first && doc.owner_id === undefined) doc.owner_id = this.me();
      this.save();
      this.setSaveState('saved');
      done?.(true);
    };
    // Первый запрос вызываем немедленно, чтобы закрытие вкладки успело
    // поставить POST в транспорт до возврата управления браузеру.
    const task = previous ? previous.catch(() => undefined).then(run) : run();
    chains.set(doc.id, task);
    void task.then(() => {
      if (chains.get(doc.id) === task) chains.delete(doc.id);
    }, () => {
      if (chains.get(doc.id) === task) chains.delete(doc.id);
    });
  }

  private async deleteDocFromDb(id: string, companyId: string): Promise<void> {
    const result = await dbFetch<{ deleted: boolean }>('rpc/docs_delete_permanently', {
      method: 'POST', body: JSON.stringify({ p_id: id, p_company_id: companyId }),
    });
    if (result?.deleted !== true) throw new Error('Сервер не подтвердил удаление документа');
  }

  /** «Недавние» и открытые вкладки — на аккаунт (с задержкой, чтобы не спамить). */
  private syncRecentToServer(id: string, open: boolean): void {
    const companyId = companyService.getActiveId();
    if (!companyId || this.srvV2 === false || this.deletingDocs.has(id) || this.deletedDocs.has(id)) return;
    const t = this.recentSyncTimers.get(id);
    if (t) clearTimeout(t);
    this.recentSyncTimers.set(id, setTimeout(() => {
      this.recentSyncTimers.delete(id);
      if (this.deletingDocs.has(id) || this.deletedDocs.has(id)) return;
      if (!this.serverKnown.has(id) && !this.docs.some(d => d.id === id && d.content)) return;
      dbFetch<unknown>('docs_recent', {
        method: 'POST',
        body: JSON.stringify({ company_id: companyId, doc_id: id, opened_at: Date.now(), is_open: open }),
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      }).catch(e => debug.warn('[DocsModule] recent sync failed', e));
    }, 1500));
  }

  private removeRecentOnServer(id: string): void {
    if (this.srvV2 === false) return;
    dbFetch<unknown>(`docs_recent?doc_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => { /* ignore */ });
  }

  /** Сменить доступ: «весь кабинет» или «только я». Менять может только владелец. */
  private async setVisibility(doc: DocItem, visibility: 'company' | 'private'): Promise<void> {
    const me = this.me();
    if (!this.srvV2) { showToast('Доступ к документам появится после обновления сервера', 'info'); return; }
    if (doc.owner_id && doc.owner_id !== me) { showToast('Доступ к документу меняет только его владелец', 'info'); return; }
    const companyId = companyService.getActiveId();
    if (!companyId) return;
    this.flushSave();
    try {
      if (!this.serverKnown.has(doc.id)) {
        doc.visibility = visibility;
        await new Promise<void>((res, rej) => this.saveDocToDb(doc, ok => ok ? res() : rej(new Error('не сохранилось'))));
      }
      await dbFetch<unknown>(`docs_documents?id=eq.${encodeURIComponent(doc.id)}&company_id=eq.${companyId}`, {
        method: 'PATCH',
        body: JSON.stringify({ visibility, ...(doc.owner_id ? {} : { owner_id: me }) }),
        headers: { 'Prefer': 'return=minimal' },
      });
      doc.visibility = visibility;
      if (!doc.owner_id) doc.owner_id = me;
      this.save();
      this.touchRecent(doc);
      this.allDocs = null;
      this.render();
      showToast(visibility === 'private' ? `«${doc.title}» теперь видите только вы` : `«${doc.title}» открыт всем участникам кабинета`, 'success');
    } catch (e) {
      showToast('Не удалось изменить доступ: ' + (e as Error).message, 'error');
    }
  }

  /** Все документы кабинета, доступные мне (для «Все документы»). */
  private async loadAllDocs(): Promise<void> {
    const companyId = companyService.getActiveId();
    if (!companyId) { this.allDocs = []; if (this.root.style.display !== 'none') this.render(); return; }
    try {
      await this.probeServer(companyId);
      this.allDocs = await dbFetch<DocMeta[]>(`docs_documents?company_id=eq.${companyId}&select=${this.metaSelect()}&order=updated_at.desc&limit=500`);
      if (this.srvV2 && !this.memberNames.size) {
        companyService.getMembers(companyId).then(list => {
          for (const m of list) this.memberNames.set(m.user_id, m.users?.first_name || m.first_name || (m.users?.telegram_username ? '@' + m.users.telegram_username : 'Участник'));
          if (this.root.style.display !== 'none' && !this.activeId) this.render();
        }).catch(() => { /* имена — не главное */ });
      }
      if (this.root.style.display !== 'none') this.render();
    } catch (e) {
      debug.warn('[DocsModule] loadAllDocs failed', e);
      this.allDocs = [];
      if (this.root.style.display !== 'none') this.render();
    }
  }

  private setSaveState(s: 'saved' | 'saving' | 'error'): void {
    this.saveState = s;
    const el = this.root.querySelector<HTMLElement>('[data-save-state]');
    if (el) el.innerHTML = this.saveStateHtml();
  }

  private saveStateHtml(): string {
    const doc = this.activeDoc();
    if (!doc) return '';
    if (this.saveState === 'saving' || this.saveTimer) return '<span class="docs-sync-dot saving"></span>Сохранение…';
    if (this.saveState === 'error') return '<span class="docs-sync-dot error"></span>Не сохранено на сервере';
    return this.serverKnown.has(doc.id) && !this.dirty.has(doc.id) ? '<span class="docs-sync-dot"></span>Сохранено' : '<span class="docs-sync-dot saving"></span>Только на этом ПК';
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.setSaveState('saving');
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
      if (this.activeId) {
        const doc = this.docs.find(d => d.id === this.activeId);
        if (doc) this.saveDocToDb(doc);
      }
    }, 800);
  }

  private flushSave(): void {
    this.wordEditor?.flush();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
      for (const doc of this.docs) if (this.dirty.has(doc.id)) this.saveDocToDb(doc);
    }
  }

  // ═══════════════════════════ Документы ═══════════════════════════

  private activeDoc(): DocItem | null { return this.docs.find(d => d.id === this.activeId) ?? null; }

  private addDoc(doc: DocItem): void {
    if (doc.owner_id === undefined) doc.owner_id = this.me();
    if (!doc.visibility) doc.visibility = 'company';
    this.docs.unshift(doc);
    if (this.docs.length > MAX_DOCS) {
      // Вытесняем самый старый открытый (не активный) — он остаётся в «Недавних» и на сервере
      const victims = this.docs.filter(d => d.id !== doc.id && !this.dirty.has(d.id)).sort((a, b) => a.updated_at - b.updated_at);
      const v = victims[0];
      if (v) { this.docs = this.docs.filter(d => d.id !== v.id); this.syncRecentToServer(v.id, false); }
    }
    this.activeId = doc.id;
    this.activeSheetIdx = 0;
    this.dirty.add(doc.id);
    this.touchRecent(doc);
    this.save();
    this.saveDocToDb(doc);
    this.render();
  }

  private createDoc(type: DocType): void {
    const now = Date.now();
    const wordN = this.docs.filter(d => d.type === 'word').length + 1;
    const excelN = this.docs.filter(d => d.type === 'excel').length + 1;
    this.addDoc({
      id: this.newId(), type,
      title: type === 'word' ? `Документ ${wordN}` : `Книга ${excelN}`,
      content: type === 'word' ? '' : this.emptyExcel(),
      updated_at: now,
    });
  }

  /** Закрыть вкладку — документ остаётся в «Недавних», в кеше и на сервере. */
  private closeDoc(id: string): void {
    const idx = this.docs.findIndex(d => d.id === id);
    if (idx === -1) return;
    const doc = this.docs[idx];
    this.flushSave();
    this.touchRecent(doc, false);
    this.saveDocContent(doc);
    this.saveDocToDb(doc);
    this.docs.splice(idx, 1);
    if (this.activeId === id) { this.activeId = this.docs[0]?.id ?? null; this.activeSheetIdx = 0; }
    this.save();
    this.render();
  }

  /** Удалить документ насовсем — из кеша и с сервера. Необратимо. */
  private async deleteDoc(id: string, skipConfirm = false): Promise<boolean> {
    if (this.deletingDocs.has(id)) return false;
    const companyId = companyService.getActiveId();
    const doc = this.docs.find(d => d.id === id);
    const title = doc?.title ?? this.recent.find(r => r.id === id)?.title ?? this.allDocs?.find(d => d.id === id)?.title ?? 'документ';
    if (!skipConfirm && !confirm(`Удалить «${title}» навсегда?\nДокумент и его содержимое будут удалены из БД и из «Недавних» у всех участников. Отменить будет нельзя.`)) return false;
    if (!companyId) { showToast('Выберите кабинет перед удалением', 'error'); return false; }
    this.deletingDocs.add(id);
    const recentTimer = this.recentSyncTimers.get(id);
    if (recentTimer) { clearTimeout(recentTimer); this.recentSyncTimers.delete(id); }
    try {
      await this.deleteDocFromDb(id, companyId);
      this.deletedDocs.add(id);
      if (companyService.getActiveId() !== companyId) return true;
      if (this.activeId === id) this.destroyEditors();
      this.docs = this.docs.filter(d => d.id !== id);
      this.pendingContent.delete(id);
      this.dirty.delete(id);
      this.serverKnown.delete(id);
      this.dropDocContent(id);
      // Удаляем также старые кеши до привязки к кабинету, иначе документ
      // мог открыться из восстановленного содержимого при следующем входе.
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(STORAGE_KEY) && key.endsWith(`__doc_${id}`)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
      this.recent = this.recent.filter(r => r.id !== id);
      this.saveRecent();
      if (this.allDocs) this.allDocs = this.allDocs.filter(d => d.id !== id);
      this.xlUndoStack = this.xlUndoStack.filter(snap => snap.docId !== id);
      this.xlRedoStack = this.xlRedoStack.filter(snap => snap.docId !== id);
      for (const key of Object.keys(this.xlSelMemo)) if (key.startsWith(id + ':')) delete this.xlSelMemo[key];
      delete this.xlSheetScroll[id];
      if (this.bookCache?.docId === id) { this.bookCache = null; this.wbEval = null; }
      if (this.activeId === id) { this.activeId = this.docs[0]?.id ?? null; this.activeSheetIdx = 0; }
      if (!this.activeId) localStorage.removeItem(this.ak());
      this.save();
      this.render();
      showToast(`«${title}» удалён навсегда`, 'success');
      return true;
    } catch (e) {
      showToast('Документ не удалён: ' + (e as Error).message, 'error');
      return false;
    } finally { this.deletingDocs.delete(id); }
  }

  private renameDoc(id: string, title: string): void {
    const doc = this.docs.find(d => d.id === id);
    if (!doc) return;
    doc.title = title.trim() || doc.title;
    doc.updated_at = Date.now();
    this.dirty.add(doc.id);
    const r = this.recent.find(x => x.id === id);
    if (r) { r.title = doc.title; this.saveRecent(); }
    this.scheduleSave();
  }

  private updateContent(id: string, content: string): void {
    const doc = this.docs.find(d => d.id === id);
    if (!doc) return;
    if (this.pendingContent.has(id)) {
      debug.warn('[DocsModule] ignored write to doc whose content is still loading', id);
      return;
    }
    this.invalidateFormulas();
    doc.content = content;
    doc.updated_at = Date.now();
    this.dirty.add(id);
    if (this.recent[0]?.id !== id) this.touchRecent(doc);
    this.scheduleSave();
  }

  /** Открыть документ по id: из открытых, из кеша или с сервера. */
  private openDoc(id: string, hint?: { title?: string; type?: DocType }): void {
    if (this.docs.some(d => d.id === id)) {
      this.flushSave();
      this.activeId = id; this.activeSheetIdx = 0;
      this.touchRecent(this.docs.find(d => d.id === id)!);
      this.save();
      this.render();
      if (this.pendingContent.has(id)) this.syncFromDb();
      return;
    }
    const rec = this.recent.find(r => r.id === id);
    const meta = this.allDocs?.find(d => d.id === id);
    const title = hint?.title ?? rec?.title ?? meta?.title ?? 'Документ';
    const type = hint?.type ?? rec?.type ?? meta?.type ?? 'excel';
    let cached: string | null = null;
    try { cached = localStorage.getItem(this.ck(id)); } catch { /* ignore */ }
    const doc: DocItem = {
      id, type, title, content: cached ?? '', updated_at: cached ? (rec?.updated_at ?? 0) : 0,
      ...(meta ? { owner_id: meta.owner_id, visibility: meta.visibility, ...(meta.meta && Object.keys(meta.meta).length ? { meta: meta.meta } : {}) } : rec ? { owner_id: rec.owner_id, visibility: rec.visibility } : {}),
    };
    this.flushSave();
    this.docs.unshift(doc);
    if (this.docs.length > MAX_DOCS) {
      const v = this.docs.filter(d => d.id !== id && !this.dirty.has(d.id)).sort((a, b) => a.updated_at - b.updated_at)[0];
      if (v) this.docs = this.docs.filter(d => d.id !== v.id);
    }
    // Даже при наличии кеша сверимся с сервером: другой участник мог изменить документ
    this.pendingContent.add(id);
    (this.contentLoadError ??= new Set<string>()).delete(id);
    if (cached) { this.pendingContent.delete(id); }
    this.activeId = id;
    this.activeSheetIdx = 0;
    this.touchRecent(doc);
    this.save();
    this.render();
    this.syncFromDb();
  }

  private newId(): string { return 'd_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  private emptyExcel(): string {
    return this.serializeExcel(newWorkbook());
  }

  // ═══════════════════════════ Книга Excel ═══════════════════════════

  parseExcelContent(content: string): ExcelContent {
    try {
      const p = JSON.parse(content);
      if (p && typeof p === 'object' && !Array.isArray(p) && Array.isArray(p.sheets)) {
        const out: ExcelContent = {
          sheets: p.sheets.map((s: any) => {
            const sheet: SheetData = {
              ...s,
              name: s.name || 'Лист1',
              data: this.normalizeCellGrid(s.data || [], Array.isArray(s.styles) ? s.styles : undefined),
            };
            delete sheet.styles;
            if (!sheet.data.length) sheet.data = [[{ v: '' }]];
            // Документы, импортированные до 15.10.2026, хранят проверку данных по
            // ячейкам (десятки тысяч копий одного правила) — сжимаем при открытии.
            const xl = sheet.xl as any;
            if (xl?.dv && typeof xl.dv === 'object') xl.dv = compactValidations(xl.dv);
            return sheet;
          }),
        };
        if (!out.sheets.length) return newWorkbook();
        if (p.font && typeof p.font.name === 'string') out.font = { name: p.font.name, size: +p.font.size || 11 };
        return out;
      }
      if (Array.isArray(p)) return { sheets: [{ name: 'Лист1', data: this.normalizeCellGrid(p) }] };
    } catch { /* повреждённое содержимое — отдаём пустую книгу */ }
    return newWorkbook();
  }

  /**
   * Сериализация книги: одинаковые стили сводятся в палитру листа.
   * Единственное место, где книга превращается в строку.
   */
  serializeExcel(ec: ExcelContent): string {
    const sheets = ec.sheets.map(sheet => {
      const palette: string[] = [];
      const index = new Map<string, number>();
      const data = sheet.data.map(row => row.map(cell => {
        const out: any = { v: cell.v };
        if (cell.t) out.t = cell.t;
        if (cell.nf) out.nf = cell.nf;
        if (cell.img) { out.img = cell.img; if (cell.imgW) out.imgW = cell.imgW; if (cell.imgH) out.imgH = cell.imgH; }
        if (cell.link) out.link = cell.link;
        if (cell.note) out.note = cell.note;
        if (cell.rt?.length) out.rt = cell.rt;
        if (cell.s) {
          let i = index.get(cell.s);
          if (i === undefined) { i = palette.length; palette.push(cell.s); index.set(cell.s, i); }
          out.si = i;
        }
        return out;
      }));
      const { styles: _s, ...rest } = sheet;
      return { ...rest, data, ...(palette.length ? { styles: palette } : {}) };
    });
    return JSON.stringify(ec.font ? { sheets, font: ec.font } : { sheets });
  }

  private normalizeCellGrid(p: any[][], styles?: string[]): CellData[][] {
    const TYPES = new Set(['n', 's', 'd', 'b']);
    const norm = new Map<string, string>();
    const canon = (s: string) => { let c = norm.get(s); if (c === undefined) { c = normalizeCss(s); norm.set(s, c); } return c; };
    const rows = (p || []).map(row => (row || []).map((cell: unknown) => {
      if (typeof cell === 'string') return { v: cell };
      if (cell && typeof cell === 'object' && 'v' in cell) {
        const c = cell as { v?: unknown; s?: unknown; t?: unknown; nf?: unknown; si?: unknown; img?: unknown; imgW?: unknown; imgH?: unknown; link?: unknown; note?: unknown; rt?: unknown };
        const out: CellData = { v: String(c.v ?? '') };
        let s: string | undefined;
        if (typeof c.si === 'number' && styles && typeof styles[c.si] === 'string') s = styles[c.si];
        else if (typeof c.s === 'string' && c.s) s = c.s;
        // Старые документы хранили «сырой» CSS (background:, 13px, border:1px solid #333) — приводим к канону
        if (s) { const cs = canon(s); if (cs) out.s = cs; }
        if (typeof c.t === 'string' && TYPES.has(c.t)) out.t = c.t as CellType;
        if (typeof c.nf === 'string' && c.nf) out.nf = c.nf;
        if (typeof c.img === 'string' && isSafeImageSrc(c.img)) {
          out.img = c.img;
          if (typeof c.imgW === 'number' && c.imgW > 0) out.imgW = Math.round(c.imgW);
          if (typeof c.imgH === 'number' && c.imgH > 0) out.imgH = Math.round(c.imgH);
        }
        if (typeof c.link === 'string' && /^(https?:|mailto:|tel:|#)/i.test(c.link)) out.link = c.link;
        if (typeof c.note === 'string' && c.note) out.note = c.note;
        if (Array.isArray(c.rt)) out.rt = (c.rt as any[]).filter(x => x && typeof x.text === 'string').map(x => ({ text: x.text, ...(typeof x.s === 'string' && x.s ? { s: x.s } : {}) }));
        return out;
      }
      return { v: '' };
    }));
    // Прямоугольник: строки одинаковой длины
    const w = Math.max(0, ...rows.map(r => r.length));
    for (const r of rows) while (r.length < w) r.push({ v: '' });
    return rows;
  }

  /** Книга документа: разобранная один раз, пока содержимое не изменилось извне. */
  private getBook(doc: DocItem): ExcelContent {
    const c = this.bookCache;
    if (c && c.docId === doc.id && c.content === doc.content) return c.book;
    const book = this.parseExcelContent(doc.content);
    this.bookCache = { docId: doc.id, content: doc.content, book };
    this.wbEval = null;
    return book;
  }

  /** Сохранить изменённую книгу активного документа. */
  private commitBook(doc: DocItem, book: ExcelContent): void {
    const content = this.serializeExcel(book);
    this.updateContent(doc.id, content);
    this.bookCache = { docId: doc.id, content, book };
    this.wbEval = null;
  }

  /** Вычислитель листа книги: со ссылками на другие листы и колонками целиком. */
  private bookEvaluator(book: ExcelContent, si: number): Evaluator {
    if (!this.wbEval || this.wbEval.book !== book) this.wbEval = { book, evs: new Map() };
    const hit = this.wbEval.evs.get(si);
    if (hit) return hit;
    const grids = new Map<SheetData, GridAccess>();
    const gridOf = (sh: SheetData): GridAccess => {
      let g = grids.get(sh);
      if (g) return g;
      g = {
        raw: (r, c) => sh.data[r]?.[c]?.v ?? '',
        isNumeric: (r, c) => sh.data[r]?.[c]?.t === 'n',
        rowCount: () => sh.data.length,
        sheet: (name) => {
          const low = name.toLowerCase();
          const target = book.sheets.find(s => s.name.toLowerCase() === low);
          return target ? gridOf(target) : null;
        },
      };
      grids.set(sh, g);
      return g;
    };
    const ev = createEvaluator(gridOf(book.sheets[si] ?? book.sheets[0]));
    this.wbEval.evs.set(si, ev);
    return ev;
  }

  // ═══════════════════════════ Импорт ═══════════════════════════

  private async importFile(file: File): Promise<void> {
    const name = file.name;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const bare = name.replace(/\.[^.]+$/, '');
    const now = Date.now();
    const toast = showToast(`Открываю «${name}»…`, 'info');
    void toast;

    try {
      if (ext === 'xlsx' || ext === 'xlsm') {
        const book = await readXlsx(await file.arrayBuffer(), { maxRows: MAX_IMPORT_ROWS });
        this.addDoc({ id: this.newId(), type: 'excel', title: bare, content: this.serializeExcel(book), updated_at: now });
        if (book.sheets.some(s => s.truncated || s.truncatedCols)) showToast(`Импорт ограничен: ${book.sheets.some(s => s.truncated) ? `первые ${MAX_IMPORT_ROWS.toLocaleString('ru-RU')} строк` : ''}${book.sheets.some(s => s.truncated) && book.sheets.some(s => s.truncatedCols) ? ' и ' : ''}${book.sheets.some(s => s.truncatedCols) ? `первые ${MAX_IMPORT_COLS} колонок` : ''}`, 'info');
        return;
      }

      if (ext === 'xls' || ext === 'ods' || ext === 'xlsb') {
        const book = this.readLegacyWorkbook(await file.arrayBuffer());
        this.addDoc({ id: this.newId(), type: 'excel', title: bare, content: this.serializeExcel(book), updated_at: now });
        return;
      }

      if (ext === 'csv' || ext === 'tsv') {
        const text = await this.readTextFile(file);
        const book = this.readCsv(text, ext === 'tsv' ? '\t' : undefined);
        this.addDoc({ id: this.newId(), type: 'excel', title: bare, content: this.serializeExcel(book), updated_at: now });
        return;
      }

      if (ext === 'docx' || ext === 'docm') {
        const { html, meta } = await readDocx(await file.arrayBuffer());
        this.addDoc({ id: this.newId(), type: 'word', title: bare, content: html, updated_at: now, meta });
        return;
      }

      if (ext === 'html' || ext === 'htm') {
        const txt = await file.text();
        const body = txt.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? txt;
        this.addDoc({ id: this.newId(), type: 'word', title: bare, content: sanitizeHtml(body), updated_at: now });
        return;
      }

      if (ext === 'md' || ext === 'markdown') {
        this.addDoc({ id: this.newId(), type: 'word', title: bare, content: this.markdownToHtml(await file.text()), updated_at: now });
        return;
      }

      if (ext === 'txt' || ext === 'rtf') {
        const txt = await this.readTextFile(file);
        const plain = ext === 'rtf' ? txt.replace(/\\par[d]?/g, '\n').replace(/\{\\[^{}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, '') : txt;
        this.addDoc({ id: this.newId(), type: 'word', title: bare, content: this.textToHtml(plain), updated_at: now });
        return;
      }

      if (ext === 'doc') {
        try {
          const text = await this.docToText(await file.arrayBuffer());
          this.addDoc({ id: this.newId(), type: 'word', title: bare, content: this.textToHtml(text), updated_at: now });
          showToast('Старый формат .doc: открыт только текст. Для полного оформления сохраните файл в Word как .docx.', 'info');
        } catch {
          showToast('Формат .doc не поддерживается. Пересохраните файл как .docx.', 'error');
        }
        return;
      }

      showToast(`Неизвестный формат: .${ext}. Поддерживаются: xlsx, xls, ods, csv, docx, html, txt, md`, 'error');
    } catch (e) {
      debug.warn('[DocsModule] import failed', e);
      showToast('Ошибка при открытии файла: ' + (e as Error).message, 'error');
    }
  }

  /** Текст файла с угадыванием кодировки (выгрузки 1С бывают в cp1251). */
  private async readTextFile(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    const utf = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (!utf.includes('\uFFFD')) return utf.replace(/^\uFEFF/, '');
    try { return new TextDecoder('windows-1251').decode(buf); } catch { return utf; }
  }

  private textToHtml(text: string): string {
    return text.replace(/\r\n?/g, '\n').split('\n').map(line => `<p>${line ? this.esc(line) : '<br>'}</p>`).join('');
  }

  /** Простой Markdown → HTML: заголовки, списки, жирный/курсив, ссылки, таблицы. */
  private markdownToHtml(md: string): string {
    const inline = (s: string) => this.esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/__(.+?)__/g, '<b>$1</b>')
      .replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/_(.+?)_/g, '<i>$1</i>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    let html = '', list: 'ul' | 'ol' | null = null, inCode = false, code: string[] = [];
    const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^```/.test(l)) { if (inCode) { html += `<pre>${this.esc(code.join('\n'))}</pre>`; code = []; } closeList(); inCode = !inCode; continue; }
      if (inCode) { code.push(l); continue; }
      const h = l.match(/^(#{1,6})\s+(.*)$/);
      if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      const ul = l.match(/^\s*[-*+]\s+(.*)$/), ol = l.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        const t = ul ? 'ul' : 'ol';
        if (list !== t) { closeList(); html += `<${t}>`; list = t; }
        html += `<li>${inline((ul ?? ol)![1])}</li>`;
        continue;
      }
      if (/^\|.*\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
        closeList();
        const row = (s: string) => s.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        html += '<table><tr>' + row(l).map(c => `<th>${inline(c)}</th>`).join('') + '</tr>';
        i += 2;
        while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) { html += '<tr>' + row(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>'; i++; }
        i--;
        html += '</table>';
        continue;
      }
      if (/^>\s?/.test(l)) { closeList(); html += `<blockquote>${inline(l.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      if (/^(-{3,}|\*{3,})$/.test(l.trim())) { closeList(); html += '<hr>'; continue; }
      closeList();
      html += `<p>${l.trim() ? inline(l) : '<br>'}</p>`;
    }
    closeList();
    return html;
  }

  /**
   * .xls/.ods через SheetJS: значения, форматы чисел, объединения, ширины.
   * Лист берётся целиком с A1 — раньше пустые строки и колонки в начале
   * вырезались, и данные съезжали.
   */
  private readLegacyWorkbook(buf: ArrayBuffer): ExcelContent {
    const wb = XLSX.read(buf, { type: 'array', cellNF: true, cellFormula: true, cellDates: false, cellStyles: true, sheetRows: MAX_IMPORT_ROWS + 1 });
    const sheets: SheetData[] = wb.SheetNames.map((sheetName: string) => {
      const ws = wb.Sheets[sheetName];
      if (!ws['!ref']) return { name: sheetName, data: [[{ v: '' }]] };
      const range = XLSX.utils.decode_range(ws['!ref']);
      const rows = range.e.r + 1, rawCols = range.e.c + 1, cols = Math.min(rawCols, MAX_IMPORT_COLS);
      const data: CellData[][] = [];
      for (let r = 0; r < Math.min(rows, MAX_IMPORT_ROWS); r++) {
        const row: CellData[] = [];
        for (let c = 0; c < cols; c++) row.push(this.xlCellFromSheetJS(ws[XLSX.utils.encode_cell({ r, c })]));
        data.push(row);
      }
      const colWidths = Array.from({ length: cols }, (_, c) => { const ci = (ws['!cols'] || [])[c]; return ci?.wch ? Math.round(ci.wch * 7 + 5) : ci?.wpx ? Math.round(ci.wpx) : null; });
      const rowHeights = Array.from({ length: data.length }, (_, r) => { const ri = (ws['!rows'] || [])[r]; return ri?.hpt ? Math.round(ri.hpt * 4 / 3) : ri?.hpx ? Math.round(ri.hpx) : null; });
      const merges: MergeRange[] = (ws['!merges'] ?? []).map((m: any) => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
      return { name: sheetName, data, colWidths, rowHeights, ...(merges.length ? { merges } : {}), ...(rows > MAX_IMPORT_ROWS ? { truncated: true } : {}), ...(rawCols > MAX_IMPORT_COLS ? { truncatedCols: true } : {}) };
    });
    return { sheets: sheets.length ? sheets : newWorkbook().sheets };
  }

  /** CSV: разделитель угадывается (; в русском Excel), числа и даты распознаются, пустые строки сохраняются. */
  private readCsv(text: string, sep?: string): ExcelContent {
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const delim = sep ?? ([';', ',', '\t', '|'].map(d => [d, first.split(d).length] as const).sort((a, b) => b[1] - a[1])[0][0]);
    const rows: string[][] = [];
    let row: string[] = [], cur = '', q = false;
    const t = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; continue; }
      if (ch === '"' && cur === '') { q = true; continue; }
      if (ch === delim) { row.push(cur); cur = ''; continue; }
      if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; continue; }
      cur += ch;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const rawW = Math.max(1, ...rows.map(r => r.length));
    const w = Math.min(rawW, MAX_IMPORT_COLS);
    const data = rows.slice(0, MAX_IMPORT_ROWS).map(r => { const out = r.slice(0, w).map(v => interpretInput(v, undefined)); while (out.length < w) out.push({ v: '' }); return out; });
    if (!data.length) data.push([{ v: '' }]);
    return { sheets: [{ name: 'Лист1', data, ...(rows.length > MAX_IMPORT_ROWS ? { truncated: true } : {}), ...(rawW > MAX_IMPORT_COLS ? { truncatedCols: true } : {}) }] };
  }

  /** Ячейка SheetJS → модель: сырое значение, а не отформатированное. */
  private xlCellFromSheetJS(cell: any): CellData {
    if (!cell) return { v: '' };
    if (cell.f) {
      const out: CellData = { v: '=' + String(cell.f) };
      if (cell.z && cell.z !== 'General') out.nf = String(cell.z);
      return out;
    }
    if (cell.v == null) return { v: '' };
    const out: CellData = { v: '' };
    if (cell.z && cell.z !== 'General') out.nf = String(cell.z);
    switch (cell.t) {
      case 'n': out.v = String(cell.v); out.t = 'n'; break;
      case 'd': {
        const d = cell.v instanceof Date ? cell.v : new Date(cell.v);
        if (!isNaN(d.getTime())) { out.v = String(dateToSerial(d)); out.t = 'n'; if (!out.nf) out.nf = 'dd.mm.yyyy'; }
        else out.v = String(cell.v);
        break;
      }
      case 'b': out.v = cell.v ? 'ИСТИНА' : 'ЛОЖЬ'; out.t = 'b'; break;
      case 'e': out.v = String(cell.w ?? cell.v); delete out.nf; break;
      default: out.v = String(cell.v);
    }
    return out;
  }

  private async docToText(buf: ArrayBuffer): Promise<string> {
    // Старый двоичный .doc: вытаскиваем читаемый текст (UTF-16LE фрагменты)
    const bytes = new Uint8Array(buf);
    let out = '', run = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = bytes[i] | (bytes[i + 1] << 8);
      if ((code >= 32 && code < 0xD800) || code === 13 || code === 9) run += code === 13 ? '\n' : String.fromCharCode(code);
      else { if (run.length > 8) out += run; run = ''; }
    }
    if (run.length > 8) out += run;
    const text = out.replace(/[^\S\n]+/g, ' ').trim();
    if (text.length < 20) throw new Error('empty');
    return text;
  }

  // ═══════════════════════════ Экспорт ═══════════════════════════

  private async exportDoc(doc: DocItem, format: string): Promise<void> {
    this.flushSave();
    try {
      if (doc.type === 'excel') {
        const book = this.getBook(doc);
        if (format === 'xlsx') {
          await this.exportExcelXlsx(doc, book);
        } else if (format === 'csv') {
          const si = Math.min(this.activeSheetIdx, book.sheets.length - 1);
          const sh = book.sheets[si];
          const ev = this.bookEvaluator(book, si);
          const trimmed = this.trimEmpty(sh.data);
          const lines = trimmed.map((row, r) => row.map((cell, c) => {
            let t: string;
            if (cell.v.startsWith('=')) { const v = ev.cellValue(r, c); t = typeof v === 'number' ? formatCellValue(String(v), 'n', cell.nf) : ev.evalToString(cell.v); }
            else t = formatCellValue(cell.v, cell.t, cell.nf);
            return /[;"\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
          }).join(';'));
          this.download(`${doc.title}.csv`, new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
        } else if (format === 'pdf') {
          this.printDoc(doc);
        }
        return;
      }
      if (format === 'docx') {
        await this.exportWordDocx(doc);
      } else if (format === 'html') {
        this.download(`${doc.title}.html`, new Blob([`<!doctype html><html><head><meta charset="utf-8"><title>${this.esc(doc.title)}</title></head><body>${doc.content}</body></html>`], { type: 'text/html;charset=utf-8' }));
      } else if (format === 'txt') {
        const div = document.createElement('div'); div.innerHTML = doc.content.replace(/<\/(p|h\d|li|div|tr)>/gi, '$&\n');
        this.download(`${doc.title}.txt`, new Blob([div.textContent ?? ''], { type: 'text/plain;charset=utf-8' }));
      } else if (format === 'pdf') {
        this.printDoc(doc);
      }
    } catch (e) {
      debug.warn('[DocsModule] export failed', e);
      showToast('Ошибка экспорта: ' + (e as Error).message, 'error');
    }
  }

  /** Выгрузить книгу в .xlsx (через ExcelJS — оформление сохраняется полностью). */
  async exportExcelXlsx(doc: DocItem, book: ExcelContent): Promise<void> {
    const blob = await writeXlsx(book, {
      formulaResult: (si, r, c) => this.bookEvaluator(book, si).evalToString(book.sheets[si].data[r][c].v),
      rangeValues: (ref, si) => {
        const v = this.bookEvaluator(book, si).evaluate('=' + ref);
        return (Array.isArray(v) ? v : [v]).map(x => typeof x === 'object' && x && 'err' in x ? '' : typeof x === 'boolean' ? (x ? 'ИСТИНА' : 'ЛОЖЬ') : String(x));
      },
    });
    this.download(`${doc.title}.xlsx`, blob);
  }

  /** Выгрузить документ Word в .docx. */
  async exportWordDocx(doc: DocItem): Promise<void> {
    const bytes = await writeDocx(doc.content, { meta: doc.meta, title: doc.title });
    this.download(`${doc.title}.docx`, new Blob([bytes as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
  }

  /** Печать / сохранение в PDF через системный диалог браузера. */
  private printDoc(doc: DocItem): void {
    let body = '';
    let pageCss = '@page { size: A4; margin: 15mm; }';
    if (doc.type === 'word') {
      const pg = doc.meta?.page;
      if (pg) pageCss = `@page { size: ${(pg.w / 1440 * 25.4).toFixed(1)}mm ${(pg.h / 1440 * 25.4).toFixed(1)}mm; margin: ${(pg.top / 1440 * 25.4).toFixed(1)}mm ${(pg.right / 1440 * 25.4).toFixed(1)}mm ${(pg.bottom / 1440 * 25.4).toFixed(1)}mm ${(pg.left / 1440 * 25.4).toFixed(1)}mm; }`;
      const font = doc.meta?.font ?? { name: 'Calibri', size: 11 };
      body = `<div class="dw-page" style="box-shadow:none;background:none;padding:0;width:auto;font-family:'${font.name}';font-size:${font.size}pt">${doc.content}</div>`;
    } else {
      const book = this.getBook(doc);
      const si = Math.min(this.activeSheetIdx, book.sheets.length - 1);
      const sh = book.sheets[si];
      const ev = this.bookEvaluator(book, si);
      const trimmed = this.trimEmpty(sh.data);
      body = `<h3 style="font:600 12pt Arial;margin:0 0 6pt">${this.esc(doc.title)} — ${this.esc(sh.name)}</h3><table style="border-collapse:collapse;font:10pt Calibri,Arial">` + trimmed.map((row, r) => `<tr>${row.map((cell, c) => {
        const t = cell.v.startsWith('=') ? (() => { const v = ev.cellValue(r, c); return typeof v === 'number' ? formatCellValue(String(v), 'n', cell.nf) : ev.evalToString(cell.v); })() : formatCellValue(cell.v, cell.t, cell.nf);
        return `<td style="border:1px solid #ccc;padding:2px 5px;${cell.t === 'n' ? 'text-align:right;' : ''}">${this.esc(t)}</td>`;
      }).join('')}</tr>`).join('') + '</table>';
    }
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const d = frame.contentDocument!;
    const css = Array.from(document.querySelectorAll('style')).map(s => s.textContent).join('\n');
    d.open();
    d.write(`<!doctype html><html><head><meta charset="utf-8"><title>${this.esc(doc.title)}</title><style>${css}\n${pageCss}\nbody{margin:0;background:#fff}.dw-page hr.dw-pb{break-after:page;border:0}.dw-page hr.dw-pb::after{display:none}</style></head><body>${body}</body></html>`);
    d.close();
    setTimeout(() => { frame.contentWindow?.focus(); frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); }, 300);
  }

  private trimEmpty(rows: CellData[][]): CellData[][] {
    let lastRow = rows.length;
    while (lastRow > 0 && rows[lastRow - 1].every(c => !c.v)) lastRow--;
    let lastCol = 0;
    for (let r = 0; r < lastRow; r++) for (let c = rows[r].length - 1; c >= 0; c--) { if (rows[r][c].v) { if (c + 1 > lastCol) lastCol = c + 1; break; } }
    return rows.slice(0, lastRow).map(r => r.slice(0, Math.max(1, lastCol)));
  }

  private download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ═══════════════════════════ Отрисовка ═══════════════════════════

  private destroyEditors(): void {
    if (this.sheetEditor) {
      const doc = this.activeDoc();
      if (doc) this.xlSelMemo[`${doc.id}:${this.activeSheetIdx}`] = this.sheetEditor.selection;
      this.sheetEditor.destroy();
      this.sheetEditor = null;
    }
    if (this.wordEditor) { this.wordEditor.destroy(); this.wordEditor = null; }
  }

  private render(): void {
    this.invalidateFormulas();
    this.destroyEditors();
    const active = this.activeDoc();
    this.root.innerHTML = `
      <div class="docs-shell${this.isFullscreen ? ' docs-fullscreen' : ''}">
        <div class="docs-topbar">
          <button class="docs-fs-back-btn" id="docs-fs-back">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
            Назад
          </button>
          <div class="docs-tabs" id="docs-tabs">${this.renderTabs()}</div>
          <details class="docs-file-menu">
          <summary>Файл <span aria-hidden="true">⌄</span></summary>
          <div class="docs-newbtns">
            ${active ? `<label class="docs-name-label">Название документа<input class="docs-title-inp" id="docs-title-inp" aria-label="Название документа" value="${this.esc(active.title)}" data-id="${active.id}"></label>` : ''}
            <div class="docs-recent-wrap" id="docs-recent-wrap">
              <button class="docs-newbtn" id="docs-recent-toggle" title="Недавние и все документы кабинета">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                Документы
              </button>
              <div class="docs-recent-popup" id="docs-recent-popup">
                <div class="docs-recent-head"><span>Недавние</span><span class="docs-recent-note">${this.srvV2 ? 'сохраняются в аккаунте' : ''}</span></div>
                ${this.renderRecentRows()}
                <button class="docs-newbtn" id="docs-browse-all" style="width:100%;margin-top:8px;justify-content:center">Все документы кабинета</button>
              </div>
            </div>
            <button class="docs-newbtn" id="docs-open-file" title="Открыть файл с компьютера (xlsx, xls, csv, docx, txt…)">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              Открыть
            </button>
            <button class="docs-newbtn" id="docs-new-word" title="Новый документ Word">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>
              Word
            </button>
            <button class="docs-newbtn" id="docs-new-excel" title="Новая книга Excel">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></svg>
              Excel
            </button>
            <input type="file" id="docs-file-input" accept=".xlsx,.xlsm,.xls,.ods,.csv,.tsv,.docx,.doc,.html,.htm,.txt,.md,.rtf" style="display:none">
            ${active ? '<button class="docs-newbtn docs-delete" id="docs-delete-btn">Удалить документ…</button>' : ''}
          </div>
          </details>
          ${active ? this.renderEditorActions(active) : ''}
          <button class="docs-fs-sima-btn" id="docs-fs-sima">Сима</button>
        </div>
        <div class="docs-body" id="docs-body">
          ${active ? this.renderEditorShell(active) : this.renderEmpty()}
        </div>
      </div>`;
    this.bindTopbar();
    if (active) this.bindEditor(active);
    aiPage.register(this.getAiCapability());
  }

  private renderTabs(): string {
    if (!this.docs.length) return '<div class="docs-hint">Нет открытых документов</div>';
    return this.docs.map(d => {
      const active = d.id === this.activeId ? 'active' : '';
      const icon = d.type === 'word'
        ? '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>'
        : '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>';
      const lock = d.visibility === 'private' ? ' 🔒' : '';
      return `<div class="docs-tab ${active}" data-id="${d.id}" title="${this.esc(d.title)}">
        <span class="docs-tab-ic">${icon}</span>
        <span class="docs-tab-title">${this.esc(d.title)}${lock}</span>
        <button class="docs-tab-close" data-close="${d.id}" title="Закрыть (останется в «Документах»)">×</button>
      </div>`;
    }).join('');
  }

  private ownerLabel(owner?: string | null, visibility?: string): string {
    const me = this.me();
    if (visibility === 'private') return '<span class="docs-recent-owner private" title="Видите только вы">🔒 личный</span>';
    if (!owner) return '';
    if (owner === me) return '<span class="docs-recent-owner" title="Вы владелец">вы</span>';
    return `<span class="docs-recent-owner" title="Владелец">${this.esc(this.memberNames.get(owner) ?? 'участник')}</span>`;
  }

  private docRow(r: { id: string; title: string; type: DocType; updated_at: number; owner_id?: string | null; visibility?: string }, opts: { removable?: boolean; deletable?: boolean } = {}): string {
    const alreadyOpen = this.docs.some(d => d.id === r.id);
    const icon = r.type === 'word'
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/></svg>';
    const date = r.updated_at ? new Date(r.updated_at).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    return `<div class="docs-recent-row${alreadyOpen ? ' docs-recent-open' : ''}" data-recent-id="${r.id}" data-recent-type="${r.type}" data-recent-title="${this.esc(r.title)}" title="${alreadyOpen ? 'Переключиться' : 'Открыть'}">
      <span class="docs-recent-ic">${icon}</span>
      <span class="docs-recent-info"><span class="docs-recent-title">${this.esc(r.title)}</span><span class="docs-recent-date">${date}</span></span>
      ${this.ownerLabel(r.owner_id, r.visibility)}
      ${alreadyOpen ? '<span class="docs-recent-badge">открыт</span>' : ''}
      ${opts.deletable && this.canDeleteDoc(r) ? `<button class="docs-document-delete" data-delete-doc="${this.esc(r.id)}" aria-label="Удалить ${this.esc(r.title)} навсегда" title="Удалить навсегда"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg></button>` : ''}
      ${opts.removable ? `<button class="docs-recent-del" data-del-recent="${r.id}" title="Убрать из недавних">×</button>` : ''}
    </div>`;
  }

  private canDeleteDoc(doc: { owner_id?: string | null; visibility?: string }): boolean {
    const role = companyService.getActive()?.role;
    return !doc.owner_id || doc.owner_id === this.me() ||
      (doc.visibility !== 'private' && (role === 'owner' || role === 'admin'));
  }

  private renderRecentRows(): string {
    if (!this.recent.length) return '<div class="docs-hint" style="padding:8px 2px">Пока пусто</div>';
    return `<div class="docs-recent-list">${this.recent.map(r => this.docRow(r, { removable: true })).join('')}</div>`;
  }

  private removeRecent(id: string): void {
    this.recent = this.recent.filter(r => r.id !== id);
    this.saveRecent();
    this.removeRecentOnServer(id);
    this.render();
  }

  private renderEmpty(): string {
    const me = this.me();
    const list = (this.allDocs ?? []).filter(d => {
      if (this.browseTab === 'mine' && d.owner_id !== me) return false;
      if (this.browseTab === 'shared' && d.visibility === 'private') return false;
      if (this.browseTab === 'private' && d.visibility !== 'private') return false;
      if (this.browseQuery && !d.title.toLowerCase().includes(this.browseQuery.toLowerCase())) return false;
      return true;
    });
    const tab = (k: typeof this.browseTab, label: string) => `<button data-browse="${k}" class="${this.browseTab === k ? 'on' : ''}">${label}</button>`;
    const browser = this.allDocs === null
      ? '<div class="docs-hint">Загружаю документы кабинета…</div>'
      : `<div class="docs-browser-tabs">${tab('all', 'Все')}${tab('mine', 'Мои')}${tab('shared', 'Общие')}${tab('private', 'Личные')}</div>
         <input class="docs-search" id="docs-browse-q" placeholder="Поиск по названию" value="${this.esc(this.browseQuery)}">
         <div class="docs-recent-list">${list.length ? list.map(d => this.docRow(d, { deletable: true })).join('') : '<div class="docs-hint">Нет документов</div>'}</div>`;
    return `<div class="docs-empty" style="overflow:auto;justify-content:flex-start;padding:32px 16px">
      <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:.3;margin-top:16px"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
      <div class="docs-empty-title">Нет открытых документов</div>
      <div class="docs-empty-sub">Создайте новую книгу Excel или документ Word, откройте файл с компьютера<br>или перетащите его сюда. Документы хранятся в вашем аккаунте.</div>
      ${this.recent.length ? `<div class="docs-recent"><div class="docs-recent-head"><span>Недавние</span><span class="docs-recent-note">${this.srvV2 ? 'с любого устройства' : ''}</span></div>${this.renderRecentRows()}</div>` : ''}
      <div class="docs-browser"><div class="docs-recent-head"><span>Все документы кабинета</span></div>${browser}</div>
    </div>`;
  }

  private renderEditorShell(doc: DocItem): string {
    const errors = this.contentLoadError ?? (this.contentLoadError = new Set<string>());
    const body = errors.has(doc.id)
      ? `<div class="docs-loading docs-load-error"><div class="docs-loading-txt">Не удалось загрузить «${this.esc(doc.title)}».</div><div class="docs-loading-sub">Документ сохранён локально; повторите попытку, когда соединение восстановится.</div><button class="docs-retry-btn" id="docs-retry-content">Повторить</button></div>`
      : this.pendingContent.has(doc.id)
      ? `<div class="docs-loading"><div class="docs-loading-spin"></div><div class="docs-loading-txt">Загружаем «${this.esc(doc.title)}»…</div><div class="docs-loading-sub">Забираем документ с сервера.</div></div>`
      : '<div class="docs-editor-host" id="docs-editor-host" style="flex:1;display:flex;flex-direction:column;min-height:0"></div>';
    return `<div class="docs-editor-wrap">${body}</div>`;
  }

  private renderEditorActions(doc: DocItem): string {
    const exportMenu = doc.type === 'word'
      ? `<option value="docx">Word (.docx)</option><option value="pdf">PDF / печать</option><option value="html">HTML</option><option value="txt">Текст (.txt)</option>`
      : `<option value="xlsx">Excel (.xlsx)</option><option value="csv">CSV (текущий лист)</option><option value="pdf">PDF / печать (текущий лист)</option>`;
    const me = this.me();
    const isOwner = !doc.owner_id || doc.owner_id === me;
    const priv = doc.visibility === 'private';
    const access = `<button class="docs-access${priv ? ' private' : ''}" id="docs-access-btn" title="${isOwner ? 'Кто видит документ — нажмите, чтобы изменить' : 'Доступ меняет владелец документа'}"${isOwner ? '' : ' disabled'}>${priv ? '🔒 Только я' : '👥 Все в кабинете'}</button>`;
    return `<div class="docs-editor-actions">
          <span class="docs-saved" data-save-state>${this.saveStateHtml()}</span>
          ${access}
          <select class="docs-export-sel" id="docs-export-sel" aria-label="Скачать документ"><option value="">Скачать</option>${exportMenu}</select>
          <button class="docs-fs-expand-btn" id="docs-fs-btn" title="Полный экран">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M21 16v3a2 2 0 01-2 2h-3M3 16v3a2 2 0 002 2h3"/></svg>
          </button>
        </div>`;
  }

  // ── Привязка оболочки ─────────────────────────────────────────────────

  private bindTopbar(): void {
    const fileMenu = this.root.querySelector<HTMLDetailsElement>('.docs-file-menu');
    this.root.onclick = e => {
      if (fileMenu && !fileMenu.contains(e.target as Node)) fileMenu.open = false;
    };
    fileMenu?.addEventListener('keydown', e => {
      if (e.key === 'Escape') { fileMenu.open = false; fileMenu.querySelector('summary')?.focus(); }
    });
    this.root.querySelector('#docs-new-word')?.addEventListener('click', () => this.createDoc('word'));
    this.root.querySelector('#docs-new-excel')?.addEventListener('click', () => this.createDoc('excel'));
    const fileInp = this.root.querySelector<HTMLInputElement>('#docs-file-input');
    this.root.querySelector('#docs-open-file')?.addEventListener('click', () => fileInp?.click());
    fileInp?.addEventListener('change', async () => { const f = fileInp.files?.[0]; if (f) await this.importFile(f); fileInp.value = ''; });
    this.root.querySelector('#docs-fs-back')?.addEventListener('click', () => {
      this.isFullscreen = false;
      this.root.querySelector('.docs-shell')?.classList.remove('docs-fullscreen');
    });
    this.root.querySelector('#docs-fs-sima')?.addEventListener('click', (e) => { e.stopPropagation(); (window as any).sdAssistantModule?.openPanel(); });

    // Перетащить файл в окно — открыть
    const shell = this.root.querySelector<HTMLElement>('.docs-shell');
    shell?.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); } });
    shell?.addEventListener('drop', e => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      // Картинки, брошенные в документ, обрабатывает сам редактор
      if (f.type.startsWith('image/') && this.activeDoc()) return;
      e.preventDefault();
      this.importFile(f);
    });

    const recentWrap = this.root.querySelector<HTMLElement>('#docs-recent-wrap');
    this.root.querySelector('#docs-recent-toggle')?.addEventListener('click', (e) => {
      e.stopPropagation();
      recentWrap?.classList.toggle('open');
    });
    if (recentWrap) {
      const closeOnOutside = (e: Event) => {
        const wrap = this.root.querySelector('#docs-recent-wrap');
        if (!wrap) { document.removeEventListener('click', closeOnOutside); return; }
        if (!wrap.contains(e.target as Node)) { wrap.classList.remove('open'); document.removeEventListener('click', closeOnOutside); }
      };
      document.addEventListener('click', closeOnOutside);
    }
    this.root.querySelector('#docs-browse-all')?.addEventListener('click', () => {
      this.flushSave();
      this.activeId = null;
      this.render();
      this.loadAllDocs();
    });

    // Строки «Недавних» и «Всех документов» — делегирование
    const onRowClick = (e: Event) => {
      const deleteButton = (e.target as HTMLElement).closest<HTMLElement>('[data-delete-doc]');
      if (deleteButton) { e.preventDefault(); e.stopPropagation(); void this.deleteDoc(deleteButton.dataset.deleteDoc!); return; }
      const del = (e.target as HTMLElement).closest<HTMLElement>('.docs-recent-del');
      if (del) { e.stopPropagation(); this.removeRecent(del.dataset.delRecent!); return; }
      const row = (e.target as HTMLElement).closest<HTMLElement>('.docs-recent-row');
      if (!row) return;
      e.stopPropagation();
      recentWrap?.classList.remove('open');
      this.openDoc(row.dataset.recentId!, { title: row.dataset.recentTitle, type: row.dataset.recentType as DocType });
    };
    this.root.querySelectorAll<HTMLElement>('#docs-recent-wrap, .docs-recent, .docs-browser').forEach(el => el.addEventListener('click', onRowClick));
    this.root.querySelectorAll<HTMLElement>('[data-browse]').forEach(b => b.addEventListener('click', () => { this.browseTab = b.dataset.browse as typeof this.browseTab; this.render(); }));
    const q = this.root.querySelector<HTMLInputElement>('#docs-browse-q');
    q?.addEventListener('input', () => {
      this.browseQuery = q.value;
      const pos = q.selectionStart;
      this.render();
      const nq = this.root.querySelector<HTMLInputElement>('#docs-browse-q');
      nq?.focus(); if (pos !== null) nq?.setSelectionRange(pos, pos);
    });
    if (!this.activeId && this.allDocs === null) this.loadAllDocs();

    this.root.querySelectorAll<HTMLElement>('.docs-tab').forEach(el => {
      const id = el.dataset.id!;
      el.addEventListener('click', e => {
        if ((e.target as HTMLElement).dataset.close) return;
        if (id === this.activeId) return;
        this.openDoc(id);
      });
      el.addEventListener('auxclick', e => { if (e.button === 1) { e.preventDefault(); this.closeDoc(id); } });
    });
    this.root.querySelectorAll<HTMLElement>('.docs-tab-close').forEach(el => {
      el.addEventListener('click', e => { e.stopPropagation(); this.closeDoc(el.dataset.close!); });
    });
  }

  /** Смонтировать редактор после отрисовки оболочки (только для show()). */
  private deferMount = false;
  private mountTimer = 0;

  private bindEditor(doc: DocItem): void {
    const titleInp = this.root.querySelector<HTMLInputElement>('#docs-title-inp');
    titleInp?.addEventListener('input', () => this.renameDoc(doc.id, titleInp.value));
    titleInp?.addEventListener('change', () => this.render());
    this.root.querySelector('#docs-delete-btn')?.addEventListener('click', () => this.deleteDoc(doc.id));
    this.root.querySelector('#docs-access-btn')?.addEventListener('click', () => this.setVisibility(doc, doc.visibility === 'private' ? 'company' : 'private'));
    const exportSel = this.root.querySelector<HTMLSelectElement>('#docs-export-sel');
    exportSel?.addEventListener('change', () => { if (exportSel.value) { this.exportDoc(doc, exportSel.value); exportSel.value = ''; } });
    this.root.querySelector('#docs-fs-btn')?.addEventListener('click', () => {
      this.isFullscreen = !this.isFullscreen;
      this.root.querySelector('.docs-shell')?.classList.toggle('docs-fullscreen', this.isFullscreen);
      aiPage.register(this.getAiCapability());
    });
    this.root.querySelector('#docs-retry-content')?.addEventListener('click', () => {
      (this.contentLoadError ??= new Set<string>()).delete(doc.id);
      this.render();
      void this.syncFromDb();
    });
    if (this.pendingContent.has(doc.id) || (this.contentLoadError ??= new Set<string>()).has(doc.id)) return;
    const host = this.root.querySelector<HTMLElement>('#docs-editor-host');
    if (!host) return;
    const mount = () => {
      if (!host.isConnected || this.activeId !== doc.id) return;
      perfTime(`редактор: открытие «${doc.title}» (${Math.round(doc.content.length / 1024)} КБ)`, () => {
        if (doc.type === 'word') this.mountWord(doc, host);
        else this.mountSheet(doc, host);
      });
    };
    if (this.deferMount) {
      this.deferMount = false;
      host.innerHTML = '<div class="docs-loading"><div class="docs-loading-spin"></div><div class="docs-loading-txt">Открываем документ…</div></div>';
      clearTimeout(this.mountTimer);
      // Таймер, а не кадр анимации: в фоновой вкладке кадры не идут, и документ
      // оставался бы на заглушке. 30 мс хватает, чтобы браузер показал раздел.
      this.mountTimer = window.setTimeout(() => { host.innerHTML = ''; mount(); }, 30);
      return;
    }
    mount();
  }

  private mountSheet(doc: DocItem, el: HTMLElement): void {
    const book = this.getBook(doc);
    if (this.activeSheetIdx >= book.sheets.length) this.activeSheetIdx = 0;
    if (book.sheets[this.activeSheetIdx]?.hidden) this.activeSheetIdx = Math.max(0, book.sheets.findIndex(s => !s.hidden));
    const host: SheetHost = {
      docId: () => doc.id,
      docTitle: () => doc.title,
      book: () => this.getBook(doc),
      sheetIdx: () => this.activeSheetIdx,
      setSheetIdx: (i) => { this.activeSheetIdx = i; },
      beginChange: () => this.pushXlUndo(doc.id, this.activeSheetIdx),
      commit: () => this.commitBook(doc, this.getBook(doc)),
      undo: () => this.xlUndo(),
      redo: () => this.xlRedo(),
      canUndo: () => this.xlUndoStack.some(s => s.docId === doc.id),
      canRedo: () => this.xlRedoStack.some(s => s.docId === doc.id),
      evaluator: (si) => this.bookEvaluator(this.getBook(doc), si),
      publishSelection: (si, rg, label, prompt) => {
        this.xlLastSel = { ...rg, docId: doc.id, sheetIdx: si };
        this.xlSelMemo[`${doc.id}:${si}`] = rg;
        selectionCtx.set({ type: 'excel-cells', label, prompt, data: { docId: doc.id, sheetIdx: si, range: rg } });
      },
      prepareImage: (src, maxW) => prepareImage(src, 1600, maxW),
      fileToDataUrl: (f) => fileToDataUrl(f),
      toast: (msg, kind) => showToast(msg, kind ?? 'info'),
    };
    this.sheetEditor = new SheetEditor(host, el, { selection: this.xlSelMemo[`${doc.id}:${this.activeSheetIdx}`] });
  }

  private mountWord(doc: DocItem, el: HTMLElement): void {
    const host: WordHost = {
      docId: () => doc.id,
      title: () => doc.title,
      html: () => doc.content,
      setHtml: (html) => { if (html !== doc.content) this.updateContent(doc.id, html); },
      meta: () => doc.meta ?? {},
      setMeta: (m) => { doc.meta = m; doc.updated_at = Date.now(); this.dirty.add(doc.id); this.scheduleSave(); },
      toast: (msg, kind) => showToast(msg, kind ?? 'info'),
      prepareImage: (src, maxW, maxDisplay) => prepareImage(src, maxW, maxDisplay),
      fileToDataUrl: (f) => fileToDataUrl(f),
    };
    this.wordEditor = new WordEditor(host, el);
  }

  private colLetter(n: number): string { return colLetterFn(n); }
  private letterToCol(l: string): number { return letterToColFn(l); }

  // ── AI: возможности страницы для ассистента ─────────────────────────────────

  /** Активный документ или null. */
  private aiDoc(): DocItem | null {
    return this.docs.find(d => d.id === this.activeId) ?? null;
  }

  /** Активный лист Excel (или null для Word/пустого). */
  private aiSheet(): { ec: ExcelContent; sheet: SheetData; doc: DocItem } | null {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') return null;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    return sheet ? { ec, sheet, doc } : null;
  }

  /** Индексы колонок, похожих на артикулы/коды (по заголовкам в строке 1). */
  private aiArticleCols(sheet: SheetData): number[] {
    const kw = ['артикул', 'sku', 'offer', 'vendor', 'код', 'штрихкод', 'barcode', 'nm_id', 'nmid'];
    const header = sheet.data[0] ?? [];
    const out: number[] = [];
    header.forEach((c, i) => {
      const h = (c.v || '').toLowerCase();
      if (kw.some(k => h.includes(k))) out.push(i);
    });
    return out;
  }

  /** Разрешить ссылку на колонку: буква ("B") или имя заголовка ("Артикул"). → индекс или -1. */
  private aiResolveCol(sheet: SheetData, ref: string): number {
    const r = String(ref).trim();
    if (/^[A-Za-z]+$/.test(r)) {
      const idx = this.letterToCol(r);
      if (idx >= 0 && idx < (sheet.data[0]?.length ?? 0)) return idx;
    }
    const header = sheet.data[0] ?? [];
    const low = r.toLowerCase();
    const exact = header.findIndex(c => (c.v || '').trim().toLowerCase() === low);
    if (exact >= 0) return exact;
    return header.findIndex(c => (c.v || '').trim().toLowerCase().includes(low));
  }

  private aiPersist(doc: DocItem, ec: ExcelContent): void {
    this.updateContent(doc.id, this.serializeExcel(ec));
    this.render();
  }

  // ── Чтение данных для ассистента ───────────────────────────────────────────
  // describe() показывает лишь первые 30 строк — на таблице в тысячи строк
  // модель физически не видит данные и начинает выдумывать. Эти действия
  // дают ей запрашивать нужный срез самостоятельно.

  /** Отображаемое значение ячейки: формулы посчитаны, форматы применены. */
  private aiCellText(sheet: SheetData, r: number, c: number): string {
    const cell = sheet.data[r]?.[c];
    if (!cell) return '';
    const v = cell.v ?? '';
    if (v.startsWith('=')) return this.evalFormula(v, sheet.data);
    return formatCellValue(v, cell.t, cell.nf);
  }

  /** Числовое значение ячейки или null, если это не число. */
  private aiCellNum(sheet: SheetData, r: number, c: number): number | null {
    const cell = sheet.data[r]?.[c];
    if (!cell) return null;
    const raw = cell.v?.startsWith('=')
      ? this.evalFormula(cell.v, sheet.data)
      : (cell.v ?? '');
    if (raw.trim() === '') return null;
    const n = parseUserNumber(raw);
    return n ?? null;
  }

  /** Лист по имени, иначе активный. */
  private aiSheetNamed(name?: string): { ec: ExcelContent; sheet: SheetData; doc: DocItem } {
    const s = this.aiSheet();
    if (!s) throw new Error('Нет открытой таблицы');
    if (!name) return s;
    const found = s.ec.sheets.find(sh => sh.name.toLowerCase() === name.trim().toLowerCase());
    if (!found) throw new Error(`Лист «${name}» не найден. Есть: ${s.ec.sheets.map(x => x.name).join(', ')}`);
    return { ...s, sheet: found };
  }

  /** Индексы строк с данными (без шапки, без полностью пустых). */
  private aiDataRows(sheet: SheetData): number[] {
    const out: number[] = [];
    for (let r = 1; r < sheet.data.length; r++) {
      if (sheet.data[r].some(c => (c.v || '').trim())) out.push(r);
    }
    return out;
  }

  /**
   * Условия отбора: { "Город": "Мадрид", "Цена": ">100" }.
   * Синтаксис критериев тот же, что в СУММЕСЛИ — включая > < <> и маски *?.
   */
  private aiBuildFilter(sheet: SheetData, where?: Record<string, string>): (r: number) => boolean {
    if (!where || !Object.keys(where).length) return () => true;
    const tests: Array<{ c: number; pred: (v: string) => boolean }> = [];
    for (const [key, crit] of Object.entries(where)) {
      const c = this.aiResolveCol(sheet, key);
      if (c < 0) throw new Error(`Колонка «${key}» не найдена`);
      tests.push({ c, pred: this.aiCriteria(String(crit)) });
    }
    return (r: number) => tests.every(t => t.pred(this.aiCellText(sheet, r, t.c)));
  }

  /** «>100», «<>абв», «Мадрид», «А*» → предикат по тексту ячейки. */
  private aiCriteria(crit: string): (v: string) => boolean {
    const raw = crit.trim();
    const m = raw.match(/^(<=|>=|<>|=|<|>)(.*)$/);
    if (m) {
      const op = m[1], operand = m[2].trim();
      const on = parseUserNumber(operand);
      return (v: string) => {
        if (on !== null) {
          const vn = parseUserNumber(v);
          if (vn === null) return op === '<>';
          switch (op) {
            case '>': return vn > on;  case '>=': return vn >= on;
            case '<': return vn < on;  case '<=': return vn <= on;
            case '<>': return vn !== on; default: return vn === on;
          }
        }
        const a = v.trim().toLowerCase(), b = operand.toLowerCase();
        switch (op) {
          case '<>': return a !== b;
          case '>': return a > b;  case '>=': return a >= b;
          case '<': return a < b;  case '<=': return a <= b;
          default: return a === b;
        }
      };
    }
    if (/[*?]/.test(raw)) {
      const rx = new RegExp('^' + raw.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      return (v: string) => rx.test(v.trim());
    }
    return (v: string) => v.trim().toLowerCase() === raw.toLowerCase();
  }

  /** Прочитать прямоугольный диапазон как текст. */
  private aiExcelReadRange(a: { range: string; sheet?: string }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const m = String(a?.range ?? '').trim().toUpperCase()
      .match(/^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/);
    if (!m) throw new Error('Диапазон нужен в виде A1:D20');
    const c1 = this.letterToCol(m[1]), r1 = +m[2] - 1;
    const c2 = m[3] ? this.letterToCol(m[3]) : c1;
    const r2 = m[4] ? +m[4] - 1 : r1;

    const maxRows = 500;
    const rows: string[] = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2) && rows.length < maxRows; r++) {
      const cells: string[] = [];
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        cells.push(`${this.colLetter(c)}${r + 1}=${this.aiCellText(sheet, r, c) || '—'}`);
      }
      rows.push('  ' + cells.join(' | '));
    }
    const total = Math.abs(r2 - r1) + 1;
    return `Лист «${sheet.name}», диапазон ${a.range} (${total} строк):\n${rows.join('\n')}`
      + (total > maxRows ? `\n  …показаны первые ${maxRows}` : '');
  }

  /** Отобрать строки по условиям и вернуть нужные колонки. */
  private aiExcelQuery(a: {
    where?: Record<string, string>; columns?: string[];
    limit?: number; sheet?: string; sortBy?: string; desc?: boolean;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const header = sheet.data[0] ?? [];
    const filter = this.aiBuildFilter(sheet, a?.where);

    const cols = a?.columns?.length
      ? a.columns.map(ref => {
          const c = this.aiResolveCol(sheet, ref);
          if (c < 0) throw new Error(`Колонка «${ref}» не найдена`);
          return c;
        })
      : header.map((_, i) => i);

    let hits = this.aiDataRows(sheet).filter(filter);

    if (a?.sortBy) {
      const sc = this.aiResolveCol(sheet, a.sortBy);
      if (sc < 0) throw new Error(`Колонка сортировки «${a.sortBy}» не найдена`);
      const dir = a.desc ? -1 : 1;
      hits.sort((x, y) => {
        const xn = this.aiCellNum(sheet, x, sc), yn = this.aiCellNum(sheet, y, sc);
        if (xn !== null && yn !== null) return (xn - yn) * dir;
        return this.aiCellText(sheet, x, sc).localeCompare(this.aiCellText(sheet, y, sc), 'ru') * dir;
      });
    }

    const total = hits.length;
    const limit = Math.min(a?.limit ?? 50, 200);
    hits = hits.slice(0, limit);

    const head = cols.map(c => `${this.colLetter(c)}«${(header[c]?.v || '').trim()}»`).join(' | ');
    const lines = hits.map(r =>
      `  стр.${r + 1}: ` + cols.map(c => this.aiCellText(sheet, r, c) || '—').join(' | '));

    return `Лист «${sheet.name}»: найдено ${total} строк${total > limit ? `, показаны первые ${limit}` : ''}.\n`
      + `Колонки: ${head}\n${lines.join('\n') || '  (совпадений нет)'}`;
  }

  /** Агрегаты, при необходимости с группировкой. */
  private aiExcelAggregate(a: {
    op: string; column?: string; groupBy?: string;
    where?: Record<string, string>; sheet?: string; limit?: number;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const op = String(a?.op ?? 'sum').toLowerCase();
    const OPS = ['sum', 'avg', 'average', 'count', 'min', 'max', 'countdistinct'];
    if (!OPS.includes(op)) throw new Error(`Операция «${a?.op}» неизвестна. Доступны: ${OPS.join(', ')}`);

    const needsValue = op !== 'count' && op !== 'countdistinct';
    let vc = -1;
    if (a?.column) {
      vc = this.aiResolveCol(sheet, a.column);
      if (vc < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    } else if (needsValue) {
      throw new Error(`Для «${op}» нужна колонка со значениями (column)`);
    }

    const filter = this.aiBuildFilter(sheet, a?.where);
    const rows = this.aiDataRows(sheet).filter(filter);

    const compute = (list: number[], texts: string[]): string => {
      switch (op) {
        case 'sum': return this.aiNum(list.reduce((s, v) => s + v, 0));
        case 'avg': case 'average':
          return list.length ? this.aiNum(list.reduce((s, v) => s + v, 0) / list.length) : '—';
        case 'min': return list.length ? this.aiNum(Math.min(...list)) : '—';
        case 'max': return list.length ? this.aiNum(Math.max(...list)) : '—';
        case 'countdistinct': return String(new Set(texts.filter(t => t.trim())).size);
        default: return String(texts.length);
      }
    };

    const collect = (rs: number[]) => ({
      nums: vc >= 0 ? rs.map(r => this.aiCellNum(sheet, r, vc)).filter((n): n is number => n !== null) : [],
      texts: rs.map(r => vc >= 0 ? this.aiCellText(sheet, r, vc) : 'x'),
    });

    const filterNote = a?.where ? ` при условии ${JSON.stringify(a.where)}` : '';

    if (!a?.groupBy) {
      const { nums, texts } = collect(rows);
      const label = a?.column ? ` по «${(sheet.data[0]?.[vc]?.v || '').trim()}»` : '';
      return `Лист «${sheet.name}»: ${op.toUpperCase()}${label}${filterNote} = ${compute(nums, texts)} (строк: ${rows.length})`;
    }

    const gc = this.aiResolveCol(sheet, a.groupBy);
    if (gc < 0) throw new Error(`Колонка группировки «${a.groupBy}» не найдена`);

    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const key = this.aiCellText(sheet, r, gc).trim() || '(пусто)';
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
    }

    const limit = Math.min(a?.limit ?? 50, 200);
    const lines = [...groups.entries()]
      .map(([key, rs]) => {
        const { nums, texts } = collect(rs);
        return { key, n: rs.length, val: compute(nums, texts) };
      })
      .sort((x, y) => {
        const xn = parseFloat(x.val), yn = parseFloat(y.val);
        return (!isNaN(xn) && !isNaN(yn)) ? yn - xn : y.n - x.n;
      })
      .slice(0, limit)
      .map(g => `  ${g.key}: ${g.val} (строк: ${g.n})`);

    return `Лист «${sheet.name}»: ${op.toUpperCase()}`
      + (a.column ? ` по «${(sheet.data[0]?.[vc]?.v || '').trim()}»` : '')
      + ` с группировкой по «${a.groupBy}»${filterNote}\n`
      + `Групп: ${groups.size}${groups.size > limit ? `, показаны первые ${limit}` : ''}\n`
      + lines.join('\n');
  }

  /** Округлить до вменяемого вида для показа модели. */
  private aiNum(n: number): string {
    if (!isFinite(n)) return '—';
    const r = Math.round(n * 100) / 100;
    return String(r);
  }

  /** Найти текст в таблице, вернуть адреса. */
  private aiExcelFind(a: {
    query: string; columns?: string[]; exact?: boolean; limit?: number; sheet?: string;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const q = String(a?.query ?? '').trim();
    if (!q) throw new Error('Не указано, что искать');
    const low = q.toLowerCase();

    const header = sheet.data[0] ?? [];
    const cols = a?.columns?.length
      ? a.columns.map(ref => {
          const c = this.aiResolveCol(sheet, ref);
          if (c < 0) throw new Error(`Колонка «${ref}» не найдена`);
          return c;
        })
      : header.map((_, i) => i);

    const limit = Math.min(a?.limit ?? 50, 200);
    const hits: string[] = [];
    let total = 0;

    for (let r = 0; r < sheet.data.length; r++) {
      for (const c of cols) {
        const txt = this.aiCellText(sheet, r, c);
        if (!txt) continue;
        const match = a?.exact ? txt.trim().toLowerCase() === low : txt.toLowerCase().includes(low);
        if (!match) continue;
        total++;
        if (hits.length < limit) {
          hits.push(`  ${this.colLetter(c)}${r + 1} (стр.${r + 1}, «${(header[c]?.v || '').trim()}»): ${txt}`);
        }
      }
    }

    return `Лист «${sheet.name}»: «${q}» встречается ${total} раз${total > limit ? `, показаны первые ${limit}` : ''}.\n`
      + (hits.join('\n') || '  (не найдено)');
  }

  /** Проверки качества данных — дубли, пустоты, нечисловые значения. */
  private aiExcelValidate(a: {
    duplicates?: string[]; required?: string[]; numeric?: string[];
    positive?: string[]; sheet?: string;
  }): string {
    const { sheet } = this.aiSheetNamed(a?.sheet);
    const header = sheet.data[0] ?? [];
    const rows = this.aiDataRows(sheet);
    const out: string[] = [];
    const LIST = 20;

    const resolve = (ref: string) => {
      const c = this.aiResolveCol(sheet, ref);
      if (c < 0) throw new Error(`Колонка «${ref}» не найдена`);
      return c;
    };
    const title = (c: number) => `${this.colLetter(c)}«${(header[c]?.v || '').trim()}»`;

    for (const ref of a?.duplicates ?? []) {
      const c = resolve(ref);
      const seen = new Map<string, number[]>();
      for (const r of rows) {
        const v = this.aiCellText(sheet, r, c).trim().toLowerCase();
        if (!v) continue;
        (seen.get(v) ?? seen.set(v, []).get(v)!).push(r + 1);
      }
      const dups = [...seen.entries()].filter(([, rs]) => rs.length > 1);
      out.push(dups.length
        ? `Дубли в ${title(c)}: ${dups.length} значений повторяются\n`
          + dups.slice(0, LIST).map(([v, rs]) => `    «${v}» — строки ${rs.join(', ')}`).join('\n')
          + (dups.length > LIST ? `\n    …ещё ${dups.length - LIST}` : '')
        : `Дубли в ${title(c)}: не найдено`);
    }

    for (const ref of a?.required ?? []) {
      const c = resolve(ref);
      const empty = rows.filter(r => !this.aiCellText(sheet, r, c).trim());
      out.push(empty.length
        ? `Пустые в ${title(c)}: ${empty.length} строк — ${empty.slice(0, LIST).map(r => r + 1).join(', ')}`
          + (empty.length > LIST ? ` …ещё ${empty.length - LIST}` : '')
        : `Пустые в ${title(c)}: нет`);
    }

    for (const ref of a?.numeric ?? []) {
      const c = resolve(ref);
      const bad = rows.filter(r => {
        const t = this.aiCellText(sheet, r, c).trim();
        return t !== '' && this.aiCellNum(sheet, r, c) === null;
      });
      out.push(bad.length
        ? `Нечисловые в ${title(c)}: ${bad.length} строк — `
          + bad.slice(0, LIST).map(r => `стр.${r + 1}="${this.aiCellText(sheet, r, c)}"`).join(', ')
          + (bad.length > LIST ? ` …ещё ${bad.length - LIST}` : '')
        : `Нечисловые в ${title(c)}: нет`);
    }

    for (const ref of a?.positive ?? []) {
      const c = resolve(ref);
      const bad = rows.filter(r => { const n = this.aiCellNum(sheet, r, c); return n !== null && n <= 0; });
      out.push(bad.length
        ? `Неположительные в ${title(c)}: ${bad.length} строк — `
          + bad.slice(0, LIST).map(r => `стр.${r + 1}=${this.aiCellText(sheet, r, c)}`).join(', ')
          + (bad.length > LIST ? ` …ещё ${bad.length - LIST}` : '')
        : `Неположительные в ${title(c)}: нет`);
    }

    if (!out.length) return 'Не указано, что проверять. Доступно: duplicates, required, numeric, positive.';
    return `Проверка листа «${sheet.name}» (${rows.length} строк данных):\n` + out.join('\n');
  }

  /** Схема листа: заголовки, типы, заполненность — дёшево по токенам. */
  private aiExcelSchema(a?: { sheet?: string }): string {
    const { ec, sheet } = this.aiSheetNamed(a?.sheet);
    const header = sheet.data[0] ?? [];
    const rows = this.aiDataRows(sheet);
    const sample = rows.slice(0, 3);

    const cols = header.map((h, c) => {
      const filled = rows.filter(r => this.aiCellText(sheet, r, c).trim()).length;
      const numeric = rows.filter(r => this.aiCellNum(sheet, r, c) !== null).length;
      const uniq = new Set(rows.map(r => this.aiCellText(sheet, r, c).trim()).filter(Boolean)).size;
      const kind = numeric > filled * 0.8 ? 'число' : uniq <= Math.max(20, rows.length * 0.05) ? 'категория' : 'текст';
      const ex = sample.map(r => this.aiCellText(sheet, r, c)).filter(Boolean).slice(0, 2);
      return `  ${this.colLetter(c)} «${(h.v || '').trim() || '(без имени)'}» — ${kind}, `
        + `заполнено ${filled}/${rows.length}, уникальных ${uniq}`
        + (ex.length ? `, напр.: ${ex.map(e => `«${e}»`).join(', ')}` : '');
    });

    return `Лист «${sheet.name}» (из ${ec.sheets.length}): ${rows.length} строк данных × ${header.length} колонок.\n`
      + `Колонки:\n${cols.join('\n')}\n`
      + `Для выборки строк — excel_query, для итогов — excel_aggregate, для поиска — excel_find.`;
  }

  /** describe() — текущее состояние открытого документа для модели. */
  private aiDescribe(): string {
    const fsFocus = this.isFullscreen
      ? '[РЕЖИМ: Полный экран редактора. Пользователь работает с документом. Фокусируйся только на нём — давай советы, подсказки и действия именно по этому файлу. Ты можешь отвечать на вопросы об API (остатки, заказы, аналитика WB/Ozon) если пользователь явно спросит, но сам не переключайся на другие разделы.]\n\n'
      : '';

    // Обзор намеренно краткий. Раньше сюда сваливались 30 строк данных и
    // частотный анализ всех колонок — тысячи токенов на каждый вызов, а
    // ответить по таблице в 5000 строк всё равно было нельзя. Теперь модель
    // получает карту документов и берёт данные через excel_query/aggregate.
    const docList = this.docs.length
      ? `\n\n📂 Документы (${this.docs.length}):\n` + this.docs.map((d, i) => {
          const active = d.id === this.activeId ? ' ← АКТИВНЫЙ' : '';
          let extra = '';
          if (d.type === 'excel') {
            try {
              const ec = this.parseExcelContent(d.content);
              extra = ' — листы: ' + ec.sheets.map(sh => {
                const rows = sh.data.filter(r => r.some(c => (c.v || '').trim())).length;
                return `«${sh.name}» (${Math.max(0, rows - 1)}×${sh.data[0]?.length ?? 0})`;
              }).join(', ');
            } catch { /* повреждённое содержимое не должно ронять обзор */ }
          } else {
            const len = d.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
            extra = ` — ~${len} симв.`;
          }
          return `  ${i + 1}. id="${d.id}" «${d.title}» [${d.type}]${active}${extra}`;
        }).join('\n')
      : '';

    // Модель по умолчанию считает, что «в Excel картинку вставить нельзя», и
    // отказывает пользователю. Говорим прямо, что умеем, и перечисляем ссылки
    // на уже присланные вложения.
    const pics = imageAttachments.list();
    const imgHint = `\n🖼 Картинки: редактор умеет вставлять изображения — excel_insert_image (в ячейку) `
      + `и word_insert_image (в текст), переносить — excel_move_image (перенос, а не копия) `
      + `и удалять — excel_remove_image / word_remove_image. `
      + (pics.length
          ? `Присланные в этом разговоре: ${pics.map(p => `${p.id} («${p.name}»)`).join(', ')}.`
          : 'Пользователь пока ничего не прикреплял — попроси приложить файл к сообщению.');

    const doc = this.aiDoc();
    if (!doc) return fsFocus + 'Нет открытого документа. Пользователь может создать Word или Excel.' + imgHint + docList;

    if (doc.type === 'word') {
      const text = doc.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
      const headings = [...doc.content.matchAll(/<(h[1-6])[^>]*>(.*?)<\/h[1-6]>/gi)]
        .map(m => `  ${m[1].toUpperCase()}: ${m[2].replace(/<[^>]+>/g, '').trim()}`)
        .slice(0, 12).join('\n');
      return fsFocus + `Открыт Word-документ «${doc.title}»: ${words} слов, ${text.length} символов.`
        + (headings ? `\nЗаголовки:\n${headings}` : '')
        + `\nНачало: "${text.slice(0, 600)}"${text.length > 600 ? '…' : ''}`
        + `\nДля структуры вызови word_outline, для точечной правки — word_edit_paragraph.`
        + imgHint
        + docList;
    }

    const s = this.aiSheet();
    if (!s) return fsFocus + `Открыт документ «${doc.title}», но лист пуст.` + imgHint + docList;
    const { ec, sheet } = s;
    const artCols = this.aiArticleCols(sheet);

    let schema: string;
    try {
      schema = this.aiExcelSchema();
    } catch {
      schema = `Лист «${sheet.name}»: ${sheet.data.length} строк.`;
    }

    const sheetsInfo = ec.sheets.length > 1
      ? `\nВсе листы: ${ec.sheets.map(sh => `«${sh.name}»`).join(', ')} (активный — «${sheet.name}»)`
      : '';
    const styled = sheet.data.some(r => r.some(c => c.s));

    return fsFocus + `Открыта таблица «${doc.title}».\n${schema}${sheetsInfo}\n`
      + `Колонки-артикулы (по умолчанию НЕ трогать при заменах): `
      + `${artCols.length ? artCols.map(i => this.colLetter(i)).join(', ') : 'не обнаружены'}\n`
      + `Оформление: ${styled ? 'в ячейках есть стили' : 'без оформления'}\n`
      + `ВАЖНО: конкретных значений здесь нет. Чтобы ответить по данным — вызови `
      + `excel_query (отбор строк), excel_aggregate (суммы, средние, группировки), `
      + `excel_find (поиск) или excel_read_range. Не выдумывай цифры и не считай по памяти.`
      + `\nФормулы в ячейках можно писать по-русски (=СУММ, =ЕСЛИ, =СЧЁТЕСЛИ, =ВПР) и со ссылками на другие листы ('Имя листа'!A1:A50, Лист2!C:C). `
      + `Для отчёта на новом листе — excel_create_report, для графика — excel_add_chart, для перехода между листами — excel_switch_sheet.`
      + imgHint
      + docList;
  }

  /** Публичная точка: капабилити текущей страницы редактора для ассистента. */
  getAiCapability(): AiPageCapability {
    const isWord = this.aiDoc()?.type === 'word';
    const fsSuggestions = isWord ? [
      { label: '📋 Структура', prompt: 'Покажи структуру документа: какие в нём абзацы и заголовки' },
      { label: '✍️ Дополни текст', prompt: 'Предложи продолжение для этого текста и допиши его в конец' },
      { label: '📊 Статистика', prompt: 'Посчитай слова и символы в документе' },
      { label: '🔁 Замена текста', prompt: 'Помоги заменить текст в документе' },
    ] : [
      { label: '🔎 Что в документе?', prompt: 'Проанализируй открытый документ: что за данные, структура, ключевые значения' },
      { label: '📊 Сводка по данным', prompt: 'Посчитай итоги по открытой таблице: суммы и средние по числовым колонкам, разбивка по основной категории' },
      { label: '🧹 Проверить данные', prompt: 'Проверь таблицу на ошибки: дубли артикулов, пустые обязательные поля, нечисловые значения в числовых колонках' },
      { label: '✨ Улучшить дизайн', prompt: 'Улучши оформление текущей таблицы' },
      { label: '📈 Отчёт на новом листе', prompt: 'Посчитай итоги по таблице (количество строк, суммы по денежным колонкам) с разбивкой по главной категории и вынеси отчёт с диаграммой на новый лист' },
    ];
    const normalSuggestions = isWord ? [
      { label: '➕ Новый Word', prompt: 'Создай новый Word-документ' },
      { label: '📊 Статистика', prompt: 'Посчитай слова и символы в открытом документе' },
      { label: '🔎 Анализ текста', prompt: 'Проанализируй содержимое документа: о чём он, основные темы' },
      { label: '🔁 Замена', prompt: 'Помоги заменить текст в документе' },
    ] : [
      { label: '➕ Новый Excel', prompt: 'Создай новый документ Excel' },
      { label: '🔎 Что в таблице?', prompt: 'Проанализируй открытую таблицу: что за данные, какие колонки' },
      { label: '📊 Посчитать итоги', prompt: 'Посчитай итоги по открытой таблице с разбивкой по основной категории' },
      { label: '🧹 Проверить данные', prompt: 'Проверь таблицу на дубли и пропуски' },
    ];
    return {
      page: 'docs',
      title: this.isFullscreen ? `Редактор (${this.aiDoc()?.title ?? 'документ'})` : 'Редактор',
      describe: () => this.aiDescribe(),
      suggestions: this.isFullscreen ? fsSuggestions : normalSuggestions,
      actions: [
        {
          name: 'excel_replace',
          description: 'Заменить текст в ячейках таблицы. По умолчанию колонки-артикулы пропускаются. exceptColumns — доп. колонки (буквы или имена заголовков), которые не трогать.',
          args: '{ find: string, replaceWith: string, exceptColumns?: string[], caseSensitive?: boolean }',
          run: (a) => this.aiExcelReplace(a),
        },
        {
          name: 'excel_set_cell',
          description: 'Записать значение в ячейку. Числа передавай числом (1500, а не "1500 руб"), формулы — строкой с «=» (можно русские имена: =СУММ(B2:B10), и ссылки на другие листы: =\'Продажи\'!B2). sheet — лист по имени (по умолчанию активный).',
          args: '{ cell: "B3", value: string|number, sheet?: string }',
          run: (a) => this.aiExcelSetCell(a),
        },
        {
          name: 'excel_style_column',
          description: 'Оформить всю колонку (буква или имя заголовка): жирный, курсив, фон, цвет текста, выравнивание.',
          args: '{ column: "A"|"Название", bold?: boolean, italic?: boolean, bg?: "#hex", color?: "#hex", align?: "left"|"center"|"right" }',
          run: (a) => this.aiExcelStyleColumn(a),
        },
        {
          name: 'excel_improve_design',
          description: 'Автоматически улучшить оформление таблицы: выделить строку-заголовок, добавить чередование строк и аккуратные цвета. Используй когда просят «улучши дизайн».',
          args: '{ accent?: "#hex" }',
          run: (a) => this.aiExcelImproveDesign(a),
        },
        {
          name: 'word_replace',
          description: 'Заменить текст в открытом Word-документе. Используй когда пользователь просит «замени», «поменяй», «исправь» текст в документе.',
          args: '{ find: string, replaceWith: string, caseSensitive?: boolean }',
          run: (a) => this.aiWordReplace(a),
        },
        {
          name: 'word_count',
          description: 'Подсчитать статистику Word-документа: количество слов, символов, абзацев. Используй когда спрашивают «сколько слов», «статистика документа», «размер текста».',
          args: '{}',
          run: () => this.aiWordCount(),
        },
        {
          name: 'word_set_content',
          description: 'Установить или дополнить содержимое Word-документа. html — готовый HTML-текст. text — обычный текст (будет преобразован в HTML). append — если true, добавить в конец, не заменяя. Используй когда просят «напиши», «заполни», «добавь текст», «вставь содержимое».',
          args: '{ html?: string, text?: string, append?: boolean }',
          run: (a) => this.aiWordSetContent(a),
        },
        {
          name: 'word_clear_formatting',
          description: 'Убрать всё форматирование из Word-документа: стили, цвета, жирность, курсив. Структурные теги (абзацы, заголовки) сохраняются. Используй когда просят «убери форматирование», «сними стили», «сделай обычный текст».',
          args: '{}',
          run: () => this.aiWordClearFormatting(),
        },
        {
          name: 'word_heading',
          description: 'Применить стиль заголовка к абзацу документа. text — текст абзаца, который нужно сделать заголовком (если не указан — первый абзац). level — уровень заголовка 1–6. Используй когда просят «сделай заголовком», «оформи как H1/H2».',
          args: '{ text?: string, level?: number }',
          run: (a) => this.aiWordHeading(a),
        },
        {
          name: 'excel_insert_column',
          description: 'Вставить новую пустую колонку в таблицу. after — буква или имя заголовка колонки, ПОСЛЕ которой вставить (напр. "D"). before — буква или имя, ПЕРЕД которой вставить. header — текст заголовка новой колонки (первая строка). Используй когда просят «добавь колонку», «вставь столбец», «создай новый ряд».',
          args: '{ after?: "D"|"Название", before?: "E"|"Цена", header?: string }',
          run: (a) => this.aiExcelInsertColumn(a),
        },
        {
          name: 'excel_add_to_column',
          description: 'Прибавить (или вычесть) число ко всем числовым ячейкам в указанной колонке. Используй когда просят «добавить X рублей к ценам», «увеличить цены на X%», «уменьшить стоимость на Y». delta — число (отрицательное для вычитания). percent — true если delta в процентах (напр. 10 = +10%). rows — конкретные строки (1-based) или "all" (по умолчанию). skipHeader — пропускать первую строку-заголовок (по умолчанию true). round — округление до N знаков после запятой (по умолчанию 2).',
          args: '{ column: "D"|"Цена", delta: number, percent?: boolean, rows?: number[]|"all", skipHeader?: boolean, round?: number }',
          run: (a) => this.aiExcelAddToColumn(a),
        },
        {
          name: 'excel_clear_cells',
          description: `Очистить ТОЛЬКО ячейки, чьи значения соответствуют заданному критерию.
ВАЖНО: НИКОГДА не очищай весь столбец целиком без value_filter — это сотрёт описания и другие данные!
Параметры: column — буква или имя заголовка (обязательно), value_filter — строка-регулярное выражение, которому должно соответствовать содержимое ячейки (по умолчанию "." = всё). Для артикулов используй фильтр типа "^[A-Za-z0-9\\\\-_/]+$" (короткие коды без пробелов). rows — конкретные номера строк (1-based), "all" = все строки с данными. cells — отдельные ячейки. preview_only = true — только показывает что будет очищено, не трогая данные.`,
          args: '{ column?: "B"|"Артикул", rows?: number[]|"all", cells?: string[], value_filter?: string, preview_only?: boolean }',
          run: (a) => this.aiExcelClearCells(a),
        },
        {
          name: 'multi_replace',
          description: 'Заменить текст сразу в нескольких документах. docIds — массив id документов (из describe()) или "all" для всех открытых. find — что искать. replaceWith — на что заменять. Использовать когда пользователь говорит «во всех файлах», «в 1 и 2 файле», «во всех таблицах».',
          args: '{ docIds: string[]|"all", find: string, replaceWith: string, caseSensitive?: boolean }',
          run: (a) => this.aiMultiReplace(a),
        },
        {
          name: 'multi_count',
          description: 'Подсчитать количество вхождений текста во всех или выбранных документах. Возвращает результат по каждому документу. Использовать когда спрашивают «сколько раз встречается», «посчитай во всех файлах».',
          args: '{ docIds: string[]|"all", find: string, caseSensitive?: boolean }',
          run: (a) => this.aiMultiCount(a),
        },
        {
          name: 'excel_style_range',
          description: 'Применить форматирование к ЯВНО НАЗВАННОМУ диапазону. Только когда пользователь сам назвал диапазон словами: «весь лист», «колонку A», «строки 1-5», «A1:D10». Если он говорит «эту ячейку», «вот эту», «выделенные», «их» — использовать excel_style_selection, а НЕ этот инструмент. range обязателен: "all" для всего листа, "A1:Z100" для диапазона, "B7" для одной ячейки. Без range инструмент вернёт ошибку — не подставлять "all" наугад.',
          args: '{ range: "all"|"A1:Z100", sheet?: string, bold?: boolean, italic?: boolean, underline?: boolean, strikethrough?: boolean, color?: "#hex", bg?: "#hex", align?: "left"|"center"|"right", valign?: "top"|"middle"|"bottom", wrap?: boolean, fontSize?: number, fontName?: string, numFormat?: "#,##0.00"|"#,##0.00\\ ₽"|"0%"|"dd.mm.yyyy"|"General", border?: "all"|"outer"|"thick"|"bottom"|"none", merge?: boolean }',
          run: (a) => this.aiStyleRange(a),
        },
        {
          name: 'excel_style_selection',
          description: 'Применить форматирование к выделенным ячейкам. Использовать когда пользователь говорит «эти ячейки», «выделенные», «сделай их красными/жирными» и т.п. — то есть ссылается на текущий выбор. Не требует указания диапазона — берёт из контекста выделения.',
          args: '{ bold?: boolean, italic?: boolean, underline?: boolean, strikethrough?: boolean, color?: "#hex", bg?: "#hex", align?: "left"|"center"|"right" }',
          run: (a) => this.aiStyleSelection(a),
        },
        {
          name: 'excel_clear_selection',
          description: 'Очистить содержимое выделенных ячеек (удалить значения, оставить стили). Использовать когда говорят «удали что внутри», «очисти эти ячейки», «убери содержимое».',
          args: '{}',
          run: () => this.aiClearSelection(),
        },
        {
          name: 'excel_fill_selection',
          description: 'Заполнить все выделенные ячейки одним значением. Использовать когда говорят «поставь везде X», «заполни выделенное значением».',
          args: '{ value: string }',
          run: (a) => this.aiFillSelection(a),
        },
        {
          name: 'excel_clear_style_selection',
          description: 'Убрать форматирование (стили) у выделенных ячеек, оставить только значения.',
          args: '{}',
          run: () => this.aiClearStyleSelection(),
        },
        // ── Управление документами ──────────────────────────────────────────
        {
          name: 'docs_create',
          description: 'Создать новый документ Excel или Word. type — "excel" или "word". title — название документа (необязательно). Использовать когда просят «создай новую таблицу», «открой новый Word».',
          args: '{ type: "excel"|"word", title?: string }',
          run: (a) => this.aiDocsCreate(a),
        },
        {
          name: 'docs_delete',
          description: 'Удалить один или несколько документов. docIds — массив id или "all" для всех. names — массив названий (если id неизвестны). Использовать когда просят «удали этот файл», «закрой все документы», «удали Таблицу 1 и Таблицу 2». ВНИМАНИЕ: действие необратимо — не требует подтверждения, выполняет сразу.',
          args: '{ docIds?: string[]|"all", names?: string[] }',
          run: (a) => this.aiDocsDelete(a),
        },
        {
          name: 'docs_rename',
          description: 'Переименовать один или несколько документов. renames — массив объектов с id или name (текущее) и newName (новое). Использовать когда просят «переименуй», «назови иначе», «смени заголовок файла».',
          args: '{ renames: Array<{ id?: string, name?: string, newName: string }> }',
          run: (a) => this.aiDocsRename(a),
        },
        {
          name: 'docs_switch',
          description: 'Переключиться на другой открытый документ. Использовать когда просят «перейди к файлу X», «открой Таблицу 2», «переключись на документ».',
          args: '{ id?: string, name?: string }',
          run: (a) => this.aiDocsSwitch(a),
        },
        {
          name: 'docs_clear_content',
          description: 'Очистить всё содержимое документов (все ячейки Excel или весь текст Word). docIds — массив id или "all" для всех. Использовать когда просят «очисти всё», «сотри всё во всех файлах», «обнули таблицы».',
          args: '{ docIds: string[]|"all" }',
          run: (a) => this.aiDocsClearContent(a),
        },
        // ── Управление диапазонами ──────────────────────────────────────────
        {
          name: 'excel_set_range',
          description: 'Записать блок значений начиная с ячейки start (или левого верхнего угла range). values — двумерный массив [строки][столбцы]; числа — числами, формулы — строками «=…» (СУММ, СЧЁТЕСЛИ, ВПР, ссылки на другие листы \'Лист\'!A1:A99 и колонки целиком A:A). sheet — имя листа; createSheet=true — создать лист, если его нет. header=true — сделать первую строку шапкой. Главный инструмент, чтобы собрать новую таблицу/отчёт.',
          args: '{ start?: "A1", range?: "A1:C3", values: any[][], sheet?: string, createSheet?: boolean, header?: boolean }',
          run: (a) => this.aiExcelSetRange(a),
        },
        {
          name: 'excel_delete_rows',
          description: 'Удалить строки по номерам (1-based) или по условию. rows — конкретные номера строк. column+value_filter — удалить строки, где колонка соответствует регулярному выражению. skipHeader — пропускать строку 1 (по умолчанию true). Использовать когда просят «удали строки 3 и 5», «удали пустые строки», «удали строки где цена 0».',
          args: '{ rows?: number[], column?: string, value_filter?: string, skipHeader?: boolean }',
          run: (a) => this.aiExcelDeleteRows(a),
        },
        {
          name: 'excel_insert_rows',
          description: 'Вставить пустые строки в таблицу. at — номер строки (1-based), перед которой вставить. count — количество строк (по умолчанию 1). Использовать когда просят «вставь строку после заголовка», «добавь 3 пустые строки».',
          args: '{ at: number, count?: number }',
          run: (a) => this.aiExcelInsertRows(a),
        },
        {
          name: 'excel_sort_sheet',
          description: 'Отсортировать строки таблицы по колонке. column — буква или имя заголовка. order — "asc" (по возрастанию) или "desc" (по убыванию). hasHeader — есть ли строка-заголовок (по умолчанию true). numeric — сортировать как числа (по умолчанию auto-detect). Использовать когда просят «отсортируй по цене», «упорядочи по убыванию».',
          args: '{ column: "A"|"Цена", order?: "asc"|"desc", hasHeader?: boolean, numeric?: boolean }',
          run: (a) => this.aiExcelSortSheet(a),
        },
        {
          name: 'excel_formula_column',
          description: 'Заполнить колонку формулами по шаблону. column — буква или имя. formula — шаблон формулы, где {r} — номер строки (напр. "=B{r}*C{r}" или "=СУММ(A{r}:E{r})"). fromRow — начать с этой строки 1-based (по умолчанию 2 = после заголовка). toRow — до этой строки (по умолчанию последняя строка с данными+1). Использовать когда просят «добавь формулу умножения», «посчитай сумму по строкам».',
          args: '{ column: "D"|"Итого", formula: "=B{r}*C{r}", fromRow?: number, toRow?: number }',
          run: (a) => this.aiExcelFormulaColumn(a),
        },
        // ── Управление листами ──────────────────────────────────────────────
        {
          name: 'excel_add_sheet',
          description: 'Добавить новый лист в текущую Excel-таблицу. name — название листа (необязательно). Использовать когда просят «добавь новый лист», «создай вкладку».',
          args: '{ name?: string }',
          run: (a) => this.aiExcelAddSheet(a),
        },
        {
          name: 'excel_rename_sheet',
          description: 'Переименовать лист. from — текущее название (по умолчанию активный лист). to — новое название. Использовать когда просят «переименуй лист», «назови вкладку».',
          args: '{ from?: string, to: string }',
          run: (a) => this.aiExcelRenameSheet(a),
        },
        {
          name: 'excel_delete_sheet',
          description: 'Удалить лист из таблицы. name — название листа (по умолчанию активный). Нельзя удалить последний лист. Использовать когда просят «удали этот лист», «убери вкладку».',
          args: '{ name?: string }',
          run: (a) => this.aiExcelDeleteSheet(a),
        },
        {
          name: 'excel_copy_sheet',
          description: 'Скопировать лист внутри той же таблицы. from — название исходного листа (по умолчанию активный). newName — название копии. Использовать когда просят «скопируй лист», «продублируй вкладку».',
          args: '{ from?: string, newName?: string }',
          run: (a) => this.aiExcelCopySheet(a),
        },

        // ── Листы, диаграммы, отчёты ─────────────────────────────────────
        {
          name: 'excel_switch_sheet',
          description: 'Перейти на другой лист книги (показать его пользователю). name — имя листа или часть имени; index — номер с 1.',
          args: '{ name?: string, index?: number }',
          run: (a) => this.aiExcelSwitchSheet(a),
        },
        {
          name: 'excel_create_report',
          description: 'Построить сводный отчёт на НОВОМ листе: итоги по таблице (количество строк, суммы/средние/мин/макс по колонкам) и разбивка по категории groupBy с итоговой строкой и диаграммой. Все значения — живые формулы со ссылками на исходный лист. Использовать для «посчитай заказы/выручку/расходы и вынеси на новый лист», «сделай сводку», «итоги по городам/товарам/месяцам». metrics — [{column, op: sum|avg|min|max|count, label?}]; если не указать — все числовые колонки суммой. chart — тип диаграммы (col|bar|pie|line) или false.',
          args: '{ source?: string, newSheet?: string, title?: string, groupBy?: string, metrics?: Array<{ column?: string, op?: string, label?: string, format?: string }>, chart?: string|boolean, limit?: number }',
          run: (a) => this.aiExcelCreateReport(a),
        },
        {
          name: 'excel_add_chart',
          description: 'Построить диаграмму по диапазону: первая колонка — подписи, следующие — ряды чисел, первая строка — заголовки рядов. type: col (гистограмма), bar, line, pie, doughnut, area, scatter. sheet — лист с данными; targetSheet — куда поставить (можно новый); at — ячейка левого верхнего угла. В .xlsx уходит настоящей диаграммой Excel.',
          args: '{ type?: string, range: "A1:C13", sheet?: string, title?: string, targetSheet?: string, at?: "E2", width?: number, height?: number }',
          run: (a) => this.aiExcelAddChart(a),
        },
        {
          name: 'excel_merge',
          description: 'Объединить ячейки диапазона (по центру) или разъединить (unmerge: true).',
          args: '{ range: "A1:D1", unmerge?: boolean, center?: boolean, sheet?: string }',
          run: (a) => this.aiExcelMerge(a),
        },
        {
          name: 'excel_column_width',
          description: 'Ширина колонок: columns — буквы, имена заголовков, диапазон "A:D" или "all"; width — пиксели или "auto" (по содержимому).',
          args: '{ columns?: string[]|string, width?: number|"auto", sheet?: string }',
          run: (a) => this.aiExcelColumnWidth(a),
        },
        {
          name: 'excel_freeze',
          description: 'Закрепить области: rows — сколько строк сверху, cols — сколько колонок слева (0/0 — снять).',
          args: '{ rows?: number, cols?: number, sheet?: string }',
          run: (a) => this.aiExcelFreeze(a),
        },
        // ── Чтение и анализ ───────────────────────────────────────────────
        // Обзор документа в describe() умышленно краткий: эти действия
        // позволяют запросить именно нужный срез вместо догадок по образцу.
        {
          name: 'excel_schema',
          description: 'Схема листа: какие колонки, их тип (число/категория/текст), заполненность, уникальность, примеры значений. Дёшево по объёму. Вызывать ПЕРВЫМ, когда нужно понять структуру таблицы перед выборкой или расчётом.',
          args: '{ sheet?: string }',
          run: (a) => this.aiExcelSchema(a),
        },
        {
          name: 'excel_query',
          description: 'Выбрать строки по условиям и показать нужные колонки. where — {"Колонка":"критерий"}, критерий как в СУММЕСЛИ: точное значение, ">100", "<>нет", маска "А*". columns — какие колонки показать. sortBy/desc — сортировка. Использовать для «покажи заказы из Мадрида», «какие товары дороже 1000».',
          args: '{ where?: object, columns?: string[], sortBy?: string, desc?: boolean, limit?: number, sheet?: string }',
          run: (a) => this.aiExcelQuery(a),
        },
        {
          name: 'excel_aggregate',
          description: 'Посчитать итог: op = sum|avg|count|min|max|countdistinct. column — по какой колонке считать (не нужна для count). groupBy — разбить по колонке. where — предварительный отбор. Использовать для «сколько всего», «сумма по городам», «средняя цена», «сколько уникальных артикулов». НЕ считай в уме по образцу строк — вызывай это.',
          args: '{ op: string, column?: string, groupBy?: string, where?: object, limit?: number, sheet?: string }',
          run: (a) => this.aiExcelAggregate(a),
        },
        {
          name: 'excel_find',
          description: 'Найти текст в таблице и получить адреса ячеек и номера строк. columns — где искать (по умолчанию везде), exact — точное совпадение вместо вхождения. Использовать для «где встречается X», «в какой строке Y».',
          args: '{ query: string, columns?: string[], exact?: boolean, limit?: number, sheet?: string }',
          run: (a) => this.aiExcelFind(a),
        },
        {
          name: 'excel_read_range',
          description: 'Прочитать конкретный диапазон, например A1:D20. Использовать когда пользователь называет диапазон явно или нужно посмотреть кусок листа целиком.',
          args: '{ range: string, sheet?: string }',
          run: (a) => this.aiExcelReadRange(a),
        },
        {
          name: 'excel_validate',
          description: 'Проверить качество данных: duplicates — колонки на дубли, required — колонки, где не должно быть пустот, numeric — где должны быть только числа, positive — где числа должны быть больше нуля. Использовать для «найди дубли артикулов», «проверь таблицу на ошибки», «где пустые цены».',
          args: '{ duplicates?: string[], required?: string[], numeric?: string[], positive?: string[], sheet?: string }',
          run: (a) => this.aiExcelValidate(a),
        },

        // ── Точечное редактирование Word ──────────────────────────────────
        // Раньше правка сводилась к word_set_content, который переписывает
        // документ целиком и стирает оформление.
        {
          name: 'word_outline',
          description: 'Структура Word-документа: пронумерованный список абзацев с их типом и началом текста. Вызывать ПЕРЕД точечной правкой, чтобы узнать номер нужного абзаца.',
          args: '{ limit?: number }',
          run: () => this.aiWordOutline(),
        },
        {
          name: 'word_edit_paragraph',
          description: 'Заменить содержимое одного абзаца по его номеру из word_outline. Оформление остальных абзацев не трогается. Использовать для «перепиши третий абзац», «поправь заголовок».',
          args: '{ index: number, text?: string, html?: string }',
          run: (a) => this.aiWordEditParagraph(a),
        },
        {
          name: 'word_insert',
          description: 'Вставить новый фрагмент. position: end (по умолчанию), start или after — тогда нужен afterIndex из word_outline. Использовать для «добавь абзац», «вставь раздел после второго».',
          args: '{ text?: string, html?: string, position?: string, afterIndex?: number }',
          run: (a) => this.aiWordInsert(a),
        },
        {
          name: 'excel_insert_image',
          description: 'Вставить в ячейку Excel картинку, которую пользователь прикрепил к сообщению. Именно этим инструментом отвечать на «вставь это фото в B1», «добавь картинку сюда» — вставка изображений поддерживается. image — ссылка вида "img1" из описания вложения (если не указать, берётся последняя присланная). cell — адрес ("B1"); без него картинка идёт в выделенную ячейку. width — ширина кадра в пикселях (по умолчанию 260). Если картинка уже стоит в документе и её надо переложить в другую ячейку — это excel_move_image, а не повторная вставка.',
          args: '{ cell?: string, image?: string, width?: number }',
          run: (a) => this.aiExcelInsertImage(a),
        },
        {
          name: 'excel_move_image',
          description: 'Перенести картинку из одной ячейки Excel в другую — именно этим отвечать на «перемести фото в I2», «перенеси картинку». Картинка исчезает из исходной ячейки и появляется в новой; копию делать не нужно. from — откуда ("B1"); без него берётся единственная картинка на листе. to — куда ("I2"); без него берётся выделенная ячейка.',
          args: '{ from?: string, to?: string }',
          run: (a) => this.aiExcelMoveImage(a),
        },
        {
          name: 'excel_remove_image',
          description: 'Удалить картинку из ячейки Excel («убери фото из B1»). Текст и оформление ячейки остаются. cell — адрес ("B1"); без него берётся единственная картинка на листе.',
          args: '{ cell?: string }',
          run: (a) => this.aiExcelRemoveImage(a),
        },
        {
          name: 'word_remove_image',
          description: 'Удалить картинку из Word-документа. index — её номер сверху (1 = первая); если картинка одна, можно не указывать.',
          args: '{ index?: number }',
          run: (a) => this.aiWordRemoveImage(a),
        },
        {
          name: 'word_insert_image',
          description: 'Вставить в Word-документ картинку, которую пользователь прикрепил к сообщению. image — ссылка вида "img1" (по умолчанию последняя присланная). position: end (по умолчанию), start или after с afterIndex из word_outline. width — ширина в пикселях (по умолчанию 420).',
          args: '{ image?: string, width?: number, position?: string, afterIndex?: number }',
          run: (a) => this.aiWordInsertImage(a),
        },
        {
          name: 'word_delete_paragraph',
          description: 'Удалить абзац по номеру из word_outline.',
          args: '{ index: number }',
          run: (a) => this.aiWordDeleteParagraph(a),
        },
        {
          name: 'word_insert_table',
          description: 'Вставить таблицу. rows — массив массивов строк, первая строка считается шапкой, если headers не false. Использовать для «сделай таблицу», «оформи это таблицей».',
          args: '{ rows: string[][], headers?: boolean, position?: string, afterIndex?: number }',
          run: (a) => this.aiWordInsertTable(a),
        },
        {
          name: 'word_style_text',
          description: 'Оформить все вхождения текста: bold, italic, underline, color (#RRGGBB), bg, size (пункты). Использовать для «выдели красным слово X», «сделай жирным все упоминания Y».',
          args: '{ find: string, bold?: boolean, italic?: boolean, underline?: boolean, color?: string, bg?: string, size?: number, caseSensitive?: boolean }',
          run: (a) => this.aiWordStyleText(a),
        },
      ],
    };
  }

  // ── AI action implementations ───────────────────────────────────────────────


  /** Результат AI-действия со снимком «до» для отката (kind='docs'). */
  private docsResult(docId: string, before: string, summary: string, label: string): AiActionResult {
    return { summary, undo: { kind: 'docs', payload: { docId, before }, label } };
  }

  /** Восстановить документ из снимка (обработчик отката 'docs'). */
  aiUndoRestore(payload: { docId: string; before: string }): void {
    if (!payload?.docId) return;
    this.updateContent(payload.docId, payload.before ?? '');
    if (this.root.style.display !== 'none') this.render();
  }












  private aiWordCount(): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const text = doc.content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text.length;
    const charsNoSpace = text.replace(/\s/g, '').length;
    const paragraphs = (doc.content.match(/<(p|h[1-6])\b/gi) ?? []).length;
    return { summary: `📊 «${doc.title}»: **${words} слов**, ${chars} символов (без пробелов: ${charsNoSpace}), ~${paragraphs} абзацев.` };
  }

  private aiWordSetContent(a: { html?: string; text?: string; append?: boolean }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const before = doc.content;
    let html = (a?.html ?? '').trim();
    if (!html && a?.text) {
      html = a.text.split(/\n\n+/).map(p => `<p>${this.esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
    }
    if (!html) throw new Error('Не указано содержимое (html или text)');
    const result = a?.append ? before + html : html;
    this.updateContent(doc.id, result);
    // Try to update the live contenteditable directly (avoids full DOM rebuild)
    const page = this.root.querySelector<HTMLElement>('.docs-word-page');
    if (page) {
      page.innerHTML = result;
    } else {
      this.render();
    }
    const wordCount = result.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    return this.docsResult(doc.id, before, `Документ обновлён (~${wordCount} слов).`, 'Отменить изменение содержимого');
  }

  private aiWordClearFormatting(): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const before = doc.content;
    const result = doc.content
      .replace(/ style="[^"]*"/gi, '')
      .replace(/ color="[^"]*"/gi, '')
      .replace(/ face="[^"]*"/gi, '')
      .replace(/ size="[^"]*"/gi, '')
      .replace(/<\/?(font|span)\b[^>]*>/gi, '')
      .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<u>([\s\S]*?)<\/u>/gi, '$1')
      .replace(/<(s|strike)>([\s\S]*?)<\/\1>/gi, '$2')
      .replace(/<mark>([\s\S]*?)<\/mark>/gi, '$1');
    this.updateContent(doc.id, result);
    this.render();
    return this.docsResult(doc.id, before, 'Форматирование очищено: убраны стили, цвета, жирность, курсив.', 'Отменить очистку форматирования');
  }

  // ── Точечное редактирование Word ───────────────────────────────────────────
  // Работаем через DOM, а не регулярками: строковая замена по HTML ломается
  // на вложенных тегах и съедает оформление.

  /** Разобрать содержимое активного Word-документа в DOM. */
  private aiWordDom(): { doc: DocItem; body: HTMLElement; before: string } {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><body>${doc.content}</body></html>`, 'text/html');
    return { doc, body: parsed.body, before: doc.content };
  }

  /** Блоки верхнего уровня — то, что пользователь называет «абзацами». */
  private aiWordBlocks(body: HTMLElement): HTMLElement[] {
    const TAGS = new Set(['P','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','PRE','UL','OL','TABLE','DIV']);
    const out: HTMLElement[] = [];
    Array.from(body.children).forEach(el => {
      if (TAGS.has(el.tagName)) out.push(el as HTMLElement);
    });
    return out;
  }

  private aiWordSave(doc: DocItem, body: HTMLElement, before: string, summary: string, label: string): AiActionResult {
    normalizeWhitespace(body);
    this.updateContent(doc.id, body.innerHTML);
    this.render();
    return this.docsResult(doc.id, before, summary, label);
  }

  private aiWordOutline(): string {
    const { body } = this.aiWordDom();
    const blocks = this.aiWordBlocks(body);
    if (!blocks.length) return 'Документ пуст — абзацев нет.';
    const KIND: Record<string, string> = {
      P: 'абзац', H1: 'заголовок 1', H2: 'заголовок 2', H3: 'заголовок 3',
      H4: 'заголовок 4', H5: 'заголовок 5', H6: 'заголовок 6',
      BLOCKQUOTE: 'цитата', PRE: 'код', UL: 'список', OL: 'нум. список',
      TABLE: 'таблица', DIV: 'блок',
    };
    const lines = blocks.slice(0, 200).map((el, i) => {
      const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const kind = KIND[el.tagName] ?? el.tagName.toLowerCase();
      const extra = el.tagName === 'TABLE'
        ? ` (${el.querySelectorAll('tr').length} строк)`
        : (el.tagName === 'UL' || el.tagName === 'OL') ? ` (${el.querySelectorAll('li').length} пунктов)` : '';
      return `  ${i + 1}. [${kind}]${extra} ${txt.slice(0, 90)}${txt.length > 90 ? '…' : ''}`;
    });
    return `Структура документа (${blocks.length} блоков):\n${lines.join('\n')}`
      + (blocks.length > 200 ? '\n  …показаны первые 200' : '')
      + '\nНомера из этого списка передавай в word_edit_paragraph / word_delete_paragraph / afterIndex.';
  }

  /** Проверить номер абзаца и вернуть сам элемент. */
  private aiWordBlockAt(blocks: HTMLElement[], index: unknown): HTMLElement {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 1 || i > blocks.length) {
      throw new Error(`Номер абзаца ${index} вне диапазона 1…${blocks.length}. Сначала вызови word_outline.`);
    }
    return blocks[i - 1];
  }

  /** HTML из аргументов действия: html как есть, text — с экранированием. */
  private aiWordFragment(a: { text?: string; html?: string }): string {
    if (a?.html) return a.html;
    if (a?.text == null || a.text === '') throw new Error('Нужен text или html');
    return a.text.split(/\n{2,}/)
      .map(par => `<p>${this.esc(par).replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  private aiWordEditParagraph(a: { index: number; text?: string; html?: string }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const blocks = this.aiWordBlocks(body);
    const el = this.aiWordBlockAt(blocks, a?.index);
    const wasText = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

    if (a?.html) {
      el.innerHTML = a.html;
    } else {
      if (a?.text == null) throw new Error('Нужен text или html');
      // Меняем только текст, сохраняя тег и стиль абзаца
      el.textContent = a.text;
    }

    return this.aiWordSave(doc, body, before,
      `Абзац ${a.index} («${wasText}…») заменён.`, 'Отменить правку абзаца');
  }

  private aiWordInsert(a: { text?: string; html?: string; position?: string; afterIndex?: number }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const frag = this.aiWordFragment(a);
    const pos = (a?.position ?? 'end').toLowerCase();

    if (pos === 'start') {
      body.insertAdjacentHTML('afterbegin', frag);
    } else if (pos === 'after') {
      const blocks = this.aiWordBlocks(body);
      const el = this.aiWordBlockAt(blocks, a?.afterIndex);
      el.insertAdjacentHTML('afterend', frag);
    } else {
      body.insertAdjacentHTML('beforeend', frag);
    }

    const where = pos === 'start' ? 'в начало' : pos === 'after' ? `после абзаца ${a?.afterIndex}` : 'в конец';
    return this.aiWordSave(doc, body, before, `Фрагмент вставлен ${where}.`, 'Отменить вставку');
  }

  /**
   * Вставить картинку в ячейку Excel.
   *
   * Источник — вложение, которое пользователь прислал ассистенту: модель видит
   * изображение, но переслать его байты не может, поэтому ссылается на него
   * коротким идентификатором (см. services/imageAttachments).
   */
  private async aiExcelInsertImage(a: { cell?: string; image?: string; width?: number }): Promise<AiActionResult> {
    const st = this.aiSheet();
    if (!st) throw new Error('Сейчас открыт не Excel-документ');
    const { doc } = st;

    const { r, c } = this.aiImageTarget(doc, a?.cell);

    const pic = imageAttachments.resolve(a?.image);
    if (!pic) {
      throw new Error('Картинки нет: пользователь ничего не прикреплял в этом разговоре. Попроси прикрепить изображение к сообщению — тогда вставлю.');
    }
    const maxDisplay = Math.min(Math.max(Number(a?.width) || 260, 40), 600);

    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const addr = await this.setCellImage(doc, this.activeSheetIdx, r, c, pic.dataUrl, maxDisplay);
    return this.docsResult(doc.id, before, `Картинка «${pic.name}» вставлена в ячейку ${addr}.`, 'Убрать картинку');
  }

  /**
   * Положить картинку в ячейку и растянуть под неё столбец со строкой.
   * Общий путь для тулбара, вставки из буфера и ассистента.
   * Возвращает адрес ячейки.
   */
  private async setCellImage(doc: DocItem, sheetIdx: number, r: number, c: number,
                             src: string, maxDisplay = 260): Promise<string> {
    const pic = await prepareImage(src, 1000, maxDisplay);
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');

    this.placeImage(sheet, r, c, pic);
    this.aiPersist(doc, ec);
    return `${this.colLetter(c)}${r + 1}`;
  }

  /** Адрес вида "B1" → индексы. */
  private aiCellRef(ref: string): { r: number; c: number } {
    const m = String(ref ?? '').trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!m) throw new Error(`Неверный адрес ячейки: ${ref}. Пример: "B1"`);
    const c = this.letterToCol(m[1]), r = parseInt(m[2], 10) - 1;
    if (r < 0 || c < 0) throw new Error('Адрес ячейки за пределами листа');
    return { r, c };
  }

  /** Ячейка назначения: явный адрес, иначе то, что выделено в таблице. */
  private aiImageTarget(doc: DocItem, cell?: string): { r: number; c: number } {
    const ref = String(cell ?? '').trim();
    if (ref) return this.aiCellRef(ref);
    if (this.xlLastSel && this.xlLastSel.docId === doc.id)
      return { r: this.xlLastSel.r1, c: this.xlLastSel.c1 };
    throw new Error('Не указана ячейка. Передай cell вида "B1" либо попроси выделить ячейку в таблице.');
  }

  /** Все ячейки листа с картинками — по порядку сверху вниз. */
  private sheetImageCells(sheet: SheetData): { r: number; c: number; cell: CellData }[] {
    const out: { r: number; c: number; cell: CellData }[] = [];
    sheet.data.forEach((row, r) => row.forEach((cell, c) => { if (cell?.img) out.push({ r, c, cell }); }));
    return out;
  }

  /**
   * Ячейка, откуда берём картинку: явный адрес, иначе единственная картинка
   * на листе. Если картинок несколько — просим уточнить, а не угадываем.
   */
  private aiImageSource(sheet: SheetData, cell?: string): { r: number; c: number; cell: CellData } {
    const ref = String(cell ?? '').trim();
    if (ref) {
      const { r, c } = this.aiCellRef(ref);
      const hit = sheet.data[r]?.[c];
      if (!hit?.img) throw new Error(`В ячейке ${ref.toUpperCase()} картинки нет.`);
      return { r, c, cell: hit };
    }
    const all = this.sheetImageCells(sheet);
    if (!all.length) throw new Error('На листе нет ни одной картинки.');
    if (all.length > 1) {
      const addrs = all.map(x => `${this.colLetter(x.c)}${x.r + 1}`).join(', ');
      throw new Error(`Картинок несколько (${addrs}) — укажи, какую именно, в поле from/cell.`);
    }
    return all[0];
  }

  /** Положить готовую картинку в ячейку и растянуть под неё столбец со строкой. */
  private placeImage(sheet: SheetData, r: number, c: number,
                     img: { dataUrl: string; w?: number; h?: number }): void {
    while (sheet.data.length <= r) sheet.data.push([]);
    const width = Math.max(...sheet.data.map(row => row.length), c + 1);
    for (const row of sheet.data) while (row.length < width) row.push({ v: '' });
    const cell = sheet.data[r][c] ?? { v: '' };
    sheet.data[r][c] = { ...cell, img: img.dataUrl, imgW: img.w, imgH: img.h };

    // Ячейку надо растянуть под картинку, иначе она окажется обрезанной
    // рамками столбца и строки.
    if (img.w && img.h) {
      const colWidths = sheet.colWidths ?? (sheet.colWidths = []);
      const rowHeights = sheet.rowHeights ?? (sheet.rowHeights = []);
      colWidths[c] = Math.max(colWidths[c] ?? 0, img.w + 12);
      rowHeights[r] = Math.max(rowHeights[r] ?? 0, img.h + 10);
    }
  }

  /**
   * Убрать картинку из ячейки. Текст и оформление остаются. Столбец со строкой
   * возвращаем к обычному размеру — но только если растянули их мы сами под эту
   * же картинку: ширину, которую выставил пользователь, трогать нельзя.
   */
  private removeImage(sheet: SheetData, r: number, c: number): void {
    const cell = sheet.data[r]?.[c];
    if (!cell?.img) return;
    const { imgW, imgH } = cell;
    const next: CellData = { ...cell };
    delete next.img; delete next.imgW; delete next.imgH;
    sheet.data[r][c] = next;
    if (imgW && sheet.colWidths?.[c] === imgW + 12) sheet.colWidths[c] = null;
    if (imgH && sheet.rowHeights?.[r] === imgH + 10) sheet.rowHeights[r] = null;
  }

  /** Перенести картинку из одной ячейки в другую. */
  private aiExcelMoveImage(a: { from?: string; to?: string }): AiActionResult {
    const st = this.aiSheet();
    if (!st) throw new Error('Сейчас открыт не Excel-документ');
    const { doc } = st;

    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');

    const src = this.aiImageSource(sheet, a?.from);
    const dst = this.aiImageTarget(doc, a?.to);
    const fromAddr = `${this.colLetter(src.c)}${src.r + 1}`;
    const toAddr = `${this.colLetter(dst.c)}${dst.r + 1}`;
    if (src.r === dst.r && src.c === dst.c)
      throw new Error(`Картинка уже в ${fromAddr}.`);

    // Картинка уже подготовлена при вставке — пережимать её второй раз незачем.
    const img = { dataUrl: src.cell.img!, w: src.cell.imgW, h: src.cell.imgH };
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    this.removeImage(sheet, src.r, src.c);
    this.placeImage(sheet, dst.r, dst.c, img);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Картинка перенесена из ${fromAddr} в ${toAddr}.`, 'Вернуть обратно');
  }

  /** Удалить картинку из ячейки, оставив её содержимое. */
  private aiExcelRemoveImage(a: { cell?: string }): AiActionResult {
    const st = this.aiSheet();
    if (!st) throw new Error('Сейчас открыт не Excel-документ');
    const { doc } = st;

    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[this.activeSheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');

    const src = this.aiImageSource(sheet, a?.cell);
    const addr = `${this.colLetter(src.c)}${src.r + 1}`;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    this.removeImage(sheet, src.r, src.c);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Картинка из ячейки ${addr} удалена.`, 'Вернуть картинку');
  }

  /** Вставить картинку в Word-документ отдельным абзацем. */
  private async aiWordInsertImage(a: { image?: string; width?: number; position?: string; afterIndex?: number }): Promise<AiActionResult> {
    const pic = imageAttachments.resolve(a?.image);
    if (!pic) {
      throw new Error('Картинки нет: пользователь ничего не прикреплял в этом разговоре. Попроси прикрепить изображение к сообщению — тогда вставлю.');
    }
    const maxDisplay = Math.min(Math.max(Number(a?.width) || 420, 60), 780);
    const pic2 = await prepareImage(pic.dataUrl, 1400, maxDisplay);

    const { doc, body, before } = this.aiWordDom();
    const size = pic2.w && pic2.h ? ` style="width:${pic2.w}px;height:${pic2.h}px"` : '';
    const frag = `<p><img src="${this.esc(pic2.dataUrl)}" alt="${this.esc(pic.name)}"${size}></p>`;
    const pos = (a?.position ?? 'end').toLowerCase();

    if (pos === 'start') {
      body.insertAdjacentHTML('afterbegin', frag);
    } else if (pos === 'after') {
      const blocks = this.aiWordBlocks(body);
      this.aiWordBlockAt(blocks, a?.afterIndex).insertAdjacentHTML('afterend', frag);
    } else {
      body.insertAdjacentHTML('beforeend', frag);
    }

    const where = pos === 'start' ? 'в начало' : pos === 'after' ? `после абзаца ${a?.afterIndex}` : 'в конец';
    return this.aiWordSave(doc, body, before, `Картинка «${pic.name}» вставлена ${where}.`, 'Убрать картинку');
  }

  /** Убрать картинку из Word-документа. */
  private aiWordRemoveImage(a: { index?: number }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const imgs = Array.from(body.querySelectorAll('img'));
    if (!imgs.length) throw new Error('В документе нет ни одной картинки.');

    let idx = Number(a?.index);
    if (!Number.isFinite(idx)) {
      if (imgs.length > 1)
        throw new Error(`Картинок ${imgs.length} — укажи номер (index), считая сверху.`);
      idx = 1;
    }
    const img = imgs[idx - 1];
    if (!img) throw new Error(`Картинки №${idx} нет: всего их ${imgs.length}.`);

    // Абзац, в котором кроме картинки ничего не было, тоже убираем —
    // иначе на его месте останется пустая строка.
    const host = img.closest('p,div');
    img.remove();
    if (host && host !== body && !(host.textContent ?? '').trim() && !host.querySelector('img,table'))
      host.remove();

    return this.aiWordSave(doc, body, before, 'Картинка удалена.', 'Вернуть картинку');
  }

  private aiWordDeleteParagraph(a: { index: number }): AiActionResult {
    const { doc, body, before } = this.aiWordDom();
    const blocks = this.aiWordBlocks(body);
    const el = this.aiWordBlockAt(blocks, a?.index);
    const txt = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    el.remove();
    return this.aiWordSave(doc, body, before,
      `Абзац ${a.index} («${txt}…») удалён.`, 'Вернуть абзац');
  }

  private aiWordInsertTable(a: {
    rows: string[][]; headers?: boolean; position?: string; afterIndex?: number;
  }): AiActionResult {
    const rows = a?.rows;
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(rows[0])) {
      throw new Error('rows должен быть массивом массивов строк, например [["A","B"],["1","2"]]');
    }
    const withHeader = a?.headers !== false;
    const cellStyle = 'border:1px solid #999;padding:6px';
    const html =
      `<table style="border-collapse:collapse;width:100%">` +
      rows.map((row, ri) => {
        const isHdr = withHeader && ri === 0;
        const tag = isHdr ? 'th' : 'td';
        const st = isHdr ? `${cellStyle};background-color:#F2F2F2;font-weight:bold` : cellStyle;
        return `<tr>${row.map(v => `<${tag} style="${st}">${this.esc(String(v ?? ''))}</${tag}>`).join('')}</tr>`;
      }).join('') +
      `</table>`;

    return this.aiWordInsert({
      html, position: a?.position, afterIndex: a?.afterIndex,
    });
  }

  private aiWordStyleText(a: {
    find: string; bold?: boolean; italic?: boolean; underline?: boolean;
    color?: string; bg?: string; size?: number; caseSensitive?: boolean;
  }): AiActionResult {
    const needle = String(a?.find ?? '');
    if (!needle) throw new Error('Не указано, какой текст оформить (find)');

    const css: string[] = [];
    if (a.bold) css.push('font-weight:bold');
    if (a.italic) css.push('font-style:italic');
    if (a.underline) css.push('text-decoration:underline');
    if (a.color) css.push(`color:${a.color}`);
    if (a.bg) css.push(`background-color:${a.bg}`);
    if (a.size) css.push(`font-size:${a.size}pt`);
    if (!css.length) throw new Error('Не указано ни одного оформления');

    const { doc, body, before } = this.aiWordDom();
    const style = css.join(';');
    let count = 0;

    // Обходим только текстовые узлы — так разметка вокруг остаётся целой
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      const hay = a.caseSensitive ? t.data : t.data.toLowerCase();
      const nee = a.caseSensitive ? needle : needle.toLowerCase();
      if (hay.includes(nee)) targets.push(t);
    }

    for (const node of targets) {
      const parts: Array<{ text: string; hit: boolean }> = [];
      let rest = node.data;
      for (;;) {
        const hay = a.caseSensitive ? rest : rest.toLowerCase();
        const nee = a.caseSensitive ? needle : needle.toLowerCase();
        const i = hay.indexOf(nee);
        if (i < 0) { if (rest) parts.push({ text: rest, hit: false }); break; }
        if (i > 0) parts.push({ text: rest.slice(0, i), hit: false });
        parts.push({ text: rest.slice(i, i + needle.length), hit: true });
        rest = rest.slice(i + needle.length);
      }

      const frag = body.ownerDocument.createDocumentFragment();
      for (const p of parts) {
        if (p.hit) {
          const span = body.ownerDocument.createElement('span');
          span.setAttribute('style', style);
          span.textContent = p.text;
          frag.appendChild(span);
          count++;
        } else {
          frag.appendChild(body.ownerDocument.createTextNode(p.text));
        }
      }
      node.parentNode?.replaceChild(frag, node);
    }

    if (!count) throw new Error(`Текст «${needle}» в документе не найден`);
    return this.aiWordSave(doc, body, before,
      `Оформлено вхождений: ${count}.`, 'Отменить оформление');
  }

  private aiWordHeading(a: { text?: string; level?: number }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    const before = doc.content;
    const level = Math.min(Math.max(a?.level ?? 1, 1), 6);
    const tag = `h${level}`;
    let result = doc.content;
    let count = 0;
    if (a?.text) {
      const re = new RegExp(`<p([^>]*)>([^<]*${this.escRe(a.text)}[^<]*)</p>`, 'gi');
      result = result.replace(re, (_m, attrs, inner) => { count++; return `<${tag}${attrs}>${inner}</${tag}>`; });
      if (!count) throw new Error(`Абзац с текстом «${a.text}» не найден`);
    } else {
      result = result.replace(/<p([^>]*)>([\s\S]*?)<\/p>/i, (_m, attrs, inner) => { count++; return `<${tag}${attrs}>${inner}</${tag}>`; });
      if (!count) throw new Error('Нет абзацев для преобразования в заголовок');
    }
    this.updateContent(doc.id, result);
    this.render();
    return this.docsResult(doc.id, before, `Применён «Заголовок ${level}» к ${count} абзацу(-ам).`, 'Отменить заголовок');
  }

  private aiWordReplace(a: { find: string; replaceWith: string; caseSensitive?: boolean }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'word') throw new Error('Сейчас открыт не Word-документ');
    if (!a?.find) throw new Error('Не указано, что заменять (find)');
    const re = new RegExp(this.escRe(a.find), a.caseSensitive ? 'g' : 'gi');
    const before = doc.content;
    // Заменяем только в текстовых узлах (между тегами), не ломая разметку/атрибуты.
    const after = before.replace(/>([^<]+)</g, (_m, text) => '>' + text.replace(re, a.replaceWith ?? '') + '<');
    const count = (before.match(re) || []).length;
    this.updateContent(doc.id, after);
    this.render();
    return this.docsResult(doc.id, before, `В документе заменено ~${count} вхождений («${a.find}» → «${a.replaceWith ?? ''}»).`, 'Отменить замену');
  }



  private aiExcelClearCells(a: {
    column?: string; rows?: number[] | 'all'; cells?: string[];
    value_filter?: string; preview_only?: boolean;
  }): AiActionResult {
    const s = this.aiSheet();
    if (!s) throw new Error('Сейчас открыт не Excel-документ');
    const { ec, sheet, doc } = s;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;

    // Compile value_filter regex (default: match non-empty)
    let filterRe: RegExp | null = null;
    if (a?.value_filter) {
      try { filterRe = new RegExp(a.value_filter); }
      catch { throw new Error(`Неверный value_filter: ${a.value_filter}`); }
    }

    const matchesFilter = (v: string) => {
      const trimmed = v.trim();
      if (!trimmed) return false; // никогда не очищаем пустые ячейки
      if (!filterRe) return true; // без фильтра — очищаем всё непустое
      return filterRe.test(trimmed);
    };

    const cleared: string[] = [];

    if (a?.cells?.length) {
      for (const ref of a.cells) {
        const m = String(ref).match(/^([A-Za-z]+)(\d+)$/);
        if (!m) continue;
        const ci = this.letterToCol(m[1]);
        const ri = parseInt(m[2], 10) - 1;
        if (ri >= 0 && ri < sheet.data.length && ci >= 0 && ci < (sheet.data[ri]?.length ?? 0)) {
          const v = sheet.data[ri][ci]?.v ?? '';
          if (matchesFilter(v)) {
            if (!a.preview_only) sheet.data[ri][ci] = { v: '' };
            cleared.push(`${this.colLetter(ci)}${ri + 1}="${v}"`);
          }
        }
      }
    } else if (a?.column != null) {
      const ci = this.aiResolveCol(sheet, String(a.column));
      if (ci < 0) throw new Error(`Колонка «${a.column}» не найдена`);
      const startRow = 1;
      const endRow = sheet.data.length;
      const targetRows = !a.rows || a.rows === 'all'
        ? Array.from({ length: endRow - startRow }, (_, i) => i + startRow)
        : (a.rows as number[]).map(r => r - 1);
      for (const ri of targetRows) {
        if (ri >= startRow && ri < endRow && ci < (sheet.data[ri]?.length ?? 0)) {
          const v = sheet.data[ri][ci]?.v ?? '';
          if (matchesFilter(v)) {
            if (!a.preview_only) sheet.data[ri][ci] = { v: '' };
            cleared.push(`${this.colLetter(ci)}${ri + 1}="${v}"`);
          }
        }
      }
    } else {
      throw new Error('Укажи column или cells');
    }

    if (a.preview_only) {
      return { summary: `Будет очищено ${cleared.length} ячеек: ${cleared.slice(0, 10).join(', ')}${cleared.length > 10 ? ` ... и ещё ${cleared.length - 10}` : ''}` };
    }

    if (!cleared.length) {
      return { summary: 'Ни одна ячейка не подошла под фильтр — ничего не изменено.' };
    }

    this.aiPersist(doc, ec);
    return this.docsResult(
      doc.id, before,
      `Очищено ${cleared.length} ячеек по фильтру: ${cleared.slice(0, 6).join(', ')}${cleared.length > 6 ? ` ... и ещё ${cleared.length - 6}` : ''}.`,
      'Отменить очистку',
    );
  }

  /**
   * Вычислить формулу по данным листа.
   *
   * Разбор делегирован src/utils/formula.ts: там честный токенизатор и
   * рекурсивный спуск, поэтому работают вложенные вызовы вроде
   * =IF(A1>0,SUM(B1:B5),0), которые прежний разбор регулярками не тянул.
   *
   * Вычислитель кэшируется на набор строк: за один проход отрисовки лист
   * обходится один раз, а не пересчитывается заново для каждой ячейки.
   */
  private evalFormula(formula: string, rows: CellData[][]): string {
    return this.evaluatorFor(rows).evalToString(formula);
  }

  /** Вычислитель для набора строк; переиспользуется в пределах отрисовки. */
  private evaluatorFor(rows: CellData[][]): Evaluator {
    if (this.fxRows === rows && this.fxEval) return this.fxEval;
    this.fxRows = rows;
    this.fxEval = createEvaluator({
      raw: (r, c) => rows[r]?.[c]?.v ?? '',
      isNumeric: (r, c) => rows[r]?.[c]?.t === 'n',
    });
    return this.fxEval;
  }

  /** Сбросить кэш формул — данные изменились. */
  private invalidateFormulas(): void {
    this.fxRows = null;
    this.fxEval = null;
  }



  private aiMultiReplace(a: { docIds: string[] | 'all'; find: string; replaceWith: string; caseSensitive?: boolean }): AiActionResult {
    if (!a?.find) throw new Error('Не указано, что заменять (find)');
    const repl = a.replaceWith ?? '';
    const targets = a.docIds === 'all' ? [...this.docs] : this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (!targets.length) throw new Error('Не найдены указанные документы. Вызови describe() чтобы увидеть список открытых документов.');
    const flags = a.caseSensitive ? 'g' : 'gi';
    const snapshots: Array<{ docId: string; before: string }> = [];
    const lines: string[] = [];
    for (const doc of targets) {
      const before = doc.content;
      snapshots.push({ docId: doc.id, before });
      if (doc.type === 'word') {
        const re = new RegExp(this.escRe(a.find), flags);
        const count = (before.match(re) || []).length;
        const after = before.replace(/>([^<]+)</g, (_m, text) => '>' + text.replace(new RegExp(this.escRe(a.find), flags), repl) + '<');
        this.updateContent(doc.id, after);
        lines.push(`«${doc.title}» (Word): заменено ~${count}`);
      } else {
        let ec: ExcelContent;
        try { ec = JSON.parse(doc.content); } catch { lines.push(`«${doc.title}» (Excel): ошибка разбора`); continue; }
        const re = new RegExp(this.escRe(a.find), flags);
        let count = 0;
        for (const sheet of ec.sheets ?? []) {
          for (const row of sheet.data ?? []) {
            for (const cell of row) {
              if (cell?.v && re.test(cell.v)) {
                re.lastIndex = 0;
                const next = cell.v.replace(re, repl);
                if (next !== cell.v) { cell.v = next; count++; }
              }
              re.lastIndex = 0;
            }
          }
        }
        this.updateContent(doc.id, this.serializeExcel(ec));
        lines.push(`«${doc.title}» (Excel): заменено ${count}`);
      }
    }
    this.render();
    return {
      summary: `Замена «${a.find}» → «${repl}» в ${targets.length} документах:\n` + lines.join('\n'),
      undo: { kind: 'docs_multi', payload: { snapshots }, label: 'Отменить замену во всех' },
    };
  }

  private aiMultiCount(a: { docIds: string[] | 'all'; find: string; caseSensitive?: boolean }): AiActionResult {
    if (!a?.find) throw new Error('Не указано, что искать (find)');
    const targets = a.docIds === 'all' ? [...this.docs] : this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (!targets.length) throw new Error('Не найдены указанные документы. Вызови describe() чтобы увидеть список открытых документов.');
    const flags = a.caseSensitive ? 'g' : 'gi';
    const lines: string[] = [];
    let total = 0;
    for (const doc of targets) {
      if (doc.type === 'word') {
        const text = doc.content.replace(/<[^>]+>/g, ' ');
        const re = new RegExp(this.escRe(a.find), flags);
        const count = (text.match(re) || []).length;
        total += count;
        lines.push(`«${doc.title}» (Word): ${count}`);
      } else {
        let ec: ExcelContent;
        try { ec = JSON.parse(doc.content); } catch { lines.push(`«${doc.title}» (Excel): ошибка разбора`); continue; }
        const re = new RegExp(this.escRe(a.find), flags);
        let count = 0;
        for (const sheet of ec.sheets ?? []) {
          for (const row of sheet.data ?? []) {
            for (const cell of row) {
              if (cell?.v) {
                const m = cell.v.match(re);
                if (m) count += m.length;
                re.lastIndex = 0;
              }
            }
          }
        }
        total += count;
        lines.push(`«${doc.title}» (Excel): ${count}`);
      }
    }
    return { summary: `Вхождений «${a.find}» в ${targets.length} документах (всего ${total}):\n` + lines.join('\n') };
  }

  aiUndoRestoreMulti(payload: { snapshots: Array<{ docId: string; before: string }> }): void {
    if (!payload?.snapshots) return;
    for (const { docId, before } of payload.snapshots) {
      this.updateContent(docId, before ?? '');
    }
    if (this.root.style.display !== 'none') this.render();
  }

  // ── Docs management AI actions ──────────────────────────────────────────────

  private aiDocsCreate(a: { type: 'excel' | 'word'; title?: string }): AiActionResult {
    const type = a?.type === 'word' ? 'word' : 'excel';
    const now = Date.now();
    const n = this.docs.filter(d => d.type === type).length + 1;
    const defaultTitle = type === 'word' ? `Документ ${n}` : `Таблица ${n}`;
    const title = (a?.title ?? '').trim() || defaultTitle;
    const doc: DocItem = {
      id: this.newId(), type,
      title,
      content: type === 'word' ? '' : this.emptyExcel(),
      updated_at: now,
    };
    this.addDoc(doc);
    return { summary: `Создан ${type === 'word' ? 'Word-документ' : 'Excel-файл'} «${title}» (id="${doc.id}").` };
  }

  /** Разрешить ссылки на документы в аргументах действия. Общая для показа и выполнения. */
  private aiResolveDocs(a: { docIds?: string[] | 'all'; names?: string[] }): DocItem[] {
    if (a?.docIds === 'all') return [...this.docs];
    if (Array.isArray(a?.docIds) && a.docIds.length > 0)
      return this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (Array.isArray(a?.names) && a.names.length > 0) {
      const lows = a.names.map(n => n.trim().toLowerCase());
      return this.docs.filter(d => lows.some(l => d.title.trim().toLowerCase().includes(l)));
    }
    return [];
  }

  /**
   * Что произойдёт, если выполнить разрушающее действие — текст карточки
   * подтверждения. Считаем по реальным данным, чтобы пользователь видел
   * «будет удалено 47 строк», а не общую фразу.
   *
   * Возвращает null, если действие не разрушающее или посчитать не вышло.
   */
  aiPreviewDestructive(name: string, args: any): string | null {
    const a = args ?? {};
    try {
      switch (name) {
        case 'docs_delete': {
          const t = this.aiResolveDocs(a);
          if (!t.length) return null;
          return `Будут удалены документы (${t.length}): ${t.map(d => `«${d.title}»`).join(', ')}.\n`
            + 'Удаление документа необратимо — отменить нельзя.';
        }
        case 'docs_clear_content': {
          const t = this.aiResolveDocs(a);
          if (!t.length) return null;
          return `Будет стёрто всё содержимое документов (${t.length}): `
            + `${t.map(d => `«${d.title}»`).join(', ')}.\nСами документы останутся, но станут пустыми.`;
        }
        case 'excel_delete_sheet': {
          const s = this.aiSheet();
          if (!s) return null;
          const target = a.name
            ? s.ec.sheets.find(sh => sh.name.toLowerCase() === String(a.name).trim().toLowerCase())
            : s.sheet;
          if (!target) return null;
          const rows = target.data.filter(r => r.some(c => (c.v || '').trim())).length;
          return `Будет удалён лист «${target.name}» вместе с данными (${rows} заполненных строк).\n`
            + `Останется листов: ${s.ec.sheets.length - 1}.`;
        }
        case 'excel_delete_rows': {
          const s = this.aiSheet();
          if (!s) return null;
          const n = this.aiCountRowsToDelete(s.sheet, a);
          if (n == null) return null;
          return `Будет удалено строк: ${n} из листа «${s.sheet.name}».`;
        }
        case 'multi_replace': {
          const t = this.aiResolveDocs(a);
          const docs = t.length ? t : this.docs;
          const find = String(a.find ?? '');
          if (!find) return null;
          let hits = 0, touched = 0;
          for (const d of docs) {
            const hay = a.caseSensitive ? d.content : d.content.toLowerCase();
            const nee = a.caseSensitive ? find : find.toLowerCase();
            const c = hay.split(nee).length - 1;
            if (c > 0) { hits += c; touched++; }
          }
          return `Замена «${find}» → «${a.replaceWith ?? ''}» затронет `
            + `${hits} вхождений в ${touched} документах.`;
        }
        case 'word_set_content': {
          const doc = this.aiDoc();
          if (!doc || doc.type !== 'word') return null;
          if (a.append) return null;   // дописывание в конец ничего не рушит
          const len = doc.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
          return `Содержимое документа «${doc.title}» будет полностью заменено.\n`
            + `Текущий текст (${len} символов) и всё его оформление будут потеряны.`;
        }
        default: return null;
      }
    } catch {
      return null;
    }
  }

  /** Сколько строк попадёт под excel_delete_rows — по тем же правилам, что и удаление. */
  private aiCountRowsToDelete(sheet: SheetData, a: any): number | null {
    if (Array.isArray(a?.rows) && a.rows.length) {
      return a.rows.filter((r: number) => r >= 1 && r <= sheet.data.length).length;
    }
    if (a?.column && a?.value_filter != null) {
      const c = this.aiResolveCol(sheet, String(a.column));
      if (c < 0) return null;
      const pred = this.aiCriteria(String(a.value_filter));
      const start = a.skipHeader === false ? 0 : 1;
      let n = 0;
      for (let r = start; r < sheet.data.length; r++) {
        if (pred(this.aiCellText(sheet, r, c))) n++;
      }
      return n;
    }
    return null;
  }


  private aiDocsRename(a: { renames: Array<{ id?: string; name?: string; newName: string }> }): AiActionResult {
    if (!Array.isArray(a?.renames) || !a.renames.length) throw new Error('Не указаны документы для переименования (renames).');
    const done: string[] = [];
    const notFound: string[] = [];
    for (const r of a.renames) {
      const newName = (r.newName ?? '').trim();
      if (!newName) continue;
      let doc: DocItem | undefined;
      if (r.id) {
        doc = this.docs.find(d => d.id === r.id);
      } else if (r.name) {
        const low = r.name.trim().toLowerCase();
        doc = this.docs.find(d => d.title.trim().toLowerCase().includes(low));
      }
      if (!doc) { notFound.push(r.name ?? r.id ?? '?'); continue; }
      const old = doc.title;
      doc.title = newName;
      doc.updated_at = Date.now();
      done.push(`«${old}» → «${newName}»`);
    }
    if (done.length > 0) {
      this.save();
      this.render();
    }
    const notFoundStr = notFound.length ? ` Не найдены: ${notFound.join(', ')}.` : '';
    if (!done.length) throw new Error(`Ни один документ не переименован.${notFoundStr}`);
    return { summary: `Переименовано: ${done.join(', ')}.${notFoundStr}` };
  }


  private aiDocsClearContent(a: { docIds: string[] | 'all' }): AiActionResult {
    const targets = a?.docIds === 'all' ? [...this.docs] : this.docs.filter(d => (a.docIds as string[]).includes(d.id));
    if (!targets.length) throw new Error('Документы не найдены. Проверь id через describe().');
    const snapshots = targets.map(d => ({ docId: d.id, before: d.content }));
    for (const doc of targets) {
      if (doc.type === 'word') {
        this.updateContent(doc.id, '');
      } else {
        const ec = this.parseExcelContent(doc.content);
        for (const sh of ec.sheets) {
          sh.data = sh.data.map(row => row.map(() => ({ v: '' } as CellData)));
        }
        this.updateContent(doc.id, this.serializeExcel(ec));
      }
    }
    this.render();
    return {
      summary: `Очищено документов: ${targets.length} — ${targets.map(d => `«${d.title}»`).join(', ')}.`,
      undo: { kind: 'docs_multi', payload: { snapshots }, label: 'Отменить очистку' },
    };
  }

  // ── Range / rows AI actions ─────────────────────────────────────────────────






  // ── Sheet management AI actions ─────────────────────────────────────────────





  // ═══════════════════════════ ИИ: правка таблиц ═══════════════════════════
  //
  // Все правки идут через те же операции модели, что и интерфейс (sheetOps):
  // вставка/удаление строк сдвигает объединения и формулы, значения
  // распознаются как при вводе руками (число остаётся числом, а не текстом).

  /** Лист для действия: по имени (или активный); create — создать, если нет. */
  private aiTarget(name?: string, create = false): { ec: ExcelContent; sheet: SheetData; idx: number; doc: DocItem } {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    const ec = this.parseExcelContent(doc.content);
    if (!name) {
      const idx = Math.min(this.activeSheetIdx, ec.sheets.length - 1);
      return { ec, sheet: ec.sheets[idx], idx, doc };
    }
    const low = String(name).trim().toLowerCase();
    let idx = ec.sheets.findIndex(s => s.name.toLowerCase() === low);
    if (idx < 0 && /^\d+$/.test(low)) idx = +low - 1 < ec.sheets.length ? +low - 1 : -1;
    if (idx < 0) {
      if (!create) throw new Error(`Лист «${name}» не найден. Есть: ${ec.sheets.map(s => `«${s.name}»`).join(', ')}`);
      ec.sheets.push({ name: uniqueSheetName(ec, String(name).trim()), data: Array.from({ length: XL_ROWS }, () => Array.from({ length: XL_COLS }, () => ({ v: '' } as CellData))) });
      idx = ec.sheets.length - 1;
    }
    return { ec, sheet: ec.sheets[idx], idx, doc };
  }

  /** Значение от ассистента → ячейка: числа, даты, формулы распознаются как при вводе. */
  private aiValue(v: unknown, prev?: CellData): CellData {
    if (typeof v === 'number' && isFinite(v)) return { ...(prev?.s ? { s: prev.s } : {}), v: String(v), t: 'n', ...(prev?.nf ? { nf: prev.nf } : {}) };
    if (typeof v === 'boolean') return { ...(prev?.s ? { s: prev.s } : {}), v: v ? 'ИСТИНА' : 'ЛОЖЬ', t: 'b' };
    if (v === null || v === undefined) return { v: '', ...(prev?.s ? { s: prev.s } : {}) };
    return interpretInput(String(v), prev);
  }

  /** Диапазон «A1:D10» / «B3» / «all» → прямоугольник в пределах листа. */
  private aiRange(sheet: SheetData, ref: string | undefined, opts: { clamp?: boolean } = {}): MergeRange {
    const lastRow = Math.max(sheet.data.length - 1, 0);
    const lastCol = Math.max(...sheet.data.map(r => r.length), 1) - 1;
    if (ref === 'all') return { r1: 0, c1: 0, r2: lastRow, c2: lastCol };
    if (!ref) throw new Error('Не указан диапазон. Передай range вида "A1:D10", либо "all" для всего листа.');
    const rg = parseRangeRef(String(ref).replace(/^.*!/, ''));
    if (!rg) {
      // Колонки целиком: «B:D»
      const m = String(ref).toUpperCase().match(/^([A-Z]+):([A-Z]+)$/);
      if (m) return { r1: 0, c1: this.letterToCol(m[1]), r2: lastRow, c2: this.letterToCol(m[2]) };
      throw new Error(`Неверный формат диапазона: ${ref}. Пример: "A1:D10" или "all"`);
    }
    if (opts.clamp) {
      const out = { r1: rg.r1, c1: rg.c1, r2: Math.min(rg.r2, lastRow), c2: Math.min(rg.c2, lastCol) };
      if (out.r2 < out.r1 || out.c2 < out.c1) throw new Error(`Диапазон ${ref} целиком за пределами листа (${this.colLetter(lastCol)}${lastRow + 1}).`);
      return out;
    }
    return rg;
  }

  /** Оформление от ассистента → изменение стиля ячейки. */
  private aiStyleMutator(a: {
    bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean; color?: string; bg?: string;
    align?: string; valign?: string; wrap?: boolean; fontSize?: number; fontName?: string; indent?: number;
  }): ((x: XStyle) => void) | null {
    const hex = (v?: string) => (v && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v) ? (v.startsWith('#') ? v : '#' + v).toLowerCase() : undefined);
    const ops: Array<(x: XStyle) => void> = [];
    const font = (k: 'bold' | 'italic' | 'strike', on?: boolean) => { if (on !== undefined) ops.push(x => { x.font = { ...(x.font ?? {}) }; if (on) x.font[k] = true; else delete x.font[k]; }); };
    font('bold', a.bold); font('italic', a.italic); font('strike', a.strikethrough);
    if (a.underline !== undefined) ops.push(x => { x.font = { ...(x.font ?? {}) }; if (a.underline) x.font.underline = 'single'; else delete x.font.underline; });
    if (a.color !== undefined) { const c = hex(a.color); ops.push(x => { x.font = { ...(x.font ?? {}) }; if (c) x.font.color = c; else delete x.font.color; }); }
    if (a.bg !== undefined) { const c = hex(a.bg); ops.push(x => { if (c) { x.fill = c; delete x.pattern; } else { delete x.fill; delete x.pattern; } }); }
    if (a.fontSize) ops.push(x => { x.font = { ...(x.font ?? {}), size: Math.max(1, Math.min(409, +a.fontSize!)) }; });
    if (a.fontName) ops.push(x => { x.font = { ...(x.font ?? {}), name: String(a.fontName) }; });
    if (a.align && ['left', 'center', 'right', 'justify'].includes(a.align)) ops.push(x => { x.align = { ...(x.align ?? {}), h: a.align as 'left' }; });
    if (a.valign && ['top', 'middle', 'center', 'bottom'].includes(a.valign)) ops.push(x => { x.align = { ...(x.align ?? {}) }; if (a.valign === 'bottom') delete x.align.v; else x.align.v = a.valign === 'center' ? 'middle' : a.valign as 'top'; });
    if (a.wrap !== undefined) ops.push(x => { x.align = { ...(x.align ?? {}) }; if (a.wrap) x.align.wrap = true; else delete x.align.wrap; });
    if (a.indent !== undefined) ops.push(x => { x.align = { ...(x.align ?? {}) }; if (a.indent) x.align.indent = Math.max(0, Math.min(15, +a.indent!)); else delete x.align.indent; });
    return ops.length ? (x => ops.forEach(op => op(x))) : null;
  }

  /** Рамки диапазона от ассистента. */
  private aiBorders(sheet: SheetData, rg: MergeRange, kind: string, color = '#000000'): void {
    const b = (style: 'thin' | 'medium') => ({ style, color });
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sheet.data[r][c];
      const s = editCss(cell.s, x => {
        const brd = { ...(x.border ?? {}) };
        const top = r === rg.r1, bottom = r === rg.r2, left = c === rg.c1, right = c === rg.c2;
        if (kind === 'none') { delete x.border; return; }
        if (kind === 'all') { brd.top = brd.bottom = brd.left = brd.right = b('thin'); }
        if (kind === 'outer' || kind === 'thick') { const st = kind === 'thick' ? 'medium' : 'thin'; if (top) brd.top = b(st); if (bottom) brd.bottom = b(st); if (left) brd.left = b(st); if (right) brd.right = b(st); }
        if (kind === 'bottom' && bottom) brd.bottom = b('thin');
        if (kind === 'top' && top) brd.top = b('thin');
        x.border = brd;
      });
      if (s) cell.s = s; else delete cell.s;
    }
  }

  private aiExcelReplace(a: { find: string; replaceWith: string; exceptColumns?: string[]; caseSensitive?: boolean; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    if (!a?.find) throw new Error('Не указано, что заменять (find)');
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const repl = a.replaceWith ?? '';
    const skip = new Set<number>(this.aiArticleCols(sheet));
    const skippedNames: string[] = this.aiArticleCols(sheet).map(i => this.colLetter(i));
    for (const ref of (a.exceptColumns ?? [])) {
      const idx = this.aiResolveCol(sheet, ref);
      if (idx >= 0) { skip.add(idx); skippedNames.push(this.colLetter(idx)); }
    }
    const re = new RegExp(this.escRe(a.find), a.caseSensitive ? 'g' : 'gi');
    let count = 0;
    for (const row of sheet.data) {
      for (let c = 0; c < row.length; c++) {
        if (skip.has(c)) continue;
        const cell = row[c];
        if (!cell?.v) continue;
        re.lastIndex = 0;
        if (!re.test(cell.v)) continue;
        re.lastIndex = 0;
        const next = cell.v.replace(re, repl);
        if (next === cell.v) continue;
        row[c] = next.startsWith('=') ? { ...cell, v: next } : this.aiValue(next, cell);
        count++;
      }
    }
    this.aiPersist(doc, ec);
    const skipStr = skippedNames.length ? ` Пропущены колонки: ${[...new Set(skippedNames)].join(', ')}.` : '';
    return this.docsResult(doc.id, before, `Заменено вхождений: ${count} («${a.find}» → «${repl}»).${skipStr}`, 'Отменить замену');
  }

  private aiExcelSetCell(a: { cell: string; value: unknown; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const p = parseRangeRef(String(a?.cell ?? '').replace(/^.*!/, ''));
    if (!p) throw new Error('Некорректная ячейка (ожидается формат "B3")');
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    ensureSize(sheet, p.r1 + 1, p.c1 + 1);
    sheet.data[p.r1][p.c1] = this.aiValue(a.value, sheet.data[p.r1][p.c1]);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Ячейка ${this.colLetter(p.c1)}${p.r1 + 1} = «${a.value ?? ''}».`, 'Отменить изменение ячейки');
  }

  /** Совместимость со старым API: склеить CSS ячейки с добавкой через модель стилей. */
  mergeCellCss(existing: string | undefined, added: string): string {
    return normalizeCss((existing ?? '') + ';' + added);
  }

  private aiExcelStyleColumn(a: { column: string; bold?: boolean; italic?: boolean; bg?: string; color?: string; align?: string; numFormat?: string; width?: number | 'auto'; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const idx = this.aiResolveCol(sheet, a?.column ?? '');
    if (idx < 0) throw new Error(`Колонка «${a?.column}» не найдена`);
    const mut = this.aiStyleMutator(a);
    if (!mut && !a.numFormat && !a.width) throw new Error('Не заданы параметры оформления');
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    let n = 0;
    for (const row of sheet.data) {
      while (row.length <= idx) row.push({ v: '' });
      if (mut) { const s = editCss(row[idx].s, mut); if (s) row[idx].s = s; else delete row[idx].s; }
      if (a.numFormat && row[idx].t === 'n') row[idx].nf = a.numFormat;
      n++;
    }
    if (a.width) this.aiSetWidth(sheet, idx, a.width);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Оформлена колонка ${this.colLetter(idx)} (${n} ячеек).`, 'Отменить оформление');
  }

  private aiSetWidth(sheet: SheetData, c: number, width: number | 'auto'): void {
    const arr = sheet.colWidths ? [...sheet.colWidths] : [];
    while (arr.length <= c) arr.push(null);
    if (width === 'auto') {
      let max = 0;
      for (let r = 0; r < Math.min(sheet.data.length, 3000); r++) {
        const cell = sheet.data[r]?.[c];
        if (!cell?.v) continue;
        const t = cell.v.startsWith('=') ? '0000000000' : formatCellValue(cell.v, cell.t, cell.nf);
        const bold = /font-weight:bold/.test(cell.s ?? '') ? 1.1 : 1;
        max = Math.max(max, Math.min(60, t.length) * 7.2 * bold + 14);
      }
      arr[c] = max ? Math.max(40, Math.round(max)) : null;
    } else arr[c] = Math.max(16, Math.min(1200, Math.round(+width)));
    sheet.colWidths = arr;
  }

  private aiStyleRange(a: {
    range: string; sheet?: string; bold?: boolean; italic?: boolean; underline?: boolean; strikethrough?: boolean;
    color?: string; bg?: string; align?: string; valign?: string; wrap?: boolean; fontSize?: number; fontName?: string;
    numFormat?: string; border?: string; borderColor?: string; merge?: boolean;
  }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const rg = this.aiRange(sheet, a?.range, { clamp: true });
    const mut = this.aiStyleMutator(a);
    if (!mut && !a.numFormat && !a.border && a.merge === undefined) throw new Error('Не заданы параметры оформления');
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    ensureSize(sheet, rg.r2 + 1, rg.c2 + 1);
    let count = 0;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sheet.data[r][c];
      if (mut) { const s = editCss(cell.s, mut); if (s) cell.s = s; else delete cell.s; }
      if (a.numFormat) {
        if (a.numFormat === 'General') delete cell.nf; else cell.nf = a.numFormat;
        if (cell.t !== 'n' && cell.v && !cell.v.startsWith('=')) { const n = parseUserNumber(cell.v); if (n !== null) { cell.v = String(n); cell.t = 'n'; } }
      }
      count++;
    }
    if (a.border) this.aiBorders(sheet, rg, a.border, a.borderColor && /^#[0-9a-f]{6}$/i.test(a.borderColor) ? a.borderColor : '#000000');
    if (a.merge === true) mergeRange(sheet, rg);
    if (a.merge === false && sheet.merges) sheet.merges = sheet.merges.filter(m => m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2);
    this.aiPersist(doc, ec);
    const rangeStr = a.range === 'all' ? 'весь лист' : rangeToRef(rg);
    return this.docsResult(doc.id, before, `Применено оформление к ${count} ячейкам (${rangeStr}).`, 'Отменить оформление');
  }

  /** Текущее выделение в таблице (то, что пользователь выделил мышью). */
  private aiSelection(): { ec: ExcelContent; sheet: SheetData; doc: DocItem; rg: MergeRange } {
    if (!this.xlLastSel) throw new Error('Нет активного выделения ячеек. Сначала выдели ячейки в таблице.');
    const { r1, c1, r2, c2, docId, sheetIdx } = this.xlLastSel;
    const doc = this.docs.find(d => d.id === docId);
    if (!doc) throw new Error('Документ не найден');
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[sheetIdx] ?? ec.sheets[0];
    if (!sheet) throw new Error('Лист не найден');
    const lastRow = Math.max(sheet.data.length - 1, 0), lastCol = Math.max(...sheet.data.map(r => r.length), 1) - 1;
    const rg = { r1: Math.max(0, r1), c1: Math.max(0, c1), r2: Math.min(r2, lastRow), c2: Math.min(c2, lastCol) };
    if (rg.r2 < rg.r1 || rg.c2 < rg.c1) throw new Error('Выделение больше не соответствует листу — выдели ячейки заново.');
    return { ec, sheet, doc, rg };
  }

  private aiStyleSelection(a: Parameters<DocsModule['aiStyleRange']>[0] extends infer T ? Omit<T & object, 'range' | 'sheet'> : never): AiActionResult {
    const { ec, sheet, doc, rg } = this.aiSelection();
    const mut = this.aiStyleMutator(a);
    if (!mut && !a.numFormat && !a.border) throw new Error('Не заданы параметры оформления');
    this.pushXlUndo(doc.id, this.xlLastSel!.sheetIdx);
    const before = doc.content;
    ensureSize(sheet, rg.r2 + 1, rg.c2 + 1);
    let count = 0;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sheet.data[r][c];
      if (mut) { const s = editCss(cell.s, mut); if (s) cell.s = s; else delete cell.s; }
      if (a.numFormat) cell.nf = a.numFormat;
      count++;
    }
    if (a.border) this.aiBorders(sheet, rg, a.border);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Применено оформление к ${count} ячейкам (${rangeToRef(rg)}).`, 'Отменить оформление');
  }

  private aiClearSelection(): AiActionResult {
    const { ec, sheet, doc, rg } = this.aiSelection();
    this.pushXlUndo(doc.id, this.xlLastSel!.sheetIdx);
    const before = doc.content;
    let count = 0;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sheet.data[r]?.[c];
      if (cell?.v) { sheet.data[r][c] = { v: '', ...(cell.s ? { s: cell.s } : {}), ...(cell.nf ? { nf: cell.nf } : {}) }; count++; }
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Очищено ${count} ячеек (${rangeToRef(rg)}).`, 'Отменить очистку');
  }

  private aiFillSelection(a: { value: unknown }): AiActionResult {
    const { ec, sheet, doc, rg } = this.aiSelection();
    this.pushXlUndo(doc.id, this.xlLastSel!.sheetIdx);
    const before = doc.content;
    ensureSize(sheet, rg.r2 + 1, rg.c2 + 1);
    let count = 0;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      sheet.data[r][c] = this.aiValue(a?.value, sheet.data[r][c]);
      count++;
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Заполнено ${count} ячеек значением «${a?.value ?? ''}» (${rangeToRef(rg)}).`, 'Отменить заполнение');
  }

  private aiClearStyleSelection(): AiActionResult {
    const { ec, sheet, doc, rg } = this.aiSelection();
    this.pushXlUndo(doc.id, this.xlLastSel!.sheetIdx);
    const before = doc.content;
    let count = 0;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
      const cell = sheet.data[r]?.[c];
      if (cell && (cell.s || cell.nf)) { delete cell.s; count++; }
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Снято оформление с ${count} ячеек (${rangeToRef(rg)}).`, 'Отменить сброс стилей');
  }

  /**
   * «Улучши дизайн»: шапка акцентным цветом, чередование строк, тонкие рамки,
   * формат чисел, ширины по содержимому, закреплённая шапка и фильтр.
   * Раньше действие стирало всё оформление листа и красило полупрозрачным
   * цветом, который в Excel превращался в чёрный.
   */
  private aiExcelImproveDesign(a: { accent?: string; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const accent = (a?.accent && /^#[0-9a-fA-F]{6}$/.test(a.accent)) ? a.accent.toLowerCase() : '#2f5496';
    const light = (() => { const h = accent.slice(1); const ch = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * 0.12 + 255 * 0.88).toString(16).padStart(2, '0'); return '#' + ch(0) + ch(2) + ch(4); })();
    // Используемая область
    let lastRow = -1, lastCol = -1;
    sheet.data.forEach((row, r) => row.forEach((c, ci) => { if (c.v) { lastRow = Math.max(lastRow, r); lastCol = Math.max(lastCol, ci); } }));
    if (lastRow < 0) throw new Error('Лист пуст — оформлять нечего');
    const firstRow = sheet.data.findIndex(row => row.some(c => c.v));
    for (let r = firstRow; r <= lastRow; r++) for (let c = 0; c <= lastCol; c++) {
      const cell = sheet.data[r][c];
      const isHead = r === firstRow;
      const s = editCss(cell.s, x => {
        const thin = { style: 'thin' as const, color: '#bfbfbf' };
        x.border = { top: thin, bottom: thin, left: thin, right: thin };
        if (isHead) {
          x.fill = accent; x.font = { ...(x.font ?? {}), bold: true, color: '#ffffff' };
          x.align = { ...(x.align ?? {}), h: 'center', v: 'middle', wrap: true };
        } else {
          if ((r - firstRow) % 2 === 0) x.fill = light; else delete x.fill;
          if (x.font?.color === '#ffffff') delete x.font.color;
        }
      });
      if (s) cell.s = s;
      if (!isHead && cell.t === 'n' && !cell.nf) {
        const n = Number(cell.v);
        if (isFinite(n) && !Number.isInteger(n)) cell.nf = '#,##0.00';
        else if (isFinite(n) && Math.abs(n) >= 10000) cell.nf = '#,##0';
      }
    }
    for (let c = 0; c <= lastCol; c++) this.aiSetWidth(sheet, c, 'auto');
    const rh = sheet.rowHeights ? [...sheet.rowHeights] : [];
    while (rh.length <= firstRow) rh.push(null);
    rh[firstRow] = Math.max(rh[firstRow] ?? 0, 30);
    sheet.rowHeights = rh;
    sheet.freeze = { rows: firstRow + 1, cols: sheet.freeze?.cols ?? 0 };
    sheet.autoFilter = rangeToRef({ r1: firstRow, c1: 0, r2: lastRow, c2: lastCol });
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Дизайн обновлён: шапка (${accent}), чередование строк, рамки, ширины колонок, закреплена шапка и включён фильтр. Строк: ${lastRow - firstRow + 1}.`, 'Отменить дизайн');
  }

  /** Публичный метод для прямой записи ячейки Excel по docId (используется в export_analytics_report). */
  aiExcelCommand(docId: string, _cmd: 'set_cell', args: { row: number; col: number; value: string | number }): void {
    const doc = this.docs.find(d => d.id === docId);
    if (!doc || doc.type !== 'excel') return;
    const ec = this.parseExcelContent(doc.content);
    const sheet = ec.sheets[0];
    if (!sheet) return;
    ensureSize(sheet, args.row + 1, args.col + 1);
    sheet.data[args.row][args.col] = this.aiValue(args.value, sheet.data[args.row][args.col]);
    this.updateContent(docId, this.serializeExcel(ec));
    if (this.root.style.display !== 'none' && docId === this.activeId) this.render();
  }

  private aiExcelInsertColumn(a: { after?: string; before?: string; header?: string; sheet?: string }): AiActionResult {
    const { ec, sheet, idx, doc } = this.aiTarget(a?.sheet);
    let insertAt: number;
    if (a?.after != null) {
      const ci = this.aiResolveCol(sheet, String(a.after));
      if (ci < 0) throw new Error(`Колонка «${a.after}» не найдена`);
      insertAt = ci + 1;
    } else if (a?.before != null) {
      const ci = this.aiResolveCol(sheet, String(a.before));
      if (ci < 0) throw new Error(`Колонка «${a.before}» не найдена`);
      insertAt = ci;
    } else {
      insertAt = 0;
      sheet.data.forEach(row => row.forEach((c, ci) => { if (c.v && ci + 1 > insertAt) insertAt = ci + 1; }));
    }
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    shiftSheet(ec, idx, 'col', insertAt, 1);
    if (a?.header) {
      ensureSize(sheet, 1, insertAt + 1);
      const ref = sheet.data[0][insertAt - 1] ?? sheet.data[0][insertAt + 1];
      sheet.data[0][insertAt] = { v: a.header, ...(ref?.s ? { s: ref.s } : {}) };
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Вставлена новая колонка ${this.colLetter(insertAt)}${a?.header ? ` «${a.header}»` : ''}.`, 'Отменить вставку колонки');
  }

  private aiExcelAddToColumn(a: {
    column: string; delta: number; percent?: boolean;
    rows?: number[] | 'all'; skipHeader?: boolean; round?: number; sheet?: string;
  }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const ci = this.aiResolveCol(sheet, String(a?.column ?? ''));
    if (ci < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    const delta = Number(a?.delta ?? 0);
    if (isNaN(delta)) throw new Error('delta должна быть числом');
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const roundTo = a?.round ?? 2;
    const startRow = a?.skipHeader !== false ? 1 : 0;
    const targetRows: number[] = (!a?.rows || a.rows === 'all')
      ? Array.from({ length: Math.max(0, sheet.data.length - startRow) }, (_, i) => i + startRow)
      : (a.rows as number[]).map(r => r - 1);
    let changed = 0;
    for (const ri of targetRows) {
      const cell = sheet.data[ri]?.[ci];
      if (!cell?.v || cell.v.startsWith('=')) continue;
      const num = cell.t === 'n' ? Number(cell.v) : parseUserNumber(cell.v);
      if (num === null || isNaN(num)) continue;
      const newVal = a?.percent ? num * (1 + delta / 100) : num + delta;
      const rounded = Math.round(newVal * Math.pow(10, roundTo)) / Math.pow(10, roundTo);
      sheet.data[ri][ci] = { ...cell, v: String(rounded), t: 'n' };
      changed++;
    }
    if (!changed) return { summary: `В колонке «${a.column}» не найдено числовых ячеек для изменения.` };
    this.aiPersist(doc, ec);
    const op = a?.percent ? `${delta > 0 ? '+' : ''}${delta}%` : `${delta > 0 ? '+' : ''}${delta}`;
    return this.docsResult(doc.id, before, `Колонка «${a.column}»: изменено ${changed} ячеек (${op}).`, 'Отменить изменение чисел');
  }

  /**
   * Записать блок значений. Числа остаются числами, «=…» — формулами
   * (в том числе со ссылками на другие листы: ='Продажи'!B2 или =СУММ(Продажи!C:C)).
   * sheet — лист по имени; createSheet — создать его, если нет.
   */
  private aiExcelSetRange(a: { range?: string; start?: string; values: unknown[][]; sheet?: string; createSheet?: boolean; header?: boolean }): AiActionResult {
    const { ec, sheet, idx, doc } = this.aiTarget(a?.sheet, !!a?.createSheet);
    const vals = Array.isArray(a?.values) ? a.values.map(r => Array.isArray(r) ? r : [r]) : null;
    if (!vals || !vals.length) throw new Error('values должен быть двумерным массивом: [["Месяц","Выручка"],["Январь",120000]]');
    const anchor = parseRangeRef(String(a.start ?? a.range ?? 'A1').replace(/^.*!/, ''));
    if (!anchor) throw new Error('Некорректный адрес — ожидается "A1" или "A1:C3"');
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const h = vals.length, w = Math.max(...vals.map(r => r.length));
    ensureSize(sheet, anchor.r1 + h, anchor.c1 + w);
    let filled = 0;
    vals.forEach((row, dr) => row.forEach((v, dc) => {
      const r = anchor.r1 + dr, c = anchor.c1 + dc;
      sheet.data[r][c] = this.aiValue(v, sheet.data[r][c]);
      filled++;
    }));
    if (a.header) {
      for (let c = anchor.c1; c < anchor.c1 + w; c++) {
        const cell = sheet.data[anchor.r1][c];
        const s = editCss(cell.s, x => { x.font = { ...(x.font ?? {}), bold: true }; x.fill = x.fill ?? '#d9e1f2'; });
        if (s) cell.s = s;
      }
    }
    if (idx !== this.activeSheetIdx) this.activeSheetIdx = idx;
    this.aiPersist(doc, ec);
    const ref = rangeToRef({ r1: anchor.r1, c1: anchor.c1, r2: anchor.r1 + h - 1, c2: anchor.c1 + w - 1 });
    return this.docsResult(doc.id, before, `Лист «${sheet.name}», ${ref}: записано ${filled} ячеек.`, 'Отменить заполнение диапазона');
  }

  private aiExcelDeleteRows(a: { rows?: number[]; column?: string; value_filter?: string; skipHeader?: boolean; sheet?: string }): AiActionResult {
    const { ec, sheet, idx, doc } = this.aiTarget(a?.sheet);
    const skip = a?.skipHeader !== false;
    let toDelete: number[];
    if (Array.isArray(a?.rows) && a.rows.length > 0) {
      toDelete = a.rows.map(r => r - 1).filter(r => r >= 0 && r < sheet.data.length);
    } else if (a?.column) {
      const colIdx = this.aiResolveCol(sheet, a.column);
      if (colIdx < 0) throw new Error(`Колонка «${a.column}» не найдена`);
      let pred: (v: string) => boolean;
      if (a.value_filter == null) pred = () => true;
      else if (/^(<=|>=|<>|=|<|>)/.test(a.value_filter) || /[*?]/.test(a.value_filter)) pred = this.aiCriteria(a.value_filter);
      else { let re: RegExp; try { re = new RegExp(a.value_filter, 'i'); } catch { re = new RegExp(this.escRe(a.value_filter), 'i'); } pred = (v) => re.test(v); }
      toDelete = [];
      sheet.data.forEach((_row, ri) => {
        if (skip && ri === 0) return;
        if (pred(this.aiCellText(sheet, ri, colIdx).trim())) toDelete.push(ri);
      });
    } else {
      toDelete = [];
      sheet.data.forEach((row, ri) => { if (skip && ri === 0) return; if (row.every(c => !(c.v ?? '').trim())) toDelete.push(ri); });
      // Хвост пустых строк в конце листа удалять незачем — это просто сетка
      let last = sheet.data.length - 1;
      while (last >= 0 && sheet.data[last].every(c => !(c.v ?? '').trim())) last--;
      toDelete = toDelete.filter(r => r <= last);
    }
    if (!toDelete.length) return { summary: 'Подходящих строк не найдено — ничего не удалено.' };
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    // Снизу вверх, чтобы индексы не сдвигались
    for (const r of [...new Set(toDelete)].sort((x, y) => y - x)) shiftSheet(ec, idx, 'row', r, -1);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Удалено строк: ${new Set(toDelete).size}.`, 'Отменить удаление строк');
  }

  private aiExcelInsertRows(a: { at: number; count?: number; sheet?: string }): AiActionResult {
    const { ec, idx, doc } = this.aiTarget(a?.sheet);
    const at = Math.max(0, (a?.at ?? 1) - 1);
    const count = Math.max(1, Math.min(a?.count ?? 1, 1000));
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    shiftSheet(ec, idx, 'row', at, count);
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Вставлено ${count} пустых строк перед строкой ${a.at}.`, 'Отменить вставку строк');
  }

  private aiExcelSortSheet(a: { column: string; order?: string; hasHeader?: boolean; numeric?: boolean; sheet?: string; thenBy?: string; thenOrder?: string }): AiActionResult {
    const { ec, sheet, doc, idx } = this.aiTarget(a?.sheet);
    if (!a?.column) throw new Error('Не указана колонка для сортировки (column)');
    const colIdx = this.aiResolveCol(sheet, a.column);
    if (colIdx < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    const keys = [{ col: colIdx, desc: (a.order ?? 'asc') === 'desc' }];
    if (a.thenBy) { const c2 = this.aiResolveCol(sheet, a.thenBy); if (c2 >= 0) keys.push({ col: c2, desc: (a.thenOrder ?? 'asc') === 'desc' }); }
    let last = sheet.data.length - 1;
    while (last > 0 && sheet.data[last].every(c => !c.v)) last--;
    const width = Math.max(...sheet.data.map(r => r.length));
    const r1 = a.hasHeader !== false ? 1 : 0;
    if (last <= r1) return { summary: 'Сортировать нечего — в таблице нет строк данных.' };
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    const ev = this.bookEvaluator(ec, idx);
    sortRows(sheet, { r1, c1: 0, r2: last, c2: width - 1 }, keys, (r, c) => {
      const cell = sheet.data[r]?.[c];
      if (!cell?.v) return { text: '', num: null };
      if (cell.v.startsWith('=')) { const v = ev.cellValue(r, c); return { text: typeof v === 'object' ? '' : String(v), num: typeof v === 'number' ? v : null }; }
      const num = cell.t === 'n' ? Number(cell.v) : (a.numeric ? parseUserNumber(cell.v) : null);
      return { text: cell.v, num };
    });
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Таблица отсортирована по «${a.column}» ${keys[0].desc ? 'по убыванию' : 'по возрастанию'} (${last - r1 + 1} строк).`, 'Отменить сортировку');
  }

  private aiExcelFormulaColumn(a: { column: string; formula: string; fromRow?: number; toRow?: number; header?: string; sheet?: string; numFormat?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    if (!a?.column) throw new Error('Не указана колонка (column)');
    if (!a?.formula) throw new Error('Не указан шаблон формулы (formula)');
    let colIdx = this.aiResolveCol(sheet, a.column);
    if (colIdx < 0 && /^[A-Za-z]{1,3}$/.test(a.column)) colIdx = this.letterToCol(a.column);
    if (colIdx < 0) throw new Error(`Колонка «${a.column}» не найдена`);
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const before = doc.content;
    let lastData = 0;
    sheet.data.forEach((row, r) => { if (row.some((c, ci) => ci !== colIdx && c.v)) lastData = r; });
    const fromRow = (a.fromRow ?? 2) - 1;
    const toRow = (a.toRow ?? lastData + 1) - 1;
    ensureSize(sheet, toRow + 1, colIdx + 1);
    let filled = 0;
    for (let r = fromRow; r <= toRow; r++) {
      const f = a.formula.replace(/\{r\}/g, String(r + 1));
      sheet.data[r][colIdx] = { ...sheet.data[r][colIdx], v: f.startsWith('=') ? f : '=' + f, ...(a.numFormat ? { nf: a.numFormat } : {}) };
      filled++;
    }
    if (a.header) sheet.data[0][colIdx] = { ...sheet.data[0][colIdx], v: a.header };
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Формула «${a.formula}» заполнена в ${filled} ячеек колонки ${this.colLetter(colIdx)}.`, 'Отменить формулы');
  }

  // ── Листы ───────────────────────────────────────────────────────────────

  private aiExcelAddSheet(a: { name?: string; switchTo?: boolean }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    const ec = this.parseExcelContent(doc.content);
    const wanted = (a?.name ?? '').trim();
    if (wanted && ec.sheets.some(sh => sh.name.toLowerCase() === wanted.toLowerCase())) {
      const i = ec.sheets.findIndex(sh => sh.name.toLowerCase() === wanted.toLowerCase());
      this.activeSheetIdx = i; this.render();
      return { summary: `Лист «${ec.sheets[i].name}» уже есть — переключилась на него.` };
    }
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const name = wanted ? uniqueSheetName(ec, wanted) : nextSheetName(ec);
    ec.sheets.push({ name, data: Array.from({ length: XL_ROWS }, () => Array.from({ length: XL_COLS }, () => ({ v: '' } as CellData))) });
    if (a?.switchTo !== false) this.activeSheetIdx = ec.sheets.length - 1;
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Добавлен лист «${name}» (всего листов: ${ec.sheets.length}).`, 'Удалить добавленный лист');
  }

  private aiExcelSwitchSheet(a: { name?: string; index?: number }): AiActionResult {
    const doc = this.aiDoc();
    if (!doc || doc.type !== 'excel') throw new Error('Сейчас открыт не Excel-документ');
    const ec = this.parseExcelContent(doc.content);
    let i = -1;
    if (a?.name) i = ec.sheets.findIndex(s => s.name.toLowerCase() === String(a.name).trim().toLowerCase());
    if (i < 0 && a?.name) i = ec.sheets.findIndex(s => s.name.toLowerCase().includes(String(a.name).trim().toLowerCase()));
    if (i < 0 && a?.index) i = +a.index - 1;
    if (i < 0 || i >= ec.sheets.length) throw new Error(`Лист не найден. Есть: ${ec.sheets.map(s => `«${s.name}»`).join(', ')}`);
    this.activeSheetIdx = i;
    this.render();
    return { summary: `Открыт лист «${ec.sheets[i].name}».` };
  }

  private aiExcelRenameSheet(a: { from?: string; to: string }): AiActionResult {
    const { ec, sheet, idx, doc } = this.aiTarget(a?.from);
    const to = (a?.to ?? '').trim();
    if (!to) throw new Error('Не указано новое название листа (to)');
    if (ec.sheets.some((s, i) => i !== idx && s.name.toLowerCase() === to.toLowerCase())) throw new Error(`Лист «${to}» уже есть`);
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const old = sheet.name;
    renameSheetOp(ec, idx, to.slice(0, 31));
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Лист «${old}» переименован в «${sheet.name}» (ссылки в формулах обновлены).`, 'Вернуть старое имя');
  }

  private aiExcelDeleteSheet(a: { name?: string }): AiActionResult {
    const { ec, sheet, idx, doc } = this.aiTarget(a?.name);
    if (ec.sheets.length <= 1) throw new Error('Нельзя удалить последний лист');
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    ec.sheets.splice(idx, 1);
    if (this.activeSheetIdx >= ec.sheets.length) this.activeSheetIdx = ec.sheets.length - 1;
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Лист «${sheet.name}» удалён. Осталось листов: ${ec.sheets.length}.`, 'Вернуть лист');
  }

  private aiExcelCopySheet(a: { from?: string; newName?: string }): AiActionResult {
    const { ec, sheet, idx, doc } = this.aiTarget(a?.from);
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const name = uniqueSheetName(ec, (a?.newName ?? '').trim() || `${sheet.name} (2)`);
    ec.sheets.splice(idx + 1, 0, cloneSheet(sheet, name));
    this.activeSheetIdx = idx + 1;
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Лист «${sheet.name}» скопирован как «${name}».`, 'Удалить копию');
  }

  // ── Диаграммы, объединение, ширины, закрепление ─────────────────────────

  private aiExcelAddChart(a: { type?: string; range?: string; sheet?: string; title?: string; at?: string; targetSheet?: string; width?: number; height?: number }): AiActionResult {
    const kinds: Record<string, ChartKind> = { col: 'col', column: 'col', bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area', scatter: 'scatter', гистограмма: 'col', линейчатая: 'bar', график: 'line', круговая: 'pie', кольцевая: 'doughnut' };
    const kind = kinds[String(a?.type ?? 'col').toLowerCase()] ?? 'col';
    const src = this.aiTarget(a?.sheet);
    const rg = this.aiRange(src.sheet, a?.range, { clamp: true });
    const ev = this.bookEvaluator(src.ec, src.idx);
    const spec = buildChartFromRange(src.sheet, rg, kind, ev, a?.title);
    if (!spec) throw new Error(`В диапазоне ${a.range} нет чисел для диаграммы. Нужен блок: первая колонка — подписи, следующие — числа, первая строка — заголовки.`);
    const target = a?.targetSheet ? this.aiTarget(a.targetSheet, true) : src;
    const ec = target === src ? src.ec : target.ec;
    // Диаграмма на другом листе ссылается на данные с именем листа
    if (target.idx !== src.idx || a?.targetSheet) {
      const q = /^[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*$/.test(src.sheet.name) ? src.sheet.name : `'${src.sheet.name.replace(/'/g, "''")}'`;
      spec.series = spec.series.map(s => ({ ...s, valRef: `${q}!${s.valRef}`, ...(s.catRef ? { catRef: `${q}!${s.catRef}` } : {}), ...(s.nameRef ? { nameRef: `${q}!${s.nameRef}` } : {}) }));
      if (target.ec !== src.ec) {
        // aiTarget с create мог создать лист в другой копии книги — переносим в общую
        const tgtSheet = src.ec.sheets.find(s => s.name === target.sheet.name) ?? (src.ec.sheets.push(target.sheet), target.sheet);
        target.sheet = tgtSheet; target.idx = src.ec.sheets.indexOf(tgtSheet);
      }
    }
    const pos = a?.at ? parseRangeRef(a.at) : null;
    if (pos) { spec.r = pos.r1; spec.c = pos.c1; }
    else if (target.idx !== src.idx) { spec.r = 1; spec.c = 1; }
    if (a?.width) spec.w = Math.max(200, Math.min(1400, +a.width));
    if (a?.height) spec.h = Math.max(150, Math.min(900, +a.height));
    const doc = src.doc;
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    (target.sheet.charts ??= []).push(spec);
    this.activeSheetIdx = target.idx;
    this.aiPersist(doc, target === src ? ec : src.ec);
    const names: Record<ChartKind, string> = { col: 'гистограмма', bar: 'линейчатая', line: 'график', pie: 'круговая', doughnut: 'кольцевая', area: 'с областями', scatter: 'точечная' };
    return this.docsResult(doc.id, before, `Добавлена диаграмма (${names[kind]}${spec.title ? `, «${spec.title}»` : ''}) по данным ${src.sheet.name}!${rangeToRef(rg)} на лист «${target.sheet.name}» в ${this.colLetter(spec.c)}${spec.r + 1}. В .xlsx она выгрузится настоящей диаграммой Excel.`, 'Убрать диаграмму');
  }

  private aiExcelMerge(a: { range: string; unmerge?: boolean; center?: boolean; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const rg = this.aiRange(sheet, a?.range);
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    if (a?.unmerge) {
      if (sheet.merges) sheet.merges = sheet.merges.filter(m => m.r2 < rg.r1 || m.r1 > rg.r2 || m.c2 < rg.c1 || m.c1 > rg.c2);
    } else {
      mergeRange(sheet, rg);
      if (a?.center !== false) { const cell = sheet.data[rg.r1][rg.c1]; const s = editCss(cell.s, x => { x.align = { ...(x.align ?? {}), h: 'center', v: 'middle' }; }); if (s) cell.s = s; }
    }
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `${a?.unmerge ? 'Разъединены' : 'Объединены'} ячейки ${rangeToRef(rg)}.`, 'Отменить');
  }

  private aiExcelColumnWidth(a: { columns?: string[] | string; width?: number | 'auto'; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const list = Array.isArray(a?.columns) ? a.columns : a?.columns ? String(a.columns).split(/[,\s]+/) : ['all'];
    const cols: number[] = [];
    for (const ref of list) {
      if (ref === 'all') { const w = Math.max(...sheet.data.map(r => r.length)); for (let c = 0; c < w; c++) if (sheet.data.some(r => r[c]?.v)) cols.push(c); continue; }
      const m = ref.toUpperCase().match(/^([A-Z]+):([A-Z]+)$/);
      if (m) { for (let c = this.letterToCol(m[1]); c <= this.letterToCol(m[2]); c++) cols.push(c); continue; }
      const c = this.aiResolveCol(sheet, ref);
      if (c >= 0) cols.push(c);
    }
    if (!cols.length) throw new Error('Колонки не найдены');
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    for (const c of cols) this.aiSetWidth(sheet, c, a?.width ?? 'auto');
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, `Ширина ${a?.width && a.width !== 'auto' ? `${a.width}px` : 'по содержимому'}: колонки ${cols.map(c => this.colLetter(c)).join(', ')}.`, 'Отменить');
  }

  private aiExcelFreeze(a: { rows?: number; cols?: number; sheet?: string }): AiActionResult {
    const { ec, sheet, doc } = this.aiTarget(a?.sheet);
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    const rows = Math.max(0, +(a?.rows ?? 0) || 0), cols = Math.max(0, +(a?.cols ?? 0) || 0);
    if (!rows && !cols) delete sheet.freeze; else sheet.freeze = { rows, cols };
    this.aiPersist(doc, ec);
    return this.docsResult(doc.id, before, rows || cols ? `Закреплено: строк ${rows}, столбцов ${cols}.` : 'Закрепление снято.', 'Отменить');
  }

  /**
   * Сводный отчёт на новом листе: итоги по всей таблице и разбивка по
   * категории. Значения считаются ФОРМУЛАМИ со ссылками на исходный лист
   * (СУММЕСЛИ/СЧЁТЕСЛИ), поэтому отчёт живой: поправили исходные данные —
   * отчёт пересчитался. По желанию — диаграмма по разбивке.
   */
  private aiExcelCreateReport(a: {
    source?: string; newSheet?: string; title?: string; groupBy?: string;
    metrics?: Array<{ column?: string; op?: string; label?: string; format?: string }>;
    chart?: string | boolean; limit?: number;
  }): AiActionResult {
    const src = this.aiTarget(a?.source);
    const sh = src.sheet;
    const header = sh.data[0] ?? [];
    const dataRows = this.aiDataRows(sh);
    if (!dataRows.length) throw new Error(`На листе «${sh.name}» нет строк данных`);
    const lastRow = dataRows[dataRows.length - 1] + 1;   // 1-based
    const q = /^[A-Za-zА-Яа-яЁё_][\wА-Яа-яЁё.]*$/.test(sh.name) ? sh.name : `'${sh.name.replace(/'/g, "''")}'`;
    const colRef = (c: number) => `${q}!$${this.colLetter(c)}$2:$${this.colLetter(c)}$${lastRow}`;

    // Метрики: по умолчанию — все числовые колонки суммой
    let metrics = (a?.metrics ?? []).map(m => ({ ...m, c: m.column ? this.aiResolveCol(sh, m.column) : -1, op: String(m.op ?? 'sum').toLowerCase() }));
    if (!metrics.length) {
      header.forEach((h, c) => {
        const nums = dataRows.filter(r => this.aiCellNum(sh, r, c) !== null).length;
        if (h.v && nums >= dataRows.length * 0.6) metrics.push({ column: h.v, c, op: 'sum', label: undefined, format: undefined });
      });
    }
    metrics = metrics.filter(m => m.op === 'count' || m.c >= 0);
    if (!metrics.length) throw new Error('Не нашла числовых колонок для итогов — укажи metrics: [{column:"Сумма", op:"sum"}]');
    const opFn: Record<string, string> = { sum: 'SUM', avg: 'AVERAGE', average: 'AVERAGE', min: 'MIN', max: 'MAX', count: 'COUNTA' };
    const opIfFn: Record<string, string> = { sum: 'SUMIFS', avg: 'AVERAGEIFS', average: 'AVERAGEIFS', min: 'MINIFS', max: 'MAXIFS' };
    const opRu: Record<string, string> = { sum: 'Сумма', avg: 'Среднее', average: 'Среднее', min: 'Минимум', max: 'Максимум', count: 'Количество' };
    const label = (m: typeof metrics[number]) => m.label ?? (m.op === 'count' ? 'Количество строк' : `${opRu[m.op] ?? m.op}: ${(header[m.c]?.v ?? '').trim()}`);
    const fmtOf = (m: typeof metrics[number]) => m.format ?? (m.op === 'count' ? '#,##0' : (sh.data[dataRows[0]]?.[m.c]?.nf || '#,##0.00'));

    const name = (a?.newSheet ?? '').trim() || `Отчёт по ${sh.name}`.slice(0, 31);
    const ec = src.ec;
    const doc = src.doc;
    const before = doc.content;
    this.pushXlUndo(doc.id, this.activeSheetIdx);
    let tIdx = ec.sheets.findIndex(s => s.name.toLowerCase() === name.toLowerCase());
    if (tIdx < 0) { ec.sheets.push({ name: uniqueSheetName(ec, name), data: [[{ v: '' }]] }); tIdx = ec.sheets.length - 1; }
    const out = ec.sheets[tIdx];
    out.data = [[{ v: '' }]];
    delete out.merges; delete out.charts; delete out.autoFilter;
    const set = (r: number, c: number, cell: CellData) => { ensureSize(out, r + 1, c + 1); out.data[r][c] = cell; };
    const HEAD = 'font-weight:bold;color:#ffffff;background-color:#2f5496;text-align:center;vertical-align:middle;white-space:pre-wrap;border-left:1px solid #bfbfbf;border-right:1px solid #bfbfbf;border-top:1px solid #bfbfbf;border-bottom:1px solid #bfbfbf';
    const CELL = 'border-left:1px solid #d9d9d9;border-right:1px solid #d9d9d9;border-top:1px solid #d9d9d9;border-bottom:1px solid #d9d9d9';
    const norm = (css: string) => normalizeCss(css);

    let r = 0;
    set(r, 0, { v: a?.title?.trim() || `Отчёт по листу «${sh.name}»`, s: norm('font-size:16pt;font-weight:bold;color:#1f3864') });
    r += 1;
    set(r, 0, { v: `Источник: ${sh.name}, строк данных: ${dataRows.length}. Значения считаются формулами и обновляются вместе с данными.`, s: norm('font-style:italic;color:#7f7f7f;font-size:9pt') });
    r += 2;

    // Итоги
    set(r, 0, { v: 'Показатель', s: norm(HEAD) }); set(r, 1, { v: 'Значение', s: norm(HEAD) });
    r++;
    const firstData = header.findIndex(h => h.v);
    set(r, 0, { v: 'Строк в таблице', s: norm(CELL) });
    set(r, 1, { v: `=COUNTA(${colRef(Math.max(0, firstData))})`, nf: '#,##0', s: norm(CELL) });
    r++;
    for (const m of metrics) {
      set(r, 0, { v: label(m), s: norm(CELL) });
      set(r, 1, { v: m.op === 'count' ? `=COUNTA(${colRef(Math.max(0, m.c))})` : `=${opFn[m.op] ?? 'SUM'}(${colRef(m.c)})`, nf: fmtOf(m), s: norm(CELL) });
      r++;
    }
    let chartBlock: MergeRange | null = null;

    // Разбивка по категории
    if (a?.groupBy) {
      const g = this.aiResolveCol(sh, a.groupBy);
      if (g < 0) throw new Error(`Колонка группировки «${a.groupBy}» не найдена`);
      const groups = new Map<string, number>();
      for (const row of dataRows) {
        const key = this.aiCellText(sh, row, g).trim();
        if (!key) continue;
        groups.set(key, (groups.get(key) ?? 0) + (this.aiCellNum(sh, row, metrics.find(m => m.c >= 0)?.c ?? -1) ?? 1));
      }
      const keys = [...groups.entries()].sort((x, y) => y[1] - x[1]).slice(0, Math.min(a?.limit ?? 50, 500)).map(e => e[0]);
      r += 1;
      const top = r;
      set(r, 0, { v: (header[g]?.v ?? 'Категория').trim() || 'Категория', s: norm(HEAD) });
      set(r, 1, { v: 'Строк', s: norm(HEAD) });
      metrics.forEach((m, i) => set(r, 2 + i, { v: label(m), s: norm(HEAD) }));
      r++;
      const crit = (k: string) => k.replace(/"/g, '""');
      for (const k of keys) {
        const band = (r - top) % 2 === 0 ? ';background-color:#d9e1f2' : '';
        set(r, 0, { v: k, s: norm(CELL + band) });
        set(r, 1, { v: `=COUNTIFS(${colRef(g)},"${crit(k)}")`, nf: '#,##0', s: norm(CELL + band) });
        metrics.forEach((m, i) => {
          const f = m.op === 'count' ? `=COUNTIFS(${colRef(g)},"${crit(k)}")` : `=${opIfFn[m.op] ?? 'SUMIFS'}(${colRef(m.c)},${colRef(g)},"${crit(k)}")`;
          set(r, 2 + i, { v: f, nf: fmtOf(m), s: norm(CELL + band) });
        });
        r++;
      }
      // Строка «Итого»
      set(r, 0, { v: 'Итого', s: norm(CELL + ';font-weight:bold;background-color:#b4c6e7') });
      set(r, 1, { v: `=SUM(B${top + 2}:B${r})`, nf: '#,##0', s: norm(CELL + ';font-weight:bold;background-color:#b4c6e7') });
      metrics.forEach((m, i) => {
        const col = this.colLetter(2 + i);
        const f = m.op === 'sum' || m.op === 'count' ? `=SUM(${col}${top + 2}:${col}${r})` : `=${opFn[m.op] ?? 'SUM'}(${colRef(m.c)})`;
        set(r, 2 + i, { v: f, nf: fmtOf(m), s: norm(CELL + ';font-weight:bold;background-color:#b4c6e7') });
      });
      chartBlock = { r1: top, c1: 0, r2: r - 1, c2: 2 };
      out.autoFilter = rangeToRef({ r1: top, c1: 0, r2: r - 1, c2: 1 + metrics.length });
      r++;
    }

    // Ширины колонок
    out.colWidths = [Math.max(160, ...out.data.map(row => Math.min(60, (row[0]?.v ?? '').length) * 7.5)), 110, ...metrics.map(() => 140)];
    out.colWidths[0] = Math.min(Math.round(out.colWidths[0] as number), 380);
    out.rowHeights = [30];
    out.freeze = { rows: 0, cols: 1 };

    // Диаграмма по разбивке
    let chartNote = '';
    if (chartBlock && a?.chart !== false) {
      const kinds: Record<string, ChartKind> = { col: 'col', bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area' };
      const kind = typeof a?.chart === 'string' ? (kinds[a.chart] ?? 'col') : (chartBlock.r2 - chartBlock.r1 <= 6 ? 'pie' : 'col');
      const valCol = 2;  // первая метрика
      out.charts = [{
        id: 'ch_' + Date.now().toString(36), kind,
        title: label(metrics[0]),
        series: [{ valRef: `${this.colLetter(valCol)}${chartBlock.r1 + 2}:${this.colLetter(valCol)}${chartBlock.r2 + 1}`, catRef: `A${chartBlock.r1 + 2}:A${chartBlock.r2 + 1}`, nameRef: `${this.colLetter(valCol)}${chartBlock.r1 + 1}` }],
        r: 3, c: 3 + metrics.length, w: 520, h: 320, legend: kind === 'pie' || kind === 'doughnut',
      }];
      chartNote = ' Добавлена диаграмма.';
    }

    this.activeSheetIdx = tIdx;
    this.aiPersist(doc, ec);
    // Посчитанные итоги — ассистенту для ответа пользователю
    const ev = this.bookEvaluator(ec, tIdx);
    const lines: string[] = [];
    for (let rr = 4; rr < Math.min(out.data.length, 4 + 1 + metrics.length); rr++) {
      const lbl = out.data[rr]?.[0]?.v; const v = ev.cellValue(rr, 1);
      if (lbl) lines.push(`  ${lbl}: ${typeof v === 'number' ? formatCellValue(String(v), 'n', out.data[rr][1].nf) : String(v)}`);
    }
    return this.docsResult(doc.id, before, `Создан лист «${out.name}» с отчётом по «${sh.name}».${chartNote}\nИтоги:\n${lines.join('\n')}`, 'Убрать отчёт');
  }

  // ── Документы ───────────────────────────────────────────────────────────

  private async aiDocsDelete(a: { docIds?: string[] | 'all'; names?: string[] }): Promise<AiActionResult> {
    const targets = this.aiResolveDocs(a);
    if (!targets.length) throw new Error('Документы не найдены. Проверь id или названия через describe().');
    const names = targets.map(d => `«${d.title}»`).join(', ');
    // Подтверждение уже получено карточкой ассистента — удаляем по-настоящему
    for (const doc of targets) {
      if (!await this.deleteDoc(doc.id, true)) throw new Error(`Не удалось удалить «${doc.title}»`);
    }
    return { summary: `Удалено документов: ${targets.length} — ${names}.` };
  }

  private aiDocsSwitch(a: { id?: string; name?: string }): AiActionResult {
    let doc: DocItem | undefined;
    if (a?.id) doc = this.docs.find(d => d.id === a.id);
    else if (a?.name) {
      const low = a.name.trim().toLowerCase();
      doc = this.docs.find(d => d.title.trim().toLowerCase().includes(low));
      if (!doc) {
        const r = this.recent.find(x => x.title.toLowerCase().includes(low)) ?? this.allDocs?.find(x => x.title.toLowerCase().includes(low));
        if (r) { this.openDoc(r.id, { title: r.title, type: r.type }); return { summary: `Открыт документ «${r.title}».` }; }
      }
    }
    if (!doc) throw new Error('Документ не найден. Проверь id или название через describe().');
    this.openDoc(doc.id);
    return { summary: `Переключено на документ «${doc.title}».` };
  }

  private escRe(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  private esc(s: string): string {
    return String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]!));
  }
}
