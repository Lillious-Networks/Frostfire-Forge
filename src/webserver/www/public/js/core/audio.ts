
const audioCache = new Map<string, string>();
import { getUserHasInteracted } from "./input.js";
import { musicSlider, effectsSlider, mutedCheckbox } from "./ui.js";
import pako from '../libs/pako.js';

export function playMusic(name: string, data: Uint8Array, timestamp: number): void {
  if (!getUserHasInteracted()) {
    setTimeout(() => {
      playMusic(name, data, timestamp);
    }, 100);
    return;
  }
  // Check if the audio is already cached, if not, inflate the data
    // @ts-expect-error - pako is not defined because it is loaded in the index.html
    const cachedAudio = timestamp < performance.now() - 3.6e+6 ? pako.inflate(new Uint8Array(data),{ to: 'string' }) : audioCache.get(name)|| pako.inflate(new Uint8Array(data), { to: 'string' });
    const music = new Audio(`data:audio/wav;base64,${cachedAudio}`);
    if (!music) {
      console.error("Failed to create audio element");
      return;
    }
    const musicVolume = Number(musicSlider.value);
    music.volume = mutedCheckbox.checked || musicVolume === 0 ? 0 : musicVolume / 100;
    music.loop = true;
    try {
      music.play();
      // Cache the audio
      audioCache.set(name, cachedAudio);
      startMusicInterval(music);
    } catch (e) {
      console.error(e);
    }
}

function startMusicInterval(music: any) {
  setInterval(() => {
    const musicVolume = Number(musicSlider.value);
    music.volume = mutedCheckbox.checked || musicVolume === 0 ? 0 : musicVolume / 100;
  }, 100);
}

export function playAudio(name: string, data: Uint8Array, pitch: number, timestamp: number): void {
  // Keep retrying to play the audio until the user has interacted with the page
  if (!getUserHasInteracted()) {
    setTimeout(() => {
      playAudio(name, data, pitch, timestamp);
    }, 100);
    return;
  }
  // Get mute status
  if (mutedCheckbox.checked) return;
  // Get effects volume
  const volume = effectsSlider.value === "0" ? 0 : Number(effectsSlider.value) / 100;
  // Check if the audio is already cached, if not, inflate the data
  // @ts-expect-error - pako is not defined because it is loaded in the index.html
  const cachedAudio = timestamp < performance.now() - 3.6e+6 ? pako.inflate(new Uint8Array(data),{ to: 'string' }) : audioCache.get(name)|| pako.inflate(new Uint8Array(data), { to: 'string' });
  const audio = new Audio(`data:audio/wav;base64,${cachedAudio}`);
  if (!audio) {
    console.error("Failed to create audio element");
    return;
  }
  audio.playbackRate = pitch;
  audio.volume = volume;
  // Auto play
  audio.autoplay = true;

  try {
    audio.play();
    // Cache the audio
    audioCache.set(name, cachedAudio);
  } catch (e) {
    console.error(e);
  }  
}