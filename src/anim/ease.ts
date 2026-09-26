// Courbes d'interpolation : u ∈ [0, 1] → [0, 1].
export type Ease = (u: number) => number;

export const linear: Ease = (u) => u;
export const easeInQuad: Ease = (u) => u * u;
export const easeInCubic: Ease = (u) => u * u * u;
export const easeOutCubic: Ease = (u) => 1 - (1 - u) ** 3;
export const easeInOutSine: Ease = (u) => -(Math.cos(Math.PI * u) - 1) / 2;
