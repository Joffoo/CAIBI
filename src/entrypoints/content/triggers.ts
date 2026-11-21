import { loadSettings, watchSettings } from '../../services/settings';
import { DEFAULT_SETTINGS, type TriggerMode } from '../../utils/types';

/**
 * Module A — cursor-resident triggers:
 *   1. Alt + RightClick on any image / large background-image container
 *   2. Alt + Q anywhere (uses last hovered image)
 *   3. Optional floating 24x24 "[+]" badge after a 300ms hover
 * All triggers dispatch a `vrc:open` CustomEvent consumed by the Shadow-DOM HUD.
 */

interface Found {
  el: HTMLElement;
  src: string;
}

let lastMouse = { x: window.innerWidth / 2, y: 80 };
let hovered: Found | null = null;
let badgeTimer: number | null = null;
let badge: HTMLDivElement | null = null;
let triggerMode: TriggerMode = DEFAULT_SETTINGS.triggerMode;
let uidCounter = 0;
const uidMap = new WeakMap<Element, string>();

export function getLastMouse(): { x: number; y: number } {
  return lastMouse;
}

export function getLastHoveredSrc(): string | undefined {
  return hovered ? absoluteUrl(hovered.src) : undefined;
}

function uid(el: Element): string {
  let id = uidMap.get(el);
  if (!id) {
    id = `el-${uidCounter++}`;
    uidMap.set(el, id);
  }
  return id;
}

