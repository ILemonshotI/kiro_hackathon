// Scene, VRM avatar, Mixamo clips, click-to-start intro, idle + blink (M1),
// chat over one WebSocket (M2), Polly playback + lip sync + bubble (M3),
// emotion, state animations, dance (M4), greeting + config (M5).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './mixamo.js';

// The avatar URL comes from the server "config" message (character.json "avatar").
const CLIP_NAMES = ['idle', 'thinking', 'talking', 'dance', 'fall-flat', 'stand-up'];
const FADE = 0.4;

// ---------- DOM ----------
const stage = document.getElementById('stage');
const overlay = document.getElementById('overlay');
const startBtn = document.getElementById('start-btn');
const chatForm = document.getElementById('chat');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const danceBtn = document.getElementById('dance-btn');
const bubble = document.getElementById('bubble');

// ---------- Audio (one shared context; resumed on the first click) ----------
// M3: decodeAudioData + AudioBufferSourceNode for Polly mp3; lip sync reads audioCtx.currentTime.
// M4: dance.mp3 also plays through this context.
export const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

// ---------- Three.js scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0); // transparent: CSS gradient shows through
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 0.1, 20);
camera.position.set(0, 1.0, 4.0);
camera.lookAt(0, 0.75, 0);

scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.0);
sun.position.set(1, 2, 3);
scene.add(sun);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- Avatar + animation state ----------
let vrm = null;
let mixer = null;
const actions = {}; // clip name -> AnimationAction
let currentAction = null;

/**
 * Crossfade from the current clip to `name`.
 * @param {string} name clip name (see CLIP_NAMES)
 * @param {{loop?: boolean, startAt?: number, timeScale?: number, fade?: number}} [opts]
 * @returns {THREE.AnimationAction | undefined}
 */
function playClip(name, { loop = true, startAt = 0, timeScale = 1, fade = FADE } = {}) {
  const next = actions[name];
  if (!next) return undefined;
  if (next === currentAction && next.isRunning()) return next;
  next.reset();
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
  next.clampWhenFinished = !loop;
  next.time = startAt;
  next.setEffectiveTimeScale(timeScale);
  next.setEffectiveWeight(1);
  next.play();
  if (currentAction && currentAction !== next) currentAction.crossFadeTo(next, fade, false);
  currentAction = next;
  return next;
}

/** Resolve when a LoopOnce action fires the mixer's "finished" event. */
function waitFinished(action) {
  return new Promise((resolve) => {
    const onFinished = (e) => {
      if (e.action !== action) return;
      mixer.removeEventListener('finished', onFinished);
      resolve();
    };
    mixer.addEventListener('finished', onFinished);
  });
}

// ---------- State machine (M4 wires it to chat/audio events) ----------
// idle -> listening -> thinking -> speaking -> idle
const STATE_CLIPS = {
  idle: 'idle',
  listening: 'idle', // no listening clip; bonus A shows a mic indicator instead
  thinking: 'thinking',
  speaking: 'talking',
};
let state = 'idle';
let introDone = false;

let dancing = false;

/** Switch assistant state and crossfade to its clip (a running dance resumes in idle). */
export function setState(next) {
  if (!(next in STATE_CLIPS)) next = 'idle';
  state = next;
  if (introDone) playClip(dancing && state === 'idle' ? 'dance' : STATE_CLIPS[state]);
}

// ---------- Face: blink, lip sync, emotion ----------
const BLINK_DURATION = 0.15; // seconds
let nextBlinkIn = 2 + Math.random() * 4;
let blinkTime = -1; // <0 = not blinking

function updateBlink(delta) {
  const em = vrm?.expressionManager;
  if (!em) return;
  if (blinkTime < 0) {
    nextBlinkIn -= delta;
    if (nextBlinkIn <= 0) blinkTime = 0;
    return;
  }
  blinkTime += delta;
  const t = blinkTime / BLINK_DURATION; // 0..1 close, 1..2 open
  if (t >= 2) {
    em.setValue('blink', 0);
    blinkTime = -1;
    nextBlinkIn = 2 + Math.random() * 4; // every 2-6 s
  } else {
    em.setValue('blink', t < 1 ? t : 2 - t);
  }
}

