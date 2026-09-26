// Playground de réglage : la même île que l'app, sur un fond au choix.
//
// Le panneau montre d'abord une poignée de réglages essentiels, nommés en clair. Tous les
// autres (générés depuis src/config/animation.ts : une clé ajoutée à la config y apparaît
// sans autre code) sont rangés dans « Tous les réglages », replié.

import { Pane } from 'tweakpane';
import type { FolderApi } from 'tweakpane';
import { animation } from '../src/config/animation';
import { Clock } from '../src/anim/clock';
import { Island, type FrameInfo, type IslandState, type Source } from '../src/island';
import type { NoticeKind } from '../src/messages';
import '../src/theme/black.css';
// Importée par le script et non par un <link> : en dev, Vite 8 servait ce <link> vide.
import './playground.css';

// --- Mesures -------------------------------------------------------------------------------

// Fenêtre glissante sur laquelle on calcule les images par seconde et la pire image, en ms.
const STATS_WINDOW_MS = 1000;
// Pas d'une image en lecture image par image : une image à 120 Hz.
const STEP_MS = 1000 / 120;

const stats = {
  state: 'hidden' as IslandState,
  fps: 0,
  worstFrameMs: 0,
  worstWorkMs: 0,
  lastAnimationWorstMs: 0,
};
let frames: { at: number; interval: number; work: number }[] = [];
let previousReal: number | undefined;
let animationWorst = 0;

function onFrame({ realNow, workMs, state }: FrameInfo): void {
  if (previousReal !== undefined) {
    const interval = realNow - previousReal;
    frames.push({ at: realNow, interval, work: workMs });
    if (state === 'entering' || state === 'exiting') animationWorst = Math.max(animationWorst, interval);
  }
  previousReal = state === 'hidden' ? undefined : realNow;
  frames = frames.filter((f) => realNow - f.at <= STATS_WINDOW_MS);
  stats.fps = frames.length ? (1000 * frames.length) / Math.max(frames.reduce((s, f) => s + f.interval, 0), 1) : 0;
  stats.worstFrameMs = frames.reduce((m, f) => Math.max(m, f.interval), 0);
  stats.worstWorkMs = frames.reduce((m, f) => Math.max(m, f.work), 0);
}

function onStateChange(state: IslandState): void {
  stats.state = state;
  if (state === 'entering' || state === 'exiting') animationWorst = 0;
  if (state === 'shown' || state === 'hidden') stats.lastAnimationWorstMs = animationWorst;
  if (state === 'hidden') previousReal = undefined;
}

// --- Île -----------------------------------------------------------------------------------

const clock = new Clock();
const stage = document.getElementById('stage')!;
const notchGuide = document.getElementById('notch-guide')!;
const island = new Island(document.getElementById('island')!, animation, { clock, onFrame, onStateChange });
void island.warmup();

const playback = { speed: 1, paused: false, kind: 'done' as NoticeKind, source: 'claude-code' as Source };

function show(kind: NoticeKind): void {
  playback.kind = kind;
  island.show(kind, { source: playback.source });
}
function replayEntry(): void {
  island.hideInstant();
  island.show(playback.kind, { source: playback.source });
}
function replayExit(): void {
  if (island.state !== 'shown') island.showInstant(playback.kind, { source: playback.source });
  island.dismiss('close');
}
function step(): void {
  playback.paused = clock.paused = true;
  clock.step(STEP_MS);
  island.renderNow();
  pane.refresh();
}
// La scène a la taille exacte de la fenêtre de l'app, centrée en haut de la page.
function syncStage(): void {
  stage.style.width = `${animation.window.widthPx}px`;
  stage.style.height = `${animation.window.heightPx}px`;
  notchGuide.style.width = `${animation.notch.widthPx}px`;
}
syncStage();

// Survol et clics : seule la pilule réagit, comme le fera la fenêtre de l'app.
let hovered = false;
function localPoint(e: MouseEvent): [number, number] {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
stage.addEventListener('pointermove', (e) => {
  const hit = island.hitTest(...localPoint(e));
  stage.style.cursor = hit ? 'pointer' : 'default';
  if (hit !== hovered) island.hover((hovered = hit));
});
stage.addEventListener('pointerleave', () => {
  if (hovered) island.hover((hovered = false));
});
stage.addEventListener('click', (e) => {
  if (island.hitTest(...localPoint(e))) island.dismiss('click');
});
stage.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (island.hitTest(...localPoint(e))) island.dismiss('close');
});

