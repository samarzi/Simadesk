/**
 * aiPageContext — реестр «возможностей текущей страницы» для AI-ассистента.
 *
 * • Активная страница регистрирует describe() (структуру/данные), actions
 *   (управление страницей) и suggestions (кнопки-подсказки под эту страницу).
 * • Глобальные действия (registerGlobal) доступны с ЛЮБОЙ страницы и при вызове
 *   сами переходят куда нужно — напр. «в редакторе создай эксель» из Обзора.
 *
 * Ассистент подмешивает всё это в системный промпт и, получив от модели
 * {"action":"page_action","name":"...","args":{...}}, вызывает нужное действие.
 */

/** Спецификация отката действия (совместима с UndoSpec журнала). */
export interface AiUndo {
  kind: string;
  payload: any;
  label?: string;
}

/** Результат действия: резюме + опциональный снимок для отката. */
export interface AiActionResult {
  summary: string;
  undo?: AiUndo;
}

export interface AiAction {
  /** Уникальное имя действия, snake_case. */
  name: string;
  /** Что делает и когда использовать (для модели). */
  description: string;
  /** Человекочитаемая схема аргументов. */
  args: string;
  /** Выполнить действие. Вернёт резюме (строкой) или {summary, undo} (или бросит Error). */
  run: (args: any) => Promise<string | AiActionResult> | string | AiActionResult;
}

/** Кнопка-подсказка под текущую страницу. */
export interface AiSuggestion {
  label: string;
  /** Текст, который будет отправлен ассистенту при нажатии. */
  prompt: string;
}

export interface AiPageCapability {
  page: string;
  title: string;
  describe: () => string;
  actions: AiAction[];
  suggestions?: AiSuggestion[];
}

type Listener = () => void;

class AiPageContext {
  private cap: AiPageCapability | null = null;
  private globals: AiAction[] = [];
  private listeners = new Set<Listener>();

  /** Зарегистрировать возможности активной страницы (заменяет предыдущую). */
  register(cap: AiPageCapability): void {
    this.cap = cap;
    this.emit();
  }

  clear(page?: string): void {
    if (!page || this.cap?.page === page) { this.cap = null; this.emit(); }
  }

  /** Глобальное действие, доступное с любой страницы (напр. создать документ). */
  registerGlobal(action: AiAction): void {
    if (!this.globals.some(g => g.name === action.name)) this.globals.push(action);
  }

  current(): AiPageCapability | null { return this.cap; }

  suggestions(): AiSuggestion[] { return this.cap?.suggestions ?? []; }

  /** Подписка на смену активной страницы (для перерисовки кнопок в панели). */
  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    this.listeners.forEach(l => { try { l(); } catch { /* ignore */ } });
  }

  /** Фрагмент системного промпта: текущая страница + глобальные действия. */
  promptFragment(): string {
    const parts: string[] = [];
    const c = this.cap;

    if (c) {
      let structure = '';
      try { structure = c.describe() || ''; } catch { structure = ''; }
      const actionsList = c.actions.map(a =>
        `- ${a.name}: ${a.description}\n  Аргументы: ${a.args}`,
      ).join('\n');
      parts.push(`[ТЕКУЩАЯ СТРАНИЦА: ${c.title} (${c.page})]
Ты видишь её структуру и можешь ею управлять.

СТРУКТУРА:
${structure || '(пусто)'}

ДЕЙСТВИЯ НА ЭТОЙ СТРАНИЦЕ:
${actionsList || '(нет)'}`);
    }

    if (this.globals.length) {
      const g = this.globals.map(a =>
        `- ${a.name}: ${a.description}\n  Аргументы: ${a.args}`,
      ).join('\n');
      parts.push(`ГЛОБАЛЬНЫЕ ДЕЙСТВИЯ (доступны с любой страницы, сами перейдут куда нужно):
${g}`);
    }

    if (!parts.length) return '';

    return `\n\n${parts.join('\n\n')}

КОГДА ПОЛЬЗОВАТЕЛЬ ПРОСИТ ЧТО-ТО ИЗМЕНИТЬ В ДАННЫХ СТРАНИЦЫ:
1. Если команда неоднозначна — задай уточняющий вопрос ОБЫЧНЫМ ТЕКСТОМ, перечисли варианты.
   ОБЯЗАТЕЛЬНО уточняй если:
   - Говорят «удали всё» / «очисти всё» / «сотри» без указания ЧТО именно: содержимое ячеек? форматирование? строки? весь документ? — спроси.
   - Область действия не ясна: «эти» / «все» без конкретики — уточни какие именно.
   НИКОГДА не отвечай «Выполнено» если инструмент не был вызван или завершился ошибкой.
2. Если понял — ответь СТРОГО ТОЛЬКО JSON, НИКАКОГО другого текста до или после:
{"action":"page_action_plan","name":"<имя_действия>","args":{ ... },"plan":"Подробно опиши что именно будешь делать: какие колонки/строки/ячейки затронешь, что удалишь/изменишь/добавишь"}

ЗАПРЕЩЕНО: добавлять любой текст до или после JSON (ни "Создаю...", ни "Готово!", ни пояснения).
ЗАПРЕЩЕНО: оборачивать JSON в код-блок (тройные бэктики) — только голый JSON.
Пользователь увидит план и нажмёт «Выполнить» — результат придёт отдельным сообщением.
Если пользователь просто спрашивает о данных — отвечай обычным текстом, без JSON.`;
  }

  /** Выполнить действие: сначала среди действий страницы, потом глобальных. */
  async run(name: string, args: any): Promise<AiActionResult> {
    const action = this.cap?.actions.find(a => a.name === name)
      ?? this.globals.find(a => a.name === name);
    if (!action) throw new Error(`Действие «${name}» недоступно`);
    const res = await action.run(args ?? {});
    return typeof res === 'string' ? { summary: res } : res;
  }

  /** Есть ли такое действие (локальное или глобальное). */
  hasAction(name: string): boolean {
    return !!this.cap?.actions.some(a => a.name === name) || this.globals.some(a => a.name === name);
  }
}

export const aiPage = new AiPageContext();

// ── Свечение экрана во время работы ИИ ──────────────────────────────────────────

let glowEl: HTMLElement | null = null;
let glowCount = 0;

/**
 * Показать/скрыть свечение по краям экрана, пока ИИ управляет системой —
 * чтобы пользователь видел, что идёт редактирование, и не мешал.
 * Вложенные вызовы считаются (glow гаснет, когда все действия завершены).
 */
export function aiGlow(on: boolean): void {
  if (on) {
    glowCount++;
    if (!glowEl) {
      glowEl = document.createElement('div');
      glowEl.className = 'ai-activity-glow';
      glowEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(glowEl);
    }
    requestAnimationFrame(() => glowEl?.classList.add('on'));
  } else {
    glowCount = Math.max(0, glowCount - 1);
    if (glowCount === 0) glowEl?.classList.remove('on');
  }
}