// Current speech: { source, startTime, visemes } while Polly audio plays, else null.
let speech = null;

const MOUTH = ['aa', 'ih', 'ou', 'ee', 'oh'];
// Polly viseme -> mouth weights (REQUIREMENTS.md table); unlisted visemes = closed.
const VISEME_MAP = {
  a: { aa: 1.0 },
  '@': { aa: 0.5 },
  e: { ee: 0.8 },
  E: { ee: 0.6, aa: 0.3 },
  i: { ih: 0.8 },
  o: { oh: 0.9 },
  O: { oh: 0.7, aa: 0.3 },
  u: { ou: 0.9 },
  t: { ih: 0.3 },
  s: { ih: 0.3 },
  T: { ih: 0.3 },
  S: { ou: 0.3, ih: 0.2 },
  k: { aa: 0.3 },
  r: { ou: 0.3 },
  f: { ih: 0.2 },
};

/** Lip sync: last viseme with time <= now sets the mouth, all other mouth morphs to 0. */
function updateLipSync(_delta) {
  const em = vrm?.expressionManager;
  if (!em) return;
  let weights = {};
  if (speech) {
    const now = (audioCtx.currentTime - speech.startTime - (audioCtx.outputLatency || 0)) * 1000;
    let current = null;
    for (const v of speech.visemes) {
      if (v.time > now) break;
      current = v.value;
    }
    weights = VISEME_MAP[current] || {};
  }
  for (const m of MOUTH) em.setValue(m, weights[m] || 0);
}

const EMOTIONS = ['happy', 'angry', 'sad', 'relaxed'];
const EMOTION_LEVEL = 0.7;
const EMOTION_SPEED = 3; // weight units per second (ease in/out)
let emotion = 'neutral';
const emotionValues = { happy: 0, angry: 0, sad: 0, relaxed: 0 };

/** Emotion: ease the chosen morph to ~0.7 while speaking, back to 0 after; neutral = all 0. */
function updateEmotion(delta) {
  const em = vrm?.expressionManager;
  if (!em) return;
  const speaking = state === 'speaking';
  for (const e of EMOTIONS) {
    const target = speaking && e === emotion ? EMOTION_LEVEL : 0;
    const v = emotionValues[e];
    const step = EMOTION_SPEED * delta;
    emotionValues[e] = v < target ? Math.min(target, v + step) : Math.max(target, v - step);
    em.setValue(e, emotionValues[e]);
  }
}

// ---------- Render loop: mixer.update -> vrm.update -> render, every frame ----------
let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const delta = Math.min((now - last) / 1000, 0.1);
  last = now;

  if (mixer) mixer.update(delta);
  if (vrm) {
    updateBlink(delta);
    updateLipSync(delta);
    updateEmotion(delta);
    vrm.update(delta);
  }
  renderer.render(scene, camera);
});

// ---------- Loading ----------
async function loadAvatar(url) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const avatar = gltf.userData.vrm;
  VRMUtils.rotateVRM0(avatar); // VRM 0.x faces away otherwise
  avatar.scene.traverse((obj) => { obj.frustumCulled = false; });
  scene.add(avatar.scene);
  return avatar;
}

async function init(avatarUrl) {
  vrm = await loadAvatar(avatarUrl);
  vrm.scene.updateMatrixWorld(true); // rest pose world matrices for retargeting

  // Retarget all clips while the avatar is still in rest pose.
  const clips = await Promise.all(
    CLIP_NAMES.map((name) => loadMixamoAnimation(`/animations/${name}.fbx`, vrm)),
  );
  mixer = new THREE.AnimationMixer(vrm.scene);
  clips.forEach((clip, i) => { actions[CLIP_NAMES[i]] = mixer.clipAction(clip); });

  playClip('idle', { fade: 0 }); // idle behind the overlay until the user clicks
  startBtn.disabled = false;
  startBtn.textContent = 'Click to start';
  startBtn.focus();
}