export function setupTriggers(): () => void {
  loadSettings()
    .then((s) => {
      triggerMode = s.triggerMode;
    })
    .catch(() => {
      /* ignore */
    });
  const unwatch = watchSettings((s) => {
    triggerMode = s.triggerMode;
    if (triggerMode === 'shortcut') {
      hovered = null;
      clearBadgeTimer();
      removeBadge();
    }
  });

  const onMouseMove = (e: MouseEvent) => {
    lastMouse = { x: e.clientX, y: e.clientY };
  };
  const onMouseOver = (e: MouseEvent) => {
    if (triggerMode === 'shortcut') return;
    onHover(e.target as Element | null, e.clientX, e.clientY);
  };
  const onMouseOut = (e: MouseEvent) => {
    if (triggerMode === 'shortcut') return;
    scheduleBadge(e.relatedTarget as Element | null);
  };

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseover', onMouseOver, true);
  document.addEventListener('mouseout', onMouseOut, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', removeBadge, true);
  window.addEventListener('resize', removeBadge);

  return () => {
    unwatch();
    clearBadgeTimer();
    removeBadge();
    hovered = null;
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseover', onMouseOver, true);
    document.removeEventListener('mouseout', onMouseOut, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', removeBadge, true);
    window.removeEventListener('resize', removeBadge);
  };
}

function resolveSrc(el: HTMLElement): string | null {
  if (el instanceof HTMLImageElement) {
    const s = el.currentSrc || el.src;
    return s || null;
  }
  const bg = getComputedStyle(el).backgroundImage;
  if (bg && bg !== 'none') {
    const m = bg.match(/url\((["']?)([^"')]+)\1\)/);
    if (m && m[2] && m[2] !== 'none') return m[2];
  }
  return null;
}

function matchElement(node: Element | null): Found | null {
  if (!(node instanceof HTMLElement)) return null;
  const src = resolveSrc(node);
  if (!src) return null;
  const r = node.getBoundingClientRect();
  const isImg = node instanceof HTMLImageElement;
  const bigEnough = r.width >= 150 && r.height >= 150;
  const visible = r.width >= 40 && r.height >= 40;
  if (visible && (isImg || bigEnough)) {
    return { el: node, src };
  }
  return null;
}

function findFrom(target: Element | null, x?: number, y?: number): Found | null {
  if (target && target.closest('vrc-hud')) return null;

  let node: Element | null = target;
  while (node && node !== document.documentElement) {
    const hit = matchElement(node);
    if (hit) return hit;
    node = node.parentElement;
  }

  // Fallback for transparent sibling overlays covering an underlying image
  if (x !== undefined && y !== undefined) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (badge && (el === badge || badge.contains(el))) continue;
      if (el.closest('vrc-hud')) return null;
      const hit = matchElement(el);
      if (hit) return hit;
    }
  }
  return null;
}

function clearBadgeTimer(): void {
  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }
}

function onHover(target: Element | null, x: number, y: number): void {
  if (target && badge && (target === badge || badge.contains(target))) {
    clearBadgeTimer();
    return;
  }

  const found = findFrom(target, x, y);
  hovered = found;
  clearBadgeTimer();

  if (!found || triggerMode === 'shortcut') {
    removeBadge();
    return;
  }
  if (badge && badge.dataset.for === uid(found.el)) {
    return; // same image, keep badge
  }
  removeBadge();
  badgeTimer = window.setTimeout(() => {
    badgeTimer = null;
    if (triggerMode !== 'shortcut' && hovered) {
      showBadge(hovered.el, hovered.src);
    }
  }, 300);
}

function absoluteUrl(src: string): string {
  try {
    return new URL(src, location.href).toString();
  } catch {
    return src;
  }
}

function showBadge(el: HTMLElement, src: string): void {
  const b = document.createElement('div');
  b.textContent = '[+]';
  b.dataset.for = uid(el);
  b.title = '传彩笔 CAIBI · 视觉逆向解剖';
  b.style.cssText = [
    'position:fixed',
    'z-index:2147483646',
    'width:24px',
    'height:24px',
    'box-sizing:border-box',
    'background:#09090B',
    'color:#FAFAFA',
    'border:1px solid #FAFAFA',
    'font:700 12px/22px "JetBrains Mono",Consolas,monospace',
    'text-align:center',
    'cursor:pointer',
    'user-select:none',
    'pointer-events:auto',
  ].join(';');
  positionBadge(b, el);
  b.addEventListener('mousedown', (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    const rr = el.getBoundingClientRect();
    window.dispatchEvent(
      new CustomEvent('vrc:open', {
        detail: {
          srcUrl: absoluteUrl(src),
          x: rr.left + rr.width / 2,
          y: rr.top + 8,
        },
      }),
    );
    removeBadge();
  });
  document.body.appendChild(b);
  badge = b;
}

function positionBadge(b: HTMLDivElement, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const left = Math.max(0, r.right - 28);
  const top = Math.max(0, r.top + 4);
  b.style.left = `${left}px`;
  b.style.top = `${top}px`;
}

function removeBadge(): void {
  if (badge) {
    badge.remove();
    badge = null;
  }
}

function scheduleBadge(relatedTarget?: Element | null): void {
  if (relatedTarget && badge && (relatedTarget === badge || badge.contains(relatedTarget))) {
    clearBadgeTimer();
    return;
  }
  clearBadgeTimer();
  badgeTimer = window.setTimeout(() => {
    badgeTimer = null;
    removeBadge();
  }, 200);
}

function onContextMenu(e: MouseEvent): void {
  if (!e.altKey || triggerMode === 'badge') return;
  e.preventDefault();
  e.stopPropagation();
  const found = findFrom(e.target as Element | null, e.clientX, e.clientY);
  hovered = found;
  window.dispatchEvent(
    new CustomEvent('vrc:open', {
      detail: {
        srcUrl: found ? absoluteUrl(found.src) : undefined,
        x: e.clientX,
        y: e.clientY,
      },
    }),
  );
}

function onKeyDown(e: KeyboardEvent): void {
  if (!e.altKey || triggerMode === 'badge') return;
  if (e.key !== 'q' && e.key !== 'Q') return;
  e.preventDefault();
  e.stopPropagation();
  const found =
    hovered ??
    findFrom(document.elementFromPoint(lastMouse.x, lastMouse.y), lastMouse.x, lastMouse.y);
  window.dispatchEvent(
    new CustomEvent('vrc:open', {
      detail: {
        srcUrl: found ? absoluteUrl(found.src) : undefined,
        x: lastMouse.x,
        y: lastMouse.y,
      },
    }),
  );
}
