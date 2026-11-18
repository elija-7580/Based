// Farben und Strichstärken des Boards als Namen – eine Liste für die Fläche (Farbpillen), die Agenten (draw_board)
// und die Prüfung beim Lesen. Die Werte dazu kommen in der App aus den Design-Tokens (editor/whiteboard/render.ts).
// Kein Gelb: die Marker-Farbe gehört den Agenten.

/** Strich- und Textfarben (Stift, Text, Rand einer Form, Verbindung). */
export const BOARD_STROKE_COLORS = ["ink", "gray", "brown", "orange", "green", "blue", "purple", "pink", "red"] as const;
/** Textmarker-Tönungen. */
export const BOARD_HIGHLIGHT_COLORS = ["mint", "sky", "rose", "calm"] as const;
/** Flächen (Zettel, Formen, Rahmen). */
export const BOARD_FILL_COLORS = ["gray", "brown", "orange", "green", "blue", "purple", "pink", "red"] as const;
/** Stiftbreiten (Welt-px) für dünn, mittel, dick. */
export const BOARD_PEN_WIDTHS = [1.6, 2.6, 4.4] as const;
export const BOARD_HIGHLIGHT_WIDTHS = [10, 16, 24] as const;
export const BOARD_WIDTH_NAMES = ["thin", "medium", "thick"] as const;

export type BoardStrokeColor = (typeof BOARD_STROKE_COLORS)[number];
export type BoardFillColor = (typeof BOARD_FILL_COLORS)[number];
export type BoardHighlightColor = (typeof BOARD_HIGHLIGHT_COLORS)[number];
