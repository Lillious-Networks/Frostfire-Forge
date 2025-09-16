
const audioCache = new Map<string, string>();
import { getUserHasInteracted } from "./input.js";
import { musicSlider, effectsSlider, mutedCheckbox } from "./ui.js";
import pako from '../libs/pako.js';

export function playMusic(name: string, data: Uint8Array, timestamp: number): void {
    // Check if the user has interacted with the page yet
    if (!getUserHasInteracted()) {
        console.warn("Audio blocked: waiting for user interaction.");
        return; // Safari will not allow autoplay without gesture
    }

    // Inflate or retrieve cached audio
    let cachedAudio: string | undefined;
    if (timestamp < performance.now() - 3.6e6) {
        // Older than 1 hour: re-inflate
        // @ts-expect-error - pako is loaded in index.html
        cachedAudio = pako.inflate(new Uint8Array(data), { to: 'string' });
    } else {
        // @ts-expect-error - pako is loaded in index.html
        cachedAudio = audioCache.get(name) || pako.inflate(new Uint8Array(data), { to: 'string' });
    }

    if (!cachedAudio) {
        console.error("Failed to decode audio data.");
        return;
    }

    // Create audio element
    const music = new Audio(`data:audio/wav;base64,${cachedAudio}`);
    if (!music) {
        console.error("Failed to create audio element.");
        return;
    }

    // Set volume based on slider and muted state
    const musicVolume = Number(musicSlider.value);
    music.volume = mutedCheckbox.checked || musicVolume === 0 ? 0 : musicVolume / 100;
    music.loop = true;

    // Play the audio
    try {
        const playPromise = music.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                console.error("Audio play failed:", err);
                // Optional: show a "Click to start music" prompt here for Safari
            });
        }

        // Cache inflated audio for later
        audioCache.set(name, cachedAudio);

        // Start interval if needed (for UI updates or other logic)
        startMusicInterval(music);
    } catch (e) {
        console.error("Unexpected audio error:", e);
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