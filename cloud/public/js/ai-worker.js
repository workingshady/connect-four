import { bestMove } from "./engine.js";

self.onmessage = (e) => {
  const { id, moves, level } = e.data;
  self.postMessage({ id, col: bestMove(moves, level) });
};
