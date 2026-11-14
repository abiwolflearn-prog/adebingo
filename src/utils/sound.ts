// Procedural Web Audio API sound effects + Amharic/English Bingo Voice Caller for ADEYBINGO

import { Language } from '../types/bingo';
import { getBingoVoiceCallScript } from './amharicNumbers';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private audioCache = new Map<string, string>();
  private serverTtsUnavailable = false;
  private activeAudio: HTMLAudioElement | null = null;

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  stopVoice() {
    if (this.activeAudio) {
      try {
        this.activeAudio.pause();
        this.activeAudio.currentTime = 0;
      } catch {
        // Ignore
      }
      this.activeAudio = null;
    }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore
      }
    }
  }

  private speakWithBrowserSpeech(ballNumber: number, lang: Language) {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      const synth = window.speechSynthesis;
      const script = getBingoVoiceCallScript(ballNumber, lang);
      const voices = synth.getVoices ? synth.getVoices() : [];
      const utterance = new SpeechSynthesisUtterance();

      if (lang === 'am') {
        const amVoice = voices.find((v) => v.lang.toLowerCase().startsWith('am'));
        if (amVoice) {
          utterance.voice = amVoice;
          utterance.lang = amVoice.lang;
          utterance.text = script.amharicText;
          utterance.rate = 0.96;
        } else {
          // Device lacks an am-ET TTS pack: speak natural phonetic Amharic pronunciation
          utterance.lang = 'en-US';
          utterance.text = script.amharicPhonetic;
          utterance.rate = 0.92;
          utterance.pitch = 1.04;
        }
      } else {
        const enVoice = voices.find((v) => v.lang.toLowerCase().startsWith('en'));
        if (enVoice) utterance.voice = enVoice;
        utterance.lang = 'en-US';
        utterance.text = script.englishText;
        utterance.rate = 1.0;
      }

      synth.cancel();
      synth.speak(utterance);
    } catch {
      // Ignore browser speech errors when blocked by autoplay policy
    }
  }

  private async playAudioDataUri(dataUri: string): Promise<boolean> {
    if (typeof Audio === 'undefined') return false;
    try {
      const audio = new Audio(dataUri);
      this.activeAudio = audio;
      await audio.play();
      return true;
    } catch {
      this.activeAudio = null;
      return false;
    }
  }

  async speakBingoBall(ballNumber: number, lang: Language, enabled: boolean): Promise<void> {
    this.playBallCall(enabled);
    if (!enabled || !Number.isInteger(ballNumber) || ballNumber < 1 || ballNumber > 75) {
      return;
    }

    this.stopVoice();
    const cacheKey = `${lang}:${ballNumber}`;
    const cachedUri = this.audioCache.get(cacheKey);
    if (cachedUri) {
      const played = await this.playAudioDataUri(cachedUri);
      if (played) return;
    }

    if (!this.serverTtsUnavailable && typeof fetch !== 'undefined') {
      try {
        const resp = await fetch(
          `/api/tts/bingo-call?number=${encodeURIComponent(String(ballNumber))}&lang=${encodeURIComponent(lang)}`
        );
        if (resp.ok) {
          const data = (await resp.json().catch(() => null)) as {
            ok?: boolean;
            audioBase64?: string | null;
            mimeType?: string;
            reason?: string;
          } | null;
          if (data?.ok && data.audioBase64) {
            const mime = data.mimeType || 'audio/wav';
            const dataUri = `data:${mime};base64,${data.audioBase64}`;
            this.audioCache.set(cacheKey, dataUri);
            const played = await this.playAudioDataUri(dataUri);
            if (played) return;
          } else if (data?.reason === 'gemini_api_key_not_configured') {
            this.serverTtsUnavailable = true;
          }
        }
      } catch {
        // Fall back seamlessly to Web Speech synthesis
      }
    }

    this.speakWithBrowserSpeech(ballNumber, lang);
  }

  playBallCall(enabled: boolean) {
    if (!enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(780, now + 0.09);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.17);
    } catch {
      // Ignore audio errors when autoplay is blocked
    }
  }

  playDaub(enabled: boolean) {
    if (!enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(990, now + 0.06);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.09);
    } catch {
      // Ignore
    }
  }

  playError(enabled: boolean) {
    if (!enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(190, now);
      osc.frequency.linearRampToValueAtTime(140, now + 0.12);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.15);
    } catch {
      // Ignore
    }
  }

  playWinFanfare(enabled: boolean) {
    if (!enabled) return;
    try {
      const ctx = this.getContext();
      if (!ctx) return;
      // Ethiopian Tizita Major / Pentatonic uplifting celebratory chord arpeggio
      const notes = [523.25, 587.33, 659.25, 783.99, 1046.5];
      notes.forEach((freq, idx) => {
        const start = ctx.currentTime + idx * 0.08;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.16, start);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.36);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.38);
      });
    } catch {
      // Ignore
    }
  }
}

export const soundFX = new SoundEngine();
