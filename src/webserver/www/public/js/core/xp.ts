import { xpBar } from "./ui.js";

function updateXp(xp: number, level: number, max_xp: number) {
  const xscale = Math.max(0, Math.min(1, xp / max_xp)) || 0;
  xpBar.animate([
    { transform: `scaleX(${xscale})` }
  ], {
    duration: 0,
    fill: 'forwards'
  });
}

export { updateXp }