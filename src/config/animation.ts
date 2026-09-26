// Toutes les valeurs réglables de l'animation. Aucune autre valeur d'animation ne doit
// vivre en dur dans le code : le playground lie ses curseurs à cet objet et exporte son
// contenu sous cette même forme (bouton « Copier la config »).
//
// Unités : pixels logiques (Px), millisecondes (Ms). Les ressorts utilisent une masse de 1,
// une raideur (stiffness) et un amortissement (damping) exprimés en secondes.
// Le détail de chaque phase est décrit dans docs/animation.md.

export const animation = {
  window: {
    widthPx: 520,
    heightPx: 140,
  },
  // Encoche de l'écran (bosse de webcam du Yoga Pro 7i) : l'encre en sort, centrée en haut.
  notch: {
    widthPx: 360,
    filmHeightPx: 3,
    gatherHalfWidthPx: 12,
    gatherHeightPx: 7,
  },
  shape: {
    edgeOffsetPx: 1,
    edgeSmoothPx: 10,
    headSmoothPx: 9,
  },
  pill: {
    heightPx: 48,
    maxWidthPx: 480,
    centerYPx: 58,
    paddingLeftPx: 10,
    paddingRightPx: 18,
    gapPx: 10,
    iconSizePx: 40,
  },
  drop: {
    startRadiusPx: 5,
    hangRadiusPx: 10,
    hangYPx: 12,
    sagYPx: 20,
    stretchPerSpeed: 0.0008,
    maxStretch: 0.35,
    pillStretchRatio: 0.25,
  },
  thread: {
    neckRadiusPx: 4,
    thinRadiusPx: 1.4,
    retractMs: 170,
  },
  entry: {
    filmMs: 220,
    gatherMs: 320,
    hangMs: 200,
    fallMs: 230,
    breakRatio: 0.35,
    contentStartRatio: 0.9,
    bounce: { stiffness: 260, damping: 18 },
    spread: { stiffness: 380, damping: 26 },
    thin: { stiffness: 300, damping: 30 },
  },
  content: {
    iconScaleFrom: 0.6,
    iconFadeMs: 160,
    iconSpring: { stiffness: 420, damping: 20 },
  },
  typing: {
    startDelayMs: 90,
    charMs: 35,
    leadPx: 18,
    widthSpring: { stiffness: 520, damping: 34 },
    caretWidthPx: 2,
    caretGapPx: 3,
    caretBlinkMs: 530,
    caretLingerMs: 1100,
    retypeDelayMs: 90,
  },
  exit: {
    contentFadeMs: 120,
    shrinkDelayMs: 60,
    dropRadiusPx: 9,
    shrink: { stiffness: 520, damping: 34 },
    vanishDelayMs: 200,
    vanishMs: 160,
  },
  interaction: {
    hoverScale: 1.02,
    hover: { stiffness: 300, damping: 24 },
    pressScale: 0.97,
    pressMs: 90,
  },
  pulse: {
    kickSpeed: 170,
  },
  reminder: {
    enabled: true,
    intervalMs: 30000,
    kickSpeed: 120,
  },
};

export type AnimationConfig = typeof animation;
export type SpringConfig = { stiffness: number; damping: number };