// --- Fond ----------------------------------------------------------------------------------

const background = document.getElementById('background')!;
const fileInput = document.getElementById('file') as HTMLInputElement;
const scene = { background: 'gradient', outline: false, notch: true };

function applyBackground(): void {
  background.replaceChildren();
  background.style.background =
    scene.background === 'white'
      ? '#fff'
      : scene.background === 'gradient'
        ? 'linear-gradient(160deg, #1d3b6a 0%, #b0508a 45%, #f3b36b 100%)'
        : '#000';
}
applyBackground();
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const media = file.type.startsWith('video/') ? document.createElement('video') : document.createElement('img');
  media.src = url;
  if (media instanceof HTMLVideoElement) Object.assign(media, { autoplay: true, loop: true, muted: true });
  background.replaceChildren(media);
});

// --- Panneau -------------------------------------------------------------------------------

const pane = new Pane({ container: document.getElementById('pane')!, title: 'ReversePrompt' });

const test = pane.addFolder({ title: 'Tester' });
test.addBinding(playback, 'source', {
  label: 'outil',
  options: { 'Claude Code (WSL)': 'claude-code', 'Claude Desktop': 'claude-desktop', 'Autre outil': 'generic' },
});
test.addButton({ title: '« Terminé »  (D)' }).on('click', () => show('done'));
test.addButton({ title: '« Besoin de toi »  (N)' }).on('click', () => show('needs'));
test.addButton({ title: "Rejouer l'entrée  (R)" }).on('click', replayEntry);
test.addButton({ title: 'Sortie  (E)' }).on('click', replayExit);

// Les réglages qui comptent vraiment pour la sensation, dans l'ordre où on les voit.
const essentials = pane.addFolder({ title: 'Réglages essentiels' });
const ESSENTIALS: [object, string, string, { min: number; max: number; step: number }][] = [
  [animation.notch, 'widthPx', "largeur de l'encoche", { min: 40, max: 480, step: 1 }],
  [animation.entry, 'filmMs', "l'encre apparaît (ms)", { min: 0, max: 1000, step: 5 }],
  [animation.entry, 'gatherMs', "l'encre se rassemble (ms)", { min: 0, max: 1200, step: 5 }],
  [animation.entry, 'hangMs', 'la goutte pend (ms)', { min: 0, max: 1000, step: 5 }],
  [animation.entry, 'fallMs', 'la goutte tombe (ms)', { min: 60, max: 800, step: 5 }],
  [animation.entry, 'breakRatio', 'le fil casse à (0→1 de la chute)', { min: 0, max: 1, step: 0.01 }],
  [animation.pill, 'centerYPx', "hauteur d'atterrissage", { min: 30, max: 110, step: 1 }],
  [animation.entry.bounce, 'damping', 'rebond (bas = plus de rebond)', { min: 4, max: 60, step: 0.5 }],
  [animation.typing, 'charMs', 'frappe (ms par lettre)', { min: 10, max: 120, step: 1 }],
  [animation.typing, 'leadPx', 'avance de la pilule sur le texte', { min: 0, max: 60, step: 1 }],
  [animation.pill, 'iconSizePx', "taille de l'icône", { min: 16, max: 40, step: 1 }],
];
for (const [obj, key, label, range] of ESSENTIALS) {
  essentials.addBinding(obj as Record<string, number>, key, { label, ...range }).on('change', onConfigChange);
}

const play = pane.addFolder({ title: 'Lecture' });
play
  .addBinding(playback, 'speed', { label: 'vitesse', options: { 'x1': 1, 'x0,5': 0.5, 'x0,25': 0.25, 'x0,1': 0.1 } })
  .on('change', ({ value }) => (clock.speed = value));
play.addBinding(playback, 'paused', { label: 'pause (Espace)' }).on('change', ({ value }) => (clock.paused = value));
play.addButton({ title: 'Image suivante  (→)' }).on('click', step);

const look = pane.addFolder({ title: 'Fond', expanded: false });
look
  .addBinding(scene, 'background', { label: 'fond', options: { dégradé: 'gradient', noir: 'black', blanc: 'white' } })
  .on('change', applyBackground);
look.addButton({ title: 'Image ou vidéo…' }).on('click', () => fileInput.click());
look.addBinding(scene, 'notch', { label: "repère de l'encoche" }).on('change', ({ value }) => notchGuide.classList.toggle('hidden', !value));
look.addBinding(scene, 'outline', { label: 'limites de la fenêtre' }).on('change', ({ value }) => stage.classList.toggle('outlined', value));

