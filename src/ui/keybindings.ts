import type { UiContext } from './commands';

export type { UiContext };

/**
 * Keybinding model.
 *
 * Every keybinding is registered exactly once (the single source of truth).
 * The TUI dispatches keypresses through {@link KeybindingManager.resolve},
 * which never lets a global shortcut shadow a context-specific one.
 */

export interface Shortcut {
  id: string;
  /** Canonical internal combo, e.g. 'ctrl+p', 'space', 'up', 'return'. */
  combo: string;
  /** Human-readable combo, e.g. 'Ctrl+P'. */
  display: string;
  context: UiContext;
  description: string;
  run: () => void;
}

export interface ShortcutConflict {
  combo: string;
  context: UiContext;
  ids: string[];
}

const MODFIERS = ['ctrl', 'meta', 'alt', 'shift'] as const;

type PressedKey = {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
};

/**
 * Normalize a Node `keypress` event into a canonical combo string.
 * Register combos must use the same canonical form ('ctrl+p', 'space', 'up').
 */
export function normalizeKeypress(str: string, key?: PressedKey): string {
  const mods: string[] = [];
  if (key?.ctrl) mods.push('ctrl');
  if (key?.meta) mods.push('meta');
  if (key?.alt) mods.push('alt');
  const modes = mods.sort((a, b) => MODFIERS.indexOf(a as (typeof MODFIERS)[number]) - MODFIERS.indexOf(b as (typeof MODFIERS)[number]));

  let name = key?.name ? String(key.name).toLowerCase() : '';
  if (!name && str) name = String(str).toLowerCase();
  if (!name) return '';

  const base = name.length === 1 && /[a-z0-9]/.test(name) ? name : name;
  if (mods.length === 0) return base;
  return [...modes, base].join('+');
}

/** Canonicalize a combo written in configuration/registration code. */
export function canonicalCombo(combo: string): string {
  return combo
    .trim()
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .join('+');
}

const DISPLAY_CAPITALIZE = new Set(['ctrl', 'meta', 'alt', 'shift', 'return', 'escape', 'space', 'up', 'down', 'left', 'right', 'tab', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'enter']);

/** Render a canonical combo for humans, e.g. 'ctrl+return' → 'Ctrl+Enter'. */
export function displayCombo(combo: string): string {
  return combo
    .split('+')
    .map((p) => {
      if (p === 'return') return 'Enter';
      if (p === 'escape') return 'Esc';
      if (p === 'space') return 'Space';
      if (p === 'pageup') return 'PageUp';
      if (p === 'pagedown') return 'PageDown';
      if (DISPLAY_CAPITALIZE.has(p)) return p.charAt(0).toUpperCase() + p.slice(1);
      return p.toUpperCase();
    })
    .join('+');
}

export interface BindInput {
  id: string;
  combo: string;
  context: UiContext;
  description: string;
  run: () => void;
  display?: string;
}

export class KeybindingManager {
  private shortcuts: Shortcut[] = [];

  get size(): number {
    return this.shortcuts.length;
  }

  bind(input: BindInput): Shortcut {
    const combo = canonicalCombo(input.combo);
    if (!combo) throw new Error(`Invalid combo for keybinding "${input.id}"`);
    const s: Shortcut = {
      id: input.id,
      combo,
      display: input.display ?? displayCombo(combo),
      context: input.context,
      description: input.description,
      run: input.run
    };
    this.shortcuts.push(s);
    return s;
  }

  /**
   * Resolve a combo for a context. Exact-match wins; otherwise a global
   * binding is returned as the fallback. Context shortcuts are never
   * shadowed by a global one.
   */
  resolve(combo: string, context: UiContext): Shortcut | undefined {
    const c = canonicalCombo(combo);
    if (!c) return undefined;
    const exact = this.shortcuts.find((s) => s.context === context && s.combo === c);
    if (exact) return exact;
    if (context === 'global') return undefined;
    return this.shortcuts.find((s) => s.context === 'global' && s.combo === c);
  }

  /** Non-exclusive list: the registration conflict report. */
  conflicts(): ShortcutConflict[] {
    const groups = new Map<string, Shortcut[]>();
    for (const s of this.shortcuts) {
      const k = `${s.context}|${s.combo}`;
      const arr = groups.get(k) ?? [];
      arr.push(s);
      groups.set(k, arr);
    }
    const out: ShortcutConflict[] = [];
    for (const [k, arr] of groups) {
      if (arr.length > 1) {
        const [context, combo] = k.split('|');
        out.push({ context: context as UiContext, combo, ids: [...new Set(arr.map((s) => s.id))] });
      }
    }
    return out;
  }

  all(): Shortcut[] {
    return [...this.shortcuts];
  }

  forContext(context: UiContext): Shortcut[] {
    return this.shortcuts
      .filter((s) => s.context === context)
      .sort((a, b) => a.combo.localeCompare(b.combo));
  }
}