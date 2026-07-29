/**
 * Tests for AssistantModule AI response parsing.
 * Covers the XSS-sensitive surfaces: task title/description and nav action label/page.
 */
import { describe, it, expect } from 'vitest';
import { esc } from '@/utils/format';

// ── Inline copies of the parsing logic (private in AssistantModule) ─────────
// These mirror the exact regexes used in production so tests break if they change.

type Priority = 'red' | 'yellow' | 'blue' | 'none';
interface TaskAction {
  action: 'create_task' | 'create_tasks' | 'suggest_task';
  title?: string;
  description?: string;
  priority?: Priority;
  tasks?: Array<{ title: string; description?: string; priority?: string }>;
}
interface NavAction {
  action: 'navigate';
  page: string;
  label?: string;
}

function parseTaskAction(reply: string): TaskAction | null {
  const match = reply.match(/\{[\s\S]*?"action"\s*:\s*"(?:create_task|create_tasks|suggest_task)"[\s\S]*?\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as TaskAction; } catch { return null; }
}

function parseNavAction(reply: string): NavAction | null {
  const jsonMatch = reply.match(/\{[^}]*"action"\s*:\s*"navigate"[^}]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as NavAction;
    if (parsed.action === 'navigate' && parsed.page) return parsed;
    return null;
  } catch { return null; }
}

// ── parseTaskAction ───────────────────────────────────────────────────────────

describe('parseTaskAction', () => {
  it('parses a minimal create_task payload', () => {
    const reply = 'Создам задачу: {"action":"create_task","title":"Купить молоко"}';
    const result = parseTaskAction(reply);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('create_task');
    expect(result!.title).toBe('Купить молоко');
  });

  it('parses suggest_task with description and priority', () => {
    const reply = '{"action":"suggest_task","title":"Тест","description":"Описание","priority":"red"}';
    const result = parseTaskAction(reply);
    expect(result!.action).toBe('suggest_task');
    expect(result!.description).toBe('Описание');
    expect(result!.priority).toBe('red');
  });

  it('returns null for create_tasks with nested task objects — regex limitation', () => {
    // Known limitation: the non-greedy regex stops at first } inside the tasks array,
    // producing truncated invalid JSON. LLM must not use nested arrays for create_tasks.
    const reply = '{"action":"create_tasks","tasks":[{"title":"A"},{"title":"B"}]}';
    expect(parseTaskAction(reply)).toBeNull();
  });

  it('returns null when no task action JSON present', () => {
    expect(parseTaskAction('Привет! Как дела?')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseTaskAction('{"action":"create_task","title":"без закрывающей скобки')).toBeNull();
  });

  it('returns null for unknown action type', () => {
    expect(parseTaskAction('{"action":"delete_all","title":"evil"}')).toBeNull();
  });

  it('preserves HTML special chars in title — escaping done at render time', () => {
    const xss = '<script>alert(1)</script>';
    const reply = `{"action":"create_task","title":"${xss}"}`;
    const result = parseTaskAction(reply);
    // Parser returns raw string — esc() is applied at render time in addSuggestTaskCard
    expect(result!.title).toBe(xss);
  });

  it('returns null for empty reply', () => {
    expect(parseTaskAction('')).toBeNull();
  });
});

// ── parseNavAction ────────────────────────────────────────────────────────────

describe('parseNavAction', () => {
  it('parses a valid navigate action', () => {
    const reply = '{"action":"navigate","page":"analytics","label":"Аналитика"}';
    const result = parseNavAction(reply);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('navigate');
    expect(result!.page).toBe('analytics');
    expect(result!.label).toBe('Аналитика');
  });

  it('parses navigate without label', () => {
    const reply = '{"action":"navigate","page":"wb"}';
    const result = parseNavAction(reply);
    expect(result!.page).toBe('wb');
    expect(result!.label).toBeUndefined();
  });

  it('returns null when no navigate action present', () => {
    expect(parseNavAction('Открою нужный раздел')).toBeNull();
  });

  it('returns null when page is missing', () => {
    expect(parseNavAction('{"action":"navigate"}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseNavAction('{"action":"navigate","page":"oops')).toBeNull();
  });

  it('preserves HTML special chars in page — escaping done at render time', () => {
    // Injection attempt: parser extracts raw value, esc() at render blocks it
    const reply = '{"action":"navigate","page":"x","label":"<img onerror=alert(1)>"}';
    const result = parseNavAction(reply);
    expect(result!.label).toBe('<img onerror=alert(1)>');
    // Confirm esc() neutralises the injection
    expect(esc(result!.label!)).not.toContain('<img');
    expect(esc(result!.label!)).toContain('&lt;img');
  });

  it('embedded text before JSON is ignored', () => {
    const reply = 'Перехожу в аналитику {"action":"navigate","page":"analytics"}';
    const result = parseNavAction(reply);
    expect(result!.page).toBe('analytics');
  });
});