const monitor = pane.addFolder({ title: 'Mesures', expanded: false });
monitor.addBinding(stats, 'state', { label: 'état', readonly: true });
monitor.addBinding(stats, 'fps', { label: 'images/s', readonly: true, format: (v) => v.toFixed(0) });
monitor.addBinding(stats, 'worstFrameMs', { label: 'pire image (1 s)', readonly: true, format: (v) => `${v.toFixed(1)} ms` });
monitor.addBinding(stats, 'worstWorkMs', { label: 'pire calcul (1 s)', readonly: true, format: (v) => `${v.toFixed(2)} ms` });
monitor.addBinding(stats, 'lastAnimationWorstMs', {
  label: 'pire image, dernière anim',
  readonly: true,
  format: (v) => `${v.toFixed(1)} ms`,
});

const advanced = pane.addFolder({ title: 'Tous les réglages (avancé)', expanded: false });
addConfigBindings(advanced, animation as unknown as Record<string, unknown>);

pane.addButton({ title: 'Copier la config' }).on('click', copyConfig);

function onConfigChange(): void {
  syncStage();
  island.applyConfig();
  pane.refresh();
}

function addConfigBindings(folder: FolderApi, obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'object' && value !== null) {
      addConfigBindings(folder.addFolder({ title: key, expanded: false }), value as Record<string, unknown>);
    } else if (typeof value === 'number') {
      folder.addBinding(obj, key, rangeFor(key, value)).on('change', onConfigChange);
    } else if (typeof value === 'boolean') {
      folder.addBinding(obj, key).on('change', onConfigChange);
    }
  }
}

// Bornes des curseurs, déduites du nom de la clé (suffixes de src/config/animation.ts).
function rangeFor(key: string, value: number): { min: number; max: number; step: number } {
  if (key === 'stiffness') return { min: 10, max: 1500, step: 1 };
  if (key === 'damping') return { min: 1, max: 100, step: 0.5 };
  if (key === 'intervalMs') return { min: 1000, max: 120000, step: 500 };
  if (key.endsWith('Ms')) return { min: 0, max: 1500, step: 1 };
  if (key === 'edgeOffsetPx') return { min: -5, max: 10, step: 0.1 };
  if (key.endsWith('Px')) return { min: 0, max: Math.max(20, Math.ceil(value * 2.5)), step: 0.1 };
  if (key.endsWith('Ratio')) return { min: 0, max: 1, step: 0.01 };
  if (key.endsWith('Scale') || key.endsWith('ScaleFrom')) return { min: 0.5, max: 1.5, step: 0.005 };
  if (key === 'stretchPerSpeed') return { min: 0, max: 0.003, step: 0.00005 };
  if (key.endsWith('Speed')) return { min: -800, max: 800, step: 1 };
  return { min: 0, max: Math.max(1, value * 3), step: 0.01 };
}

// Exporte la config courante sous la forme exacte de src/config/animation.ts.
function copyConfig(): void {
  const text = `export const animation = ${toLiteral(animation, '')};\n`;
  navigator.clipboard.writeText(text).then(
    () => toast('Config copiée : à coller dans src/config/animation.ts'),
    () => {
      console.log(text);
      toast('Presse-papiers refusé : config affichée dans la console');
    },
  );
}

function toLiteral(value: unknown, indent: string): string {
  if (typeof value !== 'object' || value === null) return String(Number.isFinite(value) ? +(value as number).toFixed(5) : value);
  const inner = indent + '  ';
  const lines = Object.entries(value).map(([k, v]) => `${inner}${k}: ${toLiteral(v, inner)},`);
  return `{\n${lines.join('\n')}\n${indent}}`;
}

let toastTimer = 0;
function toast(message: string): void {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('visible'), 2200);
}

// --- Clavier -------------------------------------------------------------------------------

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('#pane')) return;
  const handlers: Record<string, () => void> = {
    d: () => show('done'),
    n: () => show('needs'),
    r: replayEntry,
    e: replayExit,
    ' ': () => {
      playback.paused = clock.paused = !clock.paused;
      pane.refresh();
    },
    ArrowRight: step,
  };
  const handler = handlers[e.key];
  if (!handler) return;
  e.preventDefault();
  handler();
});

// Accès depuis la console (et pour les captures automatisées) : island.show('needs'), clock.step(8)…
Object.assign(window, { island, clock, animation });
