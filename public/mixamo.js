// Mixamo FBX -> VRM retargeting (REQUIREMENTS.md "Technical notes").
// Same method as the official three-vrm "humanoidAnimation" example (loadMixamoAnimation.js).
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

// Mixamo bone name -> VRM humanoid bone name (full table, incl. fingers; Pinky -> Little).
const MIXAMO_TO_VRM = {
  mixamorigHips: 'hips',
  mixamorigSpine: 'spine',
  mixamorigSpine1: 'chest',
  mixamorigSpine2: 'upperChest',
  mixamorigNeck: 'neck',
  mixamorigHead: 'head',
};

for (const side of ['Left', 'Right']) {
  const s = side.toLowerCase(); // 'left' | 'right'
  Object.assign(MIXAMO_TO_VRM, {
    [`mixamorig${side}Shoulder`]: `${s}Shoulder`,
    [`mixamorig${side}Arm`]: `${s}UpperArm`,
    [`mixamorig${side}ForeArm`]: `${s}LowerArm`,
    [`mixamorig${side}Hand`]: `${s}Hand`,
    [`mixamorig${side}UpLeg`]: `${s}UpperLeg`,
    [`mixamorig${side}Leg`]: `${s}LowerLeg`,
    [`mixamorig${side}Foot`]: `${s}Foot`,
    [`mixamorig${side}ToeBase`]: `${s}Toes`,
    [`mixamorig${side}HandThumb1`]: `${s}ThumbMetacarpal`,
    [`mixamorig${side}HandThumb2`]: `${s}ThumbProximal`,
    [`mixamorig${side}HandThumb3`]: `${s}ThumbDistal`,
  });
  for (const [mixamoFinger, vrmFinger] of [
    ['Index', 'Index'],
    ['Middle', 'Middle'],
    ['Ring', 'Ring'],
    ['Pinky', 'Little'],
  ]) {
    MIXAMO_TO_VRM[`mixamorig${side}Hand${mixamoFinger}1`] = `${s}${vrmFinger}Proximal`;
    MIXAMO_TO_VRM[`mixamorig${side}Hand${mixamoFinger}2`] = `${s}${vrmFinger}Intermediate`;
    MIXAMO_TO_VRM[`mixamorig${side}Hand${mixamoFinger}3`] = `${s}${vrmFinger}Distal`;
  }
}

const fbxLoader = new FBXLoader();

/**
 * Load a Mixamo FBX and retarget its "mixamo.com" clip to the given VRM.
 * Must be called while the VRM is still in its rest pose (before any clip plays),
 * because the hips height is measured from the current pose.
 * @param {string} url  FBX url, e.g. "/animations/idle.fbx"
 * @param {import('@pixiv/three-vrm').VRM} vrm
 * @returns {Promise<THREE.AnimationClip>} clip for an AnimationMixer on vrm.scene
 */
export async function loadMixamoAnimation(url, vrm) {
  const fbx = await fbxLoader.loadAsync(url);
  const clip = THREE.AnimationClip.findByName(fbx.animations, 'mixamo.com');
  if (!clip) throw new Error(`No "mixamo.com" clip in ${url}`);

  const isVRM0 = vrm.meta?.metaVersion === '0';
  const tracks = [];
  const restRotationInverse = new THREE.Quaternion(); // R^-1
  const parentRestWorldRotation = new THREE.Quaternion(); // P
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();

  // Hips scale: VRM hips height (hips world y - scene world y) / Mixamo hips rest y.
  const mixamoHipsHeight = fbx.getObjectByName('mixamorigHips').position.y;
  const vrmHipsY = vrm.humanoid.getNormalizedBoneNode('hips').getWorldPosition(v).y;
  const vrmRootY = vrm.scene.getWorldPosition(v).y;
  const hipsScale = Math.abs(vrmHipsY - vrmRootY) / mixamoHipsHeight;

  for (const track of clip.tracks) {
    const [mixamoName, property] = track.name.split('.');
    const vrmBoneName = MIXAMO_TO_VRM[mixamoName];
    if (!vrmBoneName) continue; // unknown bone
    const vrmNode = vrm.humanoid.getNormalizedBoneNode(vrmBoneName);
    const mixamoNode = fbx.getObjectByName(mixamoName);
    if (!vrmNode || !mixamoNode) continue; // bone missing on this avatar / rig

    const trackName = `${vrmNode.name}.${property}`;

    if (track instanceof THREE.QuaternionKeyframeTrack) {
      mixamoNode.getWorldQuaternion(restRotationInverse).invert();
      mixamoNode.parent.getWorldQuaternion(parentRestWorldRotation);

      const values = new Float32Array(track.values.length);
      for (let i = 0; i < track.values.length; i += 4) {
        // q -> P * q * R^-1
        q.fromArray(track.values, i).premultiply(parentRestWorldRotation).multiply(restRotationInverse);
        q.toArray(values, i);
        if (isVRM0) {
          values[i] = -values[i]; // x
          values[i + 2] = -values[i + 2]; // z
        }
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(trackName, track.times, values));
    } else if (track instanceof THREE.VectorKeyframeTrack && property === 'position' && vrmBoneName === 'hips') {
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < track.values.length; i++) {
        const axis = i % 3; // 0=x 1=y 2=z
        const value = isVRM0 && axis !== 1 ? -track.values[i] : track.values[i];
        values[i] = value * hipsScale;
      }
      tracks.push(new THREE.VectorKeyframeTrack(trackName, track.times, values));
    }
    // Other tracks (scale, non-hips positions) are skipped on purpose.
  }

  const name = url.split('/').pop().replace(/\.fbx$/i, '');
  return new THREE.AnimationClip(name, clip.duration, tracks);
}
