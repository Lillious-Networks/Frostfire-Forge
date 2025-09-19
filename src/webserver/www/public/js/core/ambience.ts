import { serverTime, ambience } from "./ui.ts";

let timeOfDay: string | null = null;
let lastMinute: number | null = null;

function updateTime(time: string) {
  if (!time) return;

  timeOfDay = time;
  const date = new Date(timeOfDay);
  if (isNaN(date.getTime())) return;

  const hours = date.getHours() % 12 || 12;
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  serverTime.innerText = `${hours}:${minutes}:${seconds} ${
    date.getHours() < 12 ? "AM" : "PM"
  }`;

  if (lastMinute === null || date.getMinutes() !== lastMinute) {
    updateAmbience();
    lastMinute = date.getMinutes();
  }
}

function updateAmbience() {
  if (!timeOfDay) return;

  const date = new Date(timeOfDay);
  if (isNaN(date.getTime())) return;

  const hour24 = date.getHours() + date.getMinutes() / 60;

  function smoothstep(t: number) {
    return 0.5 - 0.5 * Math.cos(Math.PI * t);
  }

  function lerpColor(color1: string, color2: string, t: number) {
    const c1 = parseInt(color1.slice(1), 16);
    const c2 = parseInt(color2.slice(1), 16);
    const r1 = (c1 >> 16) & 0xff, g1 = (c1 >> 8) & 0xff, b1 = c1 & 0xff;
    const r2 = (c2 >> 16) & 0xff, g2 = (c2 >> 8) & 0xff, b2 = c2 & 0xff;
    const r = Math.round(r1 + (r2 - r1) * t);
    const g = Math.round(g1 + (g2 - g1) * t);
    const b = Math.round(b1 + (b2 - b1) * t);
    return `rgb(${r},${g},${b})`;
  }

  // Realistic Sun Phases
  const phases = [
    { hour: 0,   color: "#0b0033", opacity: 0.6 },   // midnight
    { hour: 4,   color: "#0b1a40", opacity: 0.55 },  // deep night (pre-dawn blue)
    { hour: 5,   color: "#2a1a5e", opacity: 0.45 },  // early dawn purple
    { hour: 6,   color: "#ff9966", opacity: 0.3 },   // sunrise orange/yellow
    { hour: 7,   color: "#add8e6", opacity: 0.1 },   // morning sky blue
    { hour: 12,  color: "#87ceeb", opacity: 0.05 },  // midday bright sky
    { hour: 18,  color: "#87ceeb", opacity: 0.05 },  // late afternoon (still bright)
    { hour: 19,  color: "#ff6347", opacity: 0.25 },  // sunset warm orange
    { hour: 20,  color: "#191970", opacity: 0.5 },   // dusk deep blue
    { hour: 24,  color: "#0b0033", opacity: 0.6 }    // midnight wrap
  ];

  let phase1, phase2;
  for (let i = 0; i < phases.length - 1; i++) {
    if (hour24 >= phases[i].hour && hour24 <= phases[i + 1].hour) {
      phase1 = phases[i];
      phase2 = phases[i + 1];
      break;
    }
  }
  if (!phase1 || !phase2) return;

  const t = (hour24 - phase1.hour) / (phase2.hour - phase1.hour);
  const easedT = smoothstep(t);

  const blendedColor = lerpColor(phase1.color, phase2.color, easedT);
  const blendedOpacity = phase1.opacity + (phase2.opacity - phase1.opacity) * easedT;

  ambience.style.backgroundColor = blendedColor;
  ambience.style.opacity = blendedOpacity.toFixed(2);
}

export { updateTime };