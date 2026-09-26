import messages from './messages.json';

export type NoticeKind = keyof typeof messages;

// 32 caractères au plus par texte : au-delà, la pilule dépasserait sa largeur maximale.
export const MAX_MESSAGE_LENGTH = 32;

const last: Partial<Record<NoticeKind, string>> = {};

// Tirage au hasard, jamais deux fois de suite le même texte pour un même type.
export function pickMessage(kind: NoticeKind): string {
  const pool = messages[kind].filter((m) => m !== last[kind]);
  const text = pool[Math.floor(Math.random() * pool.length)] ?? messages[kind][0];
  last[kind] = text;
  return text;
}