// ---------- Intro: fall-flat -> stand-up (skip 2.5 s, 1.6x) -> idle ----------
async function playIntro() {
  const fall = playClip('fall-flat', { loop: false });
  await waitFinished(fall);
  const stand = playClip('stand-up', { loop: false, startAt: 2.5, timeScale: 1.6 });
  await waitFinished(stand);
  introDone = true;
  playClip(STATE_CLIPS[state]);
  requestGreeting();
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  try {
    await audioCtx.resume();
  } catch (err) {
    console.warn('AudioContext.resume failed', err);
  }
  overlay.hidden = true;
  chatInput.focus();
  await playIntro();
});

// ---------- Speech bubble ----------
let bubbleTimer = 0;

function showBubble(text, { error = false, hideAfterMs = 0 } = {}) {
  clearTimeout(bubbleTimer);
  bubble.textContent = text;
  bubble.classList.toggle('error', error);
  bubble.hidden = false;
  if (hideAfterMs > 0) bubbleTimer = setTimeout(hideBubble, hideAfterMs);
}

function hideBubble() {
  clearTimeout(bubbleTimer);
  bubble.hidden = true;
}

// ---------- Speech playback (Polly mp3 + visemes) ----------
function stopSpeech() {
  if (!speech) return;
  const { source } = speech;
  speech = null;
  source.onended = null;
  try { source.stop(); } catch { /* already stopped */ }
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Text-only answer (no audio): show the bubble for a reading-time duration. */
function showTextOnly(text) {
  setState('idle');
  showBubble(text, { hideAfterMs: Math.max(3000, text.length * 70) });
}

async function playReply(msg) {
  stopSpeech();
  emotion = EMOTIONS.includes(msg.emotion) ? msg.emotion : 'neutral';
  if (!msg.audio) {
    showTextOnly(msg.text);
    runMove(msg.move);
    return;
  }
  let buffer;
  try {
    buffer = await audioCtx.decodeAudioData(base64ToArrayBuffer(msg.audio));
  } catch (err) {
    console.warn('Could not decode reply audio', err);
    showTextOnly(msg.text);
    runMove(msg.move);
    return;
  }
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  const visemes = Array.isArray(msg.visemes) ? msg.visemes : [];
  speech = { source, startTime: audioCtx.currentTime, visemes };
  source.onended = () => {
    if (speech?.source !== source) return;
    speech = null;
    hideBubble();
    setState('idle');
    runMove(msg.move); // bonus B: moves start after the voice ends
  };
  showBubble(msg.text);
  setState('speaking');
  source.start(speech.startTime);
}

// ---------- Dance (clip loop + dance.mp3) ----------
let danceBuffer = null;
let danceSource = null;

async function startDance() {
  if (!introDone || dancing) return;
  dancing = true;
  danceBtn.setAttribute('aria-pressed', 'true');
  playClip('dance');
  try {
    if (!danceBuffer) {
      const res = await fetch('/music/dance.mp3');
      danceBuffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
    }
    if (!dancing) return; // stopped while loading
    danceSource = audioCtx.createBufferSource();
    danceSource.buffer = danceBuffer;
    danceSource.loop = true;
    danceSource.connect(audioCtx.destination);
    danceSource.start();
  } catch (err) {
    console.warn('Dance music failed', err);
  }
}

function stopDance() {
  if (!dancing) return;
  dancing = false;
  danceBtn.setAttribute('aria-pressed', 'false');
  if (danceSource) {
    try { danceSource.stop(); } catch { /* already stopped */ }
    danceSource = null;
  }
  playClip(STATE_CLIPS[state]);
}

// ---------- Bonus B: moves chosen by the AI (from character.json "moves") ----------
let MOVES = {}; // name -> { file, loop }
let moveToken = 0; // bumped on every new message so a running one-shot move stops its follow-ups

async function runMove(name) {
  const move = MOVES[name];
  if (!move || !introDone || !CLIP_NAMES.includes(move.file)) return;
  const token = ++moveToken;
  if (move.file === 'dance') { startDance(); return; } // dance loop + music
  if (move.loop) { playClip(move.file); return; }
  const action = playClip(move.file, { loop: false });
  await waitFinished(action);
  if (token !== moveToken) return;
  if (move.file === 'fall-flat') { // get back up after fainting
    const stand = playClip('stand-up', { loop: false, startAt: 2.5, timeScale: 1.6 });
    await waitFinished(stand);
    if (token !== moveToken) return;
  }
  playClip(STATE_CLIPS[state]);
}

danceBtn.addEventListener('click', () => {
  if (dancing) stopDance();
  else startDance();
});

// ---------- WebSocket (one per page) ----------
let socket = null;
let waiting = false; // one request at a time
let greetingWanted = false; // intro finished, greeting not sent yet
let greetingSent = false;
let lastSent = ''; // text of the message waiting for an answer

function setWaiting(on) {
  waiting = on;
  sendBtn.disabled = on;
}

function showError(message) {
  setWaiting(false);
  stopSpeech();
  setState('idle');
  showBubble(message || 'Oops, something went wrong. Please try again.', { error: true, hideAfterMs: 6000 });
}

let avatarRequested = false;

function applyConfig(cfg) {
  // Load the VRM once, from the first config (reconnects resend config).
  if (!avatarRequested && cfg.avatar) {
    avatarRequested = true;
    init(cfg.avatar).catch((err) => {
      console.error(err);
      startBtn.textContent = 'Failed to load the character';
    });
  }
  if (Array.isArray(cfg.moves)) {
    MOVES = Object.fromEntries(cfg.moves.map((m) => [m.name, { file: m.file, loop: !!m.loop }]));
  }
  if (cfg.name) {
    document.title = cfg.name;
    chatInput.placeholder = `Say something to ${cfg.name.split(' ')[0]}...`;
  }
  if (Array.isArray(cfg.background) && cfg.background.length >= 2) {
    document.documentElement.style.setProperty('--bg1', cfg.background[0]);
    document.documentElement.style.setProperty('--bg2', cfg.background[1]);
  }
}

function sendStartIfReady() {
  if (!greetingWanted || greetingSent || socket?.readyState !== WebSocket.OPEN) return;
  greetingSent = true;
  setWaiting(true);
  socket.send(JSON.stringify({ type: 'start' }));
}

function requestGreeting() {
  greetingWanted = true;
  sendStartIfReady();
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws`);
  socket = ws;
  ws.addEventListener('open', sendStartIfReady);
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'config') applyConfig(msg);
    else if (msg.type === 'thinking') setState('thinking');
    else if (msg.type === 'reply') {
      setWaiting(false);
      // Clear the box only once really answered, so a failed message can be retried as-is.
      if (!msg.fallback && lastSent && chatInput.value.trim().slice(0, 500) === lastSent) chatInput.value = '';
      lastSent = '';
      playReply(msg);
    } else if (msg.type === 'error') showError(msg.message);
  });
  ws.addEventListener('close', () => {
    if (socket !== ws) return;
    socket = null;
    if (waiting) showError("I lost my connection to the shop. Please try again in a moment.");
    setTimeout(connect, 2000); // reconnect quietly; the next message can retry
  });
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault(); // Enter or Send
  if (waiting) return;
  const text = chatInput.value.trim().slice(0, 500);
  if (!text) return;
  if (socket?.readyState !== WebSocket.OPEN) {
    showError("I can't reach the shop right now. Please try again in a moment.");
    return;
  }
  moveToken++;
  stopDance();
  stopSpeech();
  hideBubble();
  setWaiting(true);
  setState('thinking');
  socket.send(JSON.stringify({ type: 'chat', text }));
  lastSent = text;
});

connect(); // the avatar loads when the server's "config" message arrives
