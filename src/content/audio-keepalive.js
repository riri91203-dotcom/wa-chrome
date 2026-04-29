/**
 * content/audio-keepalive.js
 *
 * 音频保活模块：播放极低音量正弦波，让 Chrome 认为标签页
 * 正在播放媒体，从而豁免后台标签页的定时器节流。
 *
 * 频率 30Hz（人耳几乎不可闻），音量 0.0004（极低）。
 */

let audioCtx = null;
let oscillator = null;
let gainNode = null;
let started = false;

export function startAudioKeepAlive() {
  if (started) return;
  started = true;

  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    oscillator = audioCtx.createOscillator();
    gainNode = audioCtx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setTargetAtTime(30, audioCtx.currentTime, 0.5);
    gainNode.gain.setTargetAtTime(0.0004, audioCtx.currentTime, 0);

    oscillator.start();

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  } catch (e) {
    started = false;
  }
}

export function stopAudioKeepAlive() {
  if (!started) return;
  started = false;

  try {
    if (oscillator) {
      oscillator.stop();
      oscillator.disconnect();
      oscillator = null;
    }
    if (gainNode) {
      gainNode.disconnect();
      gainNode = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
  } catch (e) {
    // 清理失败时静默降级
  }
}
