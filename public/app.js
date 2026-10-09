// Milestone 1: scene, VRM avatar, Mixamo clips, click-to-start intro, idle + blink.
// Hooks for later milestones are marked "M2:", "M3:", "M4:", "M5:".
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { loadMixamoAnimation } from './mixamo.js';

const AVATAR_URL = '/avatars/CoolPineapple.vrm'; // M5: may come from the server "config" message
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

/** Switch assistant state and crossfade to its clip. Not called yet in M1. */
export function setState(next) {
  if (!(next in STATE_CLIPS)) next = 'idle';
  state = next;
  if (introDone) playClip(STATE_CLIPS[state]);
  // M4: stop dance when leaving idle via a new message; set emotion only while speaking.
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

/** M3: lip sync. Each frame: now = (audioCtx.currentTime - startTime - (audioCtx.outputLatency || 0)) * 1000,
 *  pick last viseme with time <= now, set aa/ih/ou/ee/oh per REQUIREMENTS.md table (others 0). */
function updateLipSync(_delta) {}

/** M4: emotion (happy/angry/sad/relaxed ~0.7 while speaking, eased back to 0 after). */
function updateEmotion(_delta) {}

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
async function loadAvatar() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(AVATAR_URL);
  const avatar = gltf.userData.vrm;
  VRMUtils.rotateVRM0(avatar); // VRM 0.x faces away otherwise
  avatar.scene.traverse((obj) => { obj.frustumCulled = false; });
  scene.add(avatar.scene);
  return avatar;
}

async function init() {
  vrm = await loadAvatar();
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
  // M5: send {"type":"start"} over the WebSocket here so the server speaks the greeting.
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

// ---------- Chat UI hooks (no networking in M1) ----------
chatForm.addEventListener('submit', (e) => {
  e.preventDefault(); // Enter or Send
  // M2: open one WebSocket to /ws; send {"type":"chat","text": chatInput.value.slice(0, 500)};
  //     disable sendBtn while waiting; show reply text in `bubble`; on error show a friendly message and re-enable.
  // M4: stop the dance when a message is sent; setState('thinking') on send / "thinking" message.
});

danceBtn.addEventListener('click', () => {
  // M4: toggle playClip('dance') + /music/dance.mp3 via audioCtx; update aria-pressed; press again -> idle.
});

init().catch((err) => {
  console.error(err);
  startBtn.textContent = 'Failed to load the character';
});
