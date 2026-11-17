export const COLS: number;
export const ROWS: number;
export const CELLS: number;
export const WINDOWS: number[][];
export function idx(c: number, r: number): number;
export function fromMoves(moves: number[]): { board: number[]; heights: number[] };
export function legalColumns(heights: number[]): number[];
export function result(board: number[]): { winner: number; line: number[][] | null } | null;
export function boardText(board: number[], marks?: Record<number, string>): string;
