import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  XiangqiGame,
  PIECES,
  chooseBestMove,
  sideOf,
  pieceType,
  moveToNotation,
} from './game-logic.js';

const canvas = document.querySelector('#scene');
const sceneWrap = document.querySelector('#scene-wrap');
const ui = {
  turnDot: document.querySelector('#turn-dot'),
  turnLabel: document.querySelector('#turn-label'),
  turnSub: document.querySelector('#turn-sub'),
  round: document.querySelector('#round-count'),
  status: document.querySelector('#status-message'),
  statusStrip: document.querySelector('#status-strip'),
  toast: document.querySelector('#toast'),
  hint: document.querySelector('#scene-hint'),
  log: document.querySelector('#event-log'),
  redMaterial: document.querySelector('#red-material'),
  blackMaterial: document.querySelector('#black-material'),
  sound: document.querySelector('#sound-toggle'),
  modeLabel: document.querySelector('#mode-label'),
  undo: document.querySelector('#undo-button'),
};

const isTouchDevice = matchMedia('(pointer: coarse)').matches;
const prefersReducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const BOARD = { width: 9, height: 10, spacing: 1 };
const COLORS = {
  // Both armies wear gilded lamellar armour; lacquer cords and banners carry
  // the faction colour, keeping the human figures close to the references.
  red: { body: 0x6b4237, edge: 0xb33d32, metal: 0xc9a66a, ink: '#f0c083' },
  black: { body: 0x4d4943, edge: 0x39727a, metal: 0xbda66f, ink: '#d9dfd2' },
};

let renderer;
let camera;
let controls;
let scene;
let battleGroup;
let boardGroup;
let pieceLayer;
let markerLayer;
let targetLayer;
let effectLayer;
let raycaster;
let pointer = new THREE.Vector2();
let pointerDown = null;
let resizeObserver;
let animationFrame;
let selected = null;
let selectedMoves = [];
let animating = false;
let aiTimer = null;
let mode = 'ai';
let soundEnabled = true;
let toastTimer = null;
let hintTimer = null;
let cameraShake = 0;
let shakeOffset = new THREE.Vector3();
let lastFrame = performance.now();
let narrowViewport = null;
let game = new XiangqiGame();
const piecesOnBoard = new Map();
const markersOnBoard = new Map();
const effects = [];
const torches = [];
const battlefieldSmoke = [];
const eventLines = [];
let aerialMudTexture;
let audio;

const clock = new THREE.Clock();

function init() {
  setupRenderer();
  setupScene();
  setupBoard();
  setupInteractionTargets();
  setupUI();
  renderBoard();
  updateHud();
  resize();
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(sceneWrap);
  window.addEventListener('resize', resize, { passive: true });
  window.addEventListener('orientationchange', () => setTimeout(resize, 80), { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) audio.suspend(); else audio.resume();
  });
  animationFrame = requestAnimationFrame(renderLoop);
}

function setupRenderer() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouchDevice, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouchDevice ? 1.25 : 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = !isTouchDevice;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}

function setupScene() {
  scene = new THREE.Scene();
  // A smoky dusk palette keeps the battlefield readable on a phone while
  // leaving enough warm horizon light for the Han and Chu camps to separate.
  scene.background = new THREE.Color(0x211d1c);
  scene.fog = new THREE.FogExp2(0x211d1c, isTouchDevice ? 0.008 : 0.0105);

  camera = new THREE.PerspectiveCamera(isTouchDevice ? 42 : 32, 1, 0.1, 100);
  camera.position.set(0, isTouchDevice ? 18.7 : 12.2, isTouchDevice ? 22.4 : 14.2);
  camera.lookAt(0, .48, 0);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, .48, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.minDistance = 10;
  controls.maxDistance = isTouchDevice ? 29 : 20;
  controls.minPolarAngle = 0.52;
  controls.maxPolarAngle = 1.24;
  controls.enablePan = false;
  controls.saveState();

  const hemi = new THREE.HemisphereLight(0xc2a68a, 0x2d211b, 1.12);
  scene.add(hemi);
  const warm = new THREE.DirectionalLight(0xffc487, 2.25);
  warm.position.set(-7, 13, 8);
  warm.castShadow = !isTouchDevice;
  if (warm.shadow) {
    warm.shadow.mapSize.set(isTouchDevice ? 512 : 1024, isTouchDevice ? 512 : 1024);
    warm.shadow.camera.left = -12;
    warm.shadow.camera.right = 12;
    warm.shadow.camera.top = 14;
    warm.shadow.camera.bottom = -14;
  }
  scene.add(warm);
  const moon = new THREE.DirectionalLight(0x8fa2b1, 0.86);
  moon.position.set(8, 10, -10);
  scene.add(moon);

  battleGroup = new THREE.Group();
  scene.add(battleGroup);
  boardGroup = new THREE.Group();
  pieceLayer = new THREE.Group();
  markerLayer = new THREE.Group();
  targetLayer = new THREE.Group();
  effectLayer = new THREE.Group();
  battleGroup.add(boardGroup, pieceLayer, markerLayer, targetLayer, effectLayer);

  setupGroundAndHorizon();
  setupBattlefieldDecor();
}

function setupGroundAndHorizon() {
  // The playable ground shares the same open mud plain as the horizon.  A
  // repeating CC0 field photograph gives the large surface believable tire
  // scars while the small CanvasTexture patches below add grass, ash and wet
  // churn without another heavy texture download.
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(46, 24),
    new THREE.MeshBasicMaterial({ map: makeSkyTexture(), depthWrite: false, side: THREE.DoubleSide }),
  );
  sky.position.set(0, 6.4, -17.5);
  scene.add(sky);

  const groundGeometry = new THREE.PlaneGeometry(64, 52, 28, 22);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPositions = groundGeometry.attributes.position;
  for (let i = 0; i < groundPositions.count; i += 1) {
    const x = groundPositions.getX(i);
    const z = groundPositions.getZ(i);
    const ripple = Math.sin(x * .31 + z * .17) * .08 + Math.cos(z * .43 - x * .16) * .055;
    const broadRise = .57 * Math.exp(-((x / 16) ** 2 + (z / 18) ** 2));
    const shallowBasin = Math.exp(-((z + .2) * (z + .2)) / 28) * .04;
    groundPositions.setY(i, ripple - .25 + broadRise - shallowBasin);
  }
  groundGeometry.computeVertexNormals();
  aerialMudTexture = new THREE.TextureLoader().load('./assets/textures/aerial-mud-2k.jpg');
  aerialMudTexture.colorSpace = THREE.SRGBColorSpace;
  aerialMudTexture.wrapS = THREE.RepeatWrapping;
  aerialMudTexture.wrapT = THREE.RepeatWrapping;
  aerialMudTexture.repeat.set(5.2, 4.4);
  const ground = new THREE.Mesh(
    groundGeometry,
    new THREE.MeshStandardMaterial({ map: aerialMudTexture, color: 0xa27b5a, roughness: .99, metalness: .01 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  addTerrainPatch(-12.2, -6.6, 5.6, 3.1, 'grass', -.18, -.12);
  addTerrainPatch(11.2, -2.2, 4.4, 2.8, 'grass', .32, -.1);
  addTerrainPatch(-10.7, 4.4, 4.9, 2.5, 'mud', .08, -.08);
  addTerrainPatch(10.4, 5.7, 4.6, 2.8, 'char', -.26, -.06);
  addTerrainPatch(-6.7, -9.0, 4.8, 2.1, 'char', .12, -.1);
  addTerrainPatch(6.7, 8.4, 5.1, 2.3, 'mud', -.22, -.07);

  addDistantRidge(-15.8, 0x2e2928, .92, 0);
  addDistantRidge(-14.8, 0x47362d, .66, 1.4);

  // Scattered earth mounds break the silhouette outside the playable area.
  const mounds = [
    [-10.8, -4.5, .85], [-8.8, -8.0, .6], [9.6, -4.9, .72], [11.1, 2.7, .85],
    [-10.6, 4.8, .7], [9.3, 7.3, .58], [-7.7, 8.1, .5], [7.2, -8.1, .68],
  ];
  for (const [x, z, size] of mounds) addMudMound(x, z, size);
}

function setupBattlefieldDecor() {
  // Xiang Yu's Chu camp sits beyond the northern bank; Liu Bang's Han camp
  // answers it from the south.  The labels are deliberately sparse so the
  // scene reads as a battlefield first and a diagram second.
  addCamp(-.5, -7.25, 'black', '楚', 1);
  addCamp(.55, 7.25, 'red', '汉', -1);

  addFlag(-4.95, -6.1, '楚', COLORS.black.edge, true);
  addFlag(4.95, 6.1, '汉', COLORS.red.edge, true);
  addTorch(-4.8, -6.15, .78);
  addTorch(4.8, 6.15, .78);

  addRefuseStakeLine(-5.15, -4.0, 1, COLORS.black.edge);
  addRefuseStakeLine(5.1, 4.0, -1, COLORS.red.edge);
  addWheelRuts(-3.7, -2.05, .72, .28);
  addWheelRuts(3.7, 2.15, -.68, .31);
  addReedCluster(-4.6, -.18, .9);
  addReedCluster(4.65, .28, -.85);
  addSmokeColumn(-1.25, -7.0, 1.2);
  addSmokeColumn(1.35, 7.0, 1.05);
  addBattlefieldScatter();
  addAbandonedFire(-5.9, -2.6, .82);
  addAbandonedFire(5.75, 3.05, .72);
  addFallenBanner(-5.65, 2.25, COLORS.black.edge, -.42);
  addFallenBanner(5.55, -2.1, COLORS.red.edge, .36);
}

function makeSkyTexture() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const ctx = c.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, c.height);
  gradient.addColorStop(0, '#141a20');
  gradient.addColorStop(.48, '#3a3030');
  gradient.addColorStop(.78, '#8c5540');
  gradient.addColorStop(1, '#bf7650');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, c.width, c.height);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function addDistantRidge(z, color, opacity, phase = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(-24, 0);
  for (let x = -24; x <= 24; x += 1.8) {
    const y = 1.1 + Math.sin(x * .32 + phase) * .48 + Math.sin(x * .91 + phase * 1.8) * .18;
    shape.lineTo(x, y);
  }
  shape.lineTo(24, 0); shape.lineTo(-24, 0); shape.closePath();
  const ridge = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  ridge.position.set(0, -.2, z);
  scene.add(ridge);
}

function makeTerrainTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const palettes = {
    grass: ['#3c4634', '#52563a', '#726843', '#252c24'],
    mud: ['#44352a', '#68503a', '#826344', '#2e2722'],
    char: ['#302723', '#45312a', '#69503d', '#211f1d'],
  };
  const colors = palettes[kind];
  ctx.fillStyle = colors[0]; ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 260; i += 1) {
    const x = Math.random() * 256; const y = Math.random() * 256;
    const length = 4 + Math.random() * 22;
    ctx.strokeStyle = colors[1 + (Math.random() * 3 | 0)];
    ctx.globalAlpha = .12 + Math.random() * .23;
    ctx.lineWidth = .5 + Math.random() * 2.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + length, y + (Math.random() - .5) * 5); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1.6, 1.25);
  return texture;
}

function addTerrainPatch(x, z, width, depth, kind, rotation = 0, y = -.1) {
  const geometry = new THREE.PlaneGeometry(width, depth, 1, 1);
  const material = new THREE.MeshStandardMaterial({
    map: makeTerrainTexture(kind),
    color: kind === 'grass' ? 0xa6a57e : kind === 'char' ? 0x9c7962 : 0xb29a7e,
    transparent: true,
    opacity: kind === 'grass' ? .56 : .4,
    roughness: 1,
    depthWrite: false,
  });
  const patch = new THREE.Mesh(geometry, material);
  patch.rotation.x = -Math.PI / 2;
  patch.rotation.z = rotation;
  patch.position.set(x, y, z);
  patch.receiveShadow = true;
  scene.add(patch);
}

function addMudMound(x, z, size) {
  const mound = new THREE.Mesh(
    new THREE.DodecahedronGeometry(size, 1),
    new THREE.MeshStandardMaterial({ color: 0x514038, roughness: .98, metalness: 0 }),
  );
  mound.position.set(x, size * .38 - .08, z);
  mound.scale.set(1.35, .42, .9);
  mound.rotation.y = (x + z) * .17;
  mound.castShadow = true;
  mound.receiveShadow = true;
  scene.add(mound);
}

function makeWaterTexture() {
  const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 64);
  gradient.addColorStop(0, '#687a70'); gradient.addColorStop(.45, '#8b9884'); gradient.addColorStop(1, '#526b63');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 64);
  ctx.strokeStyle = 'rgba(215,220,190,.34)'; ctx.lineWidth = 1.2;
  for (let row = 0; row < 8; row += 1) {
    ctx.beginPath();
    for (let x = -4; x <= 132; x += 8) {
      const y = row * 9 + Math.sin(x * .12 + row) * 2.2;
      if (x < 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 1);
  return texture;
}

function addBattlefieldScatter() {
  const rocks = [
    [-5.75, -5.4, .16], [-5.25, 4.95, .11], [5.7, -5.4, .19], [5.85, 5.25, .13],
    [-5.7, .88, .12], [5.72, -.72, .14], [-3.9, -6.15, .1], [3.8, 6.1, .12],
  ];
  for (const [x, z, size] of rocks) addLooseRock(x, z, size);
  const tufts = [
    [-5.9, -4.45, .9], [-5.65, 3.5, -.65], [5.65, 4.35, .78], [5.85, -3.75, -.8],
    [-4.9, 1.4, .45], [4.95, -1.2, -.55], [-2.8, -5.9, .6], [2.75, 5.75, -.45],
  ];
  for (const [x, z, direction] of tufts) addGrassTuft(x, z, direction);
}

function addLooseRock(x, z, size) {
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), new THREE.MeshStandardMaterial({ color: 0x554b3e, roughness: .98, metalness: .02 }));
  rock.position.set(x, .05 + size * .45, z);
  rock.scale.set(1.25, .62, .88);
  rock.rotation.set((x + z) * .06, (x - z) * .34, (x * .2) % .25);
  rock.castShadow = !isTouchDevice;
  rock.receiveShadow = true;
  scene.add(rock);
}

function addGrassTuft(x, z, direction = 1) {
  const material = new THREE.MeshStandardMaterial({ color: 0x667052, roughness: .98, metalness: 0 });
  const group = new THREE.Group(); group.position.set(x, -.02, z);
  for (let i = 0; i < 5; i += 1) {
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(.018, .028, .32 + (i % 3) * .1, 5), material);
    blade.position.set((i - 2) * .055, .17 + (i % 2) * .03, Math.sin(i * 1.4) * .04);
    blade.rotation.z = direction * (.2 + (i % 2) * .15);
    group.add(blade);
  }
  scene.add(group);
}

function addAbandonedFire(x, z, scale = 1) {
  const group = new THREE.Group(); group.position.set(x, -.02, z);
  const ash = new THREE.Mesh(new THREE.CylinderGeometry(.33 * scale, .42 * scale, .035, 9), new THREE.MeshStandardMaterial({ color: 0x302822, roughness: 1 }));
  ash.position.y = .02; group.add(ash);
  for (let i = 0; i < 4; i += 1) {
    const coal = new THREE.Mesh(new THREE.DodecahedronGeometry(.065 * scale, 0), new THREE.MeshStandardMaterial({ color: i % 2 ? 0x6c3828 : 0x3b2821, emissive: i % 2 ? 0x241006 : 0x000000, emissiveIntensity: i % 2 ? .38 : 0, roughness: .92 }));
    coal.position.set(Math.cos(i * 1.6) * .19 * scale, .075, Math.sin(i * 1.6) * .19 * scale);
    group.add(coal);
  }
  const ember = new THREE.Mesh(new THREE.ConeGeometry(.09 * scale, .2 * scale, 6), new THREE.MeshBasicMaterial({ color: 0xe47d3d, transparent: true, opacity: .48 }));
  ember.position.y = .2 * scale; group.add(ember);
  scene.add(group);
}

function addFallenBanner(x, z, color, rotation = 0) {
  const group = new THREE.Group(); group.position.set(x, .02, z); group.rotation.y = rotation;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(.022, .03, 1.45, 6), new THREE.MeshStandardMaterial({ color: 0x62452f, roughness: .9 }));
  pole.rotation.z = .95; pole.position.set(.1, .34, 0); group.add(pole);
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(.5, .24), new THREE.MeshStandardMaterial({ color, transparent: true, opacity: .72, side: THREE.DoubleSide, roughness: .92 }));
  cloth.rotation.y = Math.PI * .5; cloth.rotation.z = .34; cloth.position.set(-.33, .62, 0); group.add(cloth);
  scene.add(group);
}

function addCamp(x, z, side, label, facing) {
  const palette = side === 'red' ? { cloth: 0x6d2929, trim: 0xa9503b, wood: 0x4d3027 } : { cloth: 0x35484a, trim: 0x697b72, wood: 0x392d28 };
  const tentPositions = [[0, 0, 1.02], [-1.15, .32, .68], [1.14, -.16, .65]];
  for (const [dx, dz, size] of tentPositions) {
    const tent = new THREE.Mesh(new THREE.ConeGeometry(size, size * 1.42, 6), new THREE.MeshStandardMaterial({ color: palette.cloth, roughness: .9, metalness: .02 }));
    tent.position.set(x + dx, size * .71 - .02, z + dz);
    tent.rotation.y = (dx + dz) * .25;
    tent.castShadow = true;
    scene.add(tent);
    const seam = new THREE.Mesh(new THREE.BoxGeometry(.025, size * 1.15, .018), new THREE.MeshStandardMaterial({ color: palette.trim, roughness: .78 }));
    seam.position.set(x + dx, size * .64, z + dz + size * .56);
    seam.rotation.z = facing * .16;
    scene.add(seam);
  }
  addPalisade(x, z + facing * 1.12, side, facing);
  addPalisade(x - 1.8, z + facing * .25, side, facing);
  addPalisade(x + 1.8, z + facing * .25, side, facing);
  addFlag(x, z + facing * .95, label, side === 'red' ? COLORS.red.edge : COLORS.black.edge);
  addTorch(x - 1.55, z + facing * .75, .68);
  addTorch(x + 1.55, z + facing * .75, .68);
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(.28, .28, .18, 12), new THREE.MeshStandardMaterial({ color: palette.wood, roughness: .82 }));
  drum.position.set(x + facing * .36, .32, z - facing * .64);
  drum.rotation.z = Math.PI / 2;
  scene.add(drum);
}

function addPalisade(x, z, side, facing) {
  const wood = new THREE.MeshStandardMaterial({ color: side === 'red' ? 0x58372b : 0x403732, roughness: .92 });
  for (let i = -2; i <= 2; i += 1) {
    const stake = new THREE.Mesh(new THREE.CylinderGeometry(.07, .105, .92 + (i % 2) * .12, 6), wood);
    stake.position.set(x + i * .58, .42, z + Math.sin(i * 1.7) * .08);
    stake.rotation.z = facing * (.11 + i * .018);
    stake.castShadow = true;
    scene.add(stake);
  }
  const rail = new THREE.Mesh(new THREE.BoxGeometry(2.65, .09, .09), wood);
  rail.position.set(x, .58, z);
  rail.rotation.y = .04;
  scene.add(rail);
}

function addRefuseStakeLine(x, z, direction, color) {
  const wood = new THREE.MeshStandardMaterial({ color: 0x49342b, roughness: .94 });
  for (let i = 0; i < 4; i += 1) {
    const stake = new THREE.Mesh(new THREE.ConeGeometry(.09, .42 + (i % 2) * .12, 5), wood);
    stake.position.set(x + direction * i * .48, .26, z + Math.sin(i * 2.1) * .16);
    stake.rotation.z = direction * (.3 + i * .05);
    scene.add(stake);
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(.018, .018, .46, 5), new THREE.MeshStandardMaterial({ color, roughness: .85 }));
    rope.position.set(x + direction * (i * .48 + .22), .3, z + .08);
    rope.rotation.z = Math.PI / 2;
    scene.add(rope);
  }
}

function addWheelRuts(x, z, direction, curve) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x271f1b, roughness: .99, transparent: true, opacity: .68 });
  for (const offset of [-.18, .18]) {
    const points = [];
    for (let i = 0; i <= 5; i += 1) {
      const t = i / 5;
      points.push(new THREE.Vector3(x + direction * (t * 2.25 - 1.1), .35, z + offset + Math.sin(t * Math.PI) * curve));
    }
    const path = new THREE.CatmullRomCurve3(points);
    const rut = new THREE.Mesh(new THREE.TubeGeometry(path, 12, .032, 5, false), mat);
    rut.castShadow = true;
    boardGroup.add(rut);
  }
}

function addReedCluster(x, z, direction) {
  const reedMat = new THREE.MeshStandardMaterial({ color: 0x69704b, roughness: .95, metalness: 0 });
  for (let i = 0; i < 7; i += 1) {
    const reed = new THREE.Mesh(new THREE.CylinderGeometry(.018, .03, .38 + (i % 3) * .1, 5), reedMat);
    reed.position.set(x + direction * (i - 3) * .09, .52, z + Math.sin(i * 1.6) * .08);
    reed.rotation.z = direction * (.24 + (i % 2) * .12);
    boardGroup.add(reed);
  }
}

function addSmokeColumn(x, z, scale = 1) {
  for (let i = 0; i < 6; i += 1) {
    const material = new THREE.SpriteMaterial({ map: getSmokeTexture(), color: 0x756e65, transparent: true, opacity: .16, depthWrite: false });
    const puff = new THREE.Sprite(material);
    const base = scale * (.42 + (i % 3) * .13);
    puff.position.set(x + Math.sin(i * 1.9) * .13, .72 + i * .34 * scale, z + Math.cos(i * 1.7) * .12);
    puff.scale.setScalar(base);
    scene.add(puff);
    battlefieldSmoke.push({ puff, base, phase: i * .8 + x, origin: puff.position.clone() });
  }
}

function addFlag(x, z, label, color, small = false) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.035, small ? 1.45 : 2.5, 8), new THREE.MeshStandardMaterial({ color: 0xa77b4e, roughness: .65 }));
  pole.position.y = (small ? 1.45 : 2.5) / 2 - .12;
  pole.castShadow = true;
  group.add(pole);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(small ? .46 : .82, small ? .27 : .48), new THREE.MeshStandardMaterial({ map: makeFlagTexture(label, color), transparent: true, side: THREE.DoubleSide, roughness: .8 }));
  flag.position.set(small ? .26 : .42, small ? 1.26 : 2.05, 0);
  flag.rotation.y = Math.PI * .08;
  group.add(flag);
  scene.add(group);
}

function addTorch(x, z, scale = 1) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(.08 * scale, .12 * scale, 1.15 * scale, 7), new THREE.MeshStandardMaterial({ color: 0x503428, roughness: .95 }));
  post.position.y = .55 * scale;
  group.add(post);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(.24 * scale, .16 * scale, .13 * scale, 10), new THREE.MeshStandardMaterial({ color: 0x745338, metalness: .35, roughness: .5 }));
  bowl.position.y = 1.12 * scale;
  group.add(bowl);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(.13 * scale, .34 * scale, 7), new THREE.MeshBasicMaterial({ color: 0xffb34f, transparent: true, opacity: .9 }));
  flame.position.y = 1.3 * scale;
  group.add(flame);
  const light = new THREE.PointLight(0xff9a4c, 1.35 * scale, 5.5, 2);
  light.position.y = 1.35 * scale;
  group.add(light);
  scene.add(group);
  torches.push({ group, flame, light, base: 1.35 * scale, phase: Math.random() * 10 });
}

function setupBoard() {
  // A continuous, broken-edged mud plain replaces the flat elevated island.
  // The shallow sinusoidal valley and twin raised shoulders follow the river
  // while keeping the playable rank positions close to the original height.
  aerialMudTexture = aerialMudTexture || new THREE.TextureLoader().load('./assets/textures/aerial-mud-2k.jpg');
  const terrain = createBattlefieldTerrain();
  terrain.material = new THREE.MeshStandardMaterial({
    map: aerialMudTexture,
    color: 0xb38f6c,
    roughness: .98,
    metalness: 0,
    vertexColors: true,
  });
  terrain.receiveShadow = true;
  terrain.castShadow = false;
  boardGroup.add(terrain);

  // Irregular gravel shelves and wet sand on the inside of the banks.
  const riverPath = [[-6.2, -.58], [-4.8, -.36], [-3.35, -.18], [-1.9, .19], [-.35, .32], [1.2, .07], [2.6, -.31], [4.05, -.18], [5.35, .24], [6.15, .38]];
  const bankMaterial = new THREE.MeshStandardMaterial({ map: makeTerrainTexture('mud'), color: 0x8f7458, roughness: .98, transparent: true, opacity: .62, depthWrite: false, side: THREE.DoubleSide });
  const northBank = riverPath.map(([x, z], index) => [x, z - .6 - Math.sin(index * 1.2) * .04]);
  const southBank = riverPath.map(([x, z], index) => [x, z + .6 + Math.cos(index * 1.4) * .045]);
  boardGroup.add(makeRibbonMesh(northBank, .62, bankMaterial, .322));
  boardGroup.add(makeRibbonMesh(southBank, .62, bankMaterial.clone(), .322));
  const shallowsMaterial = new THREE.MeshStandardMaterial({ color: 0x776c54, roughness: .76, transparent: true, opacity: .52, depthWrite: false, side: THREE.DoubleSide });
  boardGroup.add(makeRibbonMesh(riverPath.map(([x, z]) => [x, z - .46]), .27, shallowsMaterial, .142));
  boardGroup.add(makeRibbonMesh(riverPath.map(([x, z]) => [x, z + .46]), .27, shallowsMaterial.clone(), .142));
  const waterMaterial = new THREE.MeshStandardMaterial({
    map: makeWaterTexture(), color: 0x9eb8a5, emissive: 0x274a3c, emissiveIntensity: .36,
    roughness: .32, metalness: .08, transparent: true, opacity: .93, depthWrite: false, side: THREE.DoubleSide,
  });
  const river = makeRibbonMesh(riverPath, .94, waterMaterial, .112);
  river.name = 'honggou-river';
  boardGroup.add(river);
  addRiverRipple(riverPath, .12, .126);
  addRiverRipple(riverPath, -.17, .128);
  addBoardReeds(riverPath);

  // Only the ghost of an old marching formation survives: discontinuous,
  // worn scuffs underfoot instead of a clean grid drawn on the landscape.
  const trackMat = new THREE.MeshStandardMaterial({ color: 0x342820, roughness: 1, transparent: true, opacity: .17, depthWrite: false });
  const rowScuffs = [
    [-4.2, -3.15, -2.1], [-1.72, -.7], [.85, 2.35, 3.9],
    [-4.15, -2.8, -1.35], [-.15, 1.2, 2.65, 4.05],
    [-4.1, -2.4, -.8], [.75, 2.0, 3.35, 4.1],
  ];
  for (let row = 0; row < BOARD.height; row += 1) {
    const z = row - 4.5;
    const pieces = rowScuffs[row % rowScuffs.length];
    for (let i = 0; i < pieces.length; i += 1) {
      const start = pieces[i];
      const end = Math.min(4.18, start + (i % 2 ? 1.15 : .82));
      const wobble = Math.sin(row * .91 + i) * .06;
      addBattlefieldLine([
        new THREE.Vector3(start, .377, z + wobble),
        new THREE.Vector3((start + end) / 2, .377, z - wobble * .4),
        new THREE.Vector3(end, .377, z + wobble * .72),
      ], trackMat, .008);
    }
  }
  const verticalScuffs = [[-4.05, -2.8], [-2.4, -.95], [.95, 2.55], [2.9, 4.18]];
  for (let col = 0; col < BOARD.width; col += 1) {
    const x = col - 4;
    for (let half = 0; half < 2; half += 1) {
      const [start, end] = verticalScuffs[(col + half * 2) % verticalScuffs.length];
      const sign = half === 0 ? -1 : 1;
      addBattlefieldLine([
        new THREE.Vector3(x + Math.sin(col) * .025, .378, sign * start),
        new THREE.Vector3(x - Math.cos(col * .8) * .04, .378, sign * ((start + end) / 2)),
        new THREE.Vector3(x + Math.sin(col * 1.4) * .02, .378, sign * end),
      ], trackMat, .007);
    }
  }

  boardGroup.add(makeBoardText('楚河', -2.1, -.1, .92));
  boardGroup.add(makeBoardText('汉界', 2.16, .1, .92));
  addPalaceDiagonals(trackMat, -1);
  addPalaceDiagonals(trackMat, 1);
  for (const [x, z, s] of [[-3, -2.5, .1], [3, -2.5, .13], [-3, 2.5, .1], [3, 2.5, .12], [-4.45, -4.2, .16], [4.45, -4.12, .12], [-4.35, 4.1, .14], [4.2, 4.3, .17], [-1.5, -5.05, .11], [1.7, 5.12, .12]]) addFieldStone(x, z, s);
}

function riverCenter(x) {
  return .22 * Math.sin(x * .79) + .12 * Math.sin(x * 1.67 + .6);
}

function terrainHeight(x, z) {
  const offset = z - riverCenter(x);
  const distance = Math.abs(offset);
  const bankLift = .17 * Math.exp(-((distance - .79) ** 2) / .16);
  const channelCut = .235 * Math.exp(-(offset * offset) / .22);
  const broadRelief = .035 * Math.sin(x * .77 + z * .4) + .026 * Math.cos(z * .83 - x * .31);
  return .315 + bankLift - channelCut + broadRelief;
}

function createBattlefieldTerrain() {
  const columns = 52; const rows = 58;
  const positions = []; const colors = []; const uvs = []; const indices = [];
  for (let row = 0; row <= rows; row += 1) {
    const v = row / rows;
    for (let col = 0; col <= columns; col += 1) {
      const u = col / columns;
      let x = -6.5 + u * 13;
      let z = -7.2 + v * 14.4;
      if (col === 0 || col === columns) x += Math.sin(row * 1.7 + (col ? 1 : 0)) * .24;
      if (row === 0 || row === rows) z += Math.sin(col * 1.37 + (row ? 2 : 0)) * .24;
      const noise = Math.sin(x * 2.5 + z * 1.9) * .014 + Math.cos(x * 4.1 - z * 2.8) * .009;
      const y = terrainHeight(x, z) + noise;
      positions.push(x, y, z);
      uvs.push(u * 1.9, v * 2.1);
      const bank = Math.exp(-((Math.abs(z - riverCenter(x)) - .79) ** 2) / .22);
      const groundTone = .89 + Math.sin(x * .45 + z * .7) * .07 + Math.cos(z * .9 - x * .3) * .05;
      colors.push(groundTone - bank * .13, groundTone - bank * .18, groundTone - bank * .2);
      if (row < rows && col < columns) {
        const a = row * (columns + 1) + col;
        const b = a + columns + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .98, vertexColors: true }));
}

function makeShapeFromXZ(points) {
  const shape = new THREE.Shape();
  if (!points.length) return shape;
  shape.moveTo(points[0][0], -points[0][1]);
  for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], -points[i][1]);
  shape.closePath();
  return shape;
}

function makeRibbonMesh(points, width, material, y) {
  const left = []; const right = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = new THREE.Vector2(points[i][0], points[i][1]);
    const before = new THREE.Vector2(points[Math.max(0, i - 1)][0], points[Math.max(0, i - 1)][1]);
    const after = new THREE.Vector2(points[Math.min(points.length - 1, i + 1)][0], points[Math.min(points.length - 1, i + 1)][1]);
    const tangent = after.sub(before).normalize();
    const normal = new THREE.Vector2(-tangent.y, tangent.x).multiplyScalar(width / 2);
    left.push([current.x + normal.x, current.y + normal.y]);
    right.push([current.x - normal.x, current.y - normal.y]);
  }
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(makeShapeFromXZ(left.concat(right.reverse()))), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

function addBattlefieldLine(points, material, radius) {
  const path = new THREE.CatmullRomCurve3(points);
  const line = new THREE.Mesh(new THREE.TubeGeometry(path, 16, radius, 5, false), material);
  line.receiveShadow = true;
  boardGroup.add(line);
  return line;
}

function addRiverRipple(points, offset, y) {
  const ripple = points.map((point, index) => new THREE.Vector3(point[0], y, point[1] + offset + Math.sin(index * 1.9) * .045));
  const geometry = new THREE.BufferGeometry().setFromPoints(ripple);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xd2d7bd, transparent: true, opacity: .52 }));
  boardGroup.add(line);
}

function addBoardReeds(points) {
  const reedMat = new THREE.MeshStandardMaterial({ color: 0x696847, roughness: .96, metalness: 0 });
  for (const [index, [x, z]] of [points[1], points[3], points[5], points[7]].entries()) {
    for (const side of [-1, 1]) {
      for (let i = -1; i <= 1; i += 1) {
        const reed = new THREE.Mesh(new THREE.CylinderGeometry(.014, .025, .24 + (i + 1) * .07, 5), reedMat);
        reed.position.set(x + i * .065, .27 + (index % 2) * .02, z + side * (.53 + i * .035));
        reed.rotation.z = side * (.22 + (i + 1) * .04);
        reed.rotation.x = (index % 2 ? -.08 : .06);
        boardGroup.add(reed);
      }
    }
  }
}

function addFieldStone(x, z, size) {
  const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), new THREE.MeshStandardMaterial({ color: 0x5e5141, roughness: .98, metalness: .02 }));
  stone.position.set(x, .39 + size * .25, z);
  stone.scale.set(1.2, .65, .9);
  stone.rotation.y = (x - z) * .4;
  stone.castShadow = true;
  boardGroup.add(stone);
}

function addPalaceDiagonals(material, sign) {
  const z1 = sign < 0 ? -4.5 : 4.5;
  const z2 = sign < 0 ? -2.5 : 2.5;
  const y = .382;
  const lines = [
    [[-2.0, z1], [2.0, z2]],
    [[2.0, z1], [-2.0, z2]],
  ];
  for (const [a, b] of lines) {
    const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], y, a[1]), new THREE.Vector3(b[0], y, b[1])]);
    boardGroup.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: material.color, transparent: true, opacity: .18 })));
  }
}

function makeBoardText(text, x, z, width) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 100;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = 'bold 58px "STKaiti", "KaiTi", serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(231, 208, 164, .38)';
  ctx.fillText(text, c.width / 2, c.height / 2 + 3);
  const texture = new THREE.CanvasTexture(c);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, .48), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, .395, z);
  return mesh;
}

function setupInteractionTargets() {
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  for (let y = 0; y < BOARD.height; y += 1) {
    for (let x = 0; x < BOARD.width; x += 1) {
      const target = new THREE.Mesh(new THREE.PlaneGeometry(.92, .92), mat);
      target.rotation.x = -Math.PI / 2;
      const worldX = x - 4;
      const worldZ = y - 4.5;
      target.position.set(worldX, terrainHeight(worldX, worldZ) + .16, worldZ);
      target.userData.square = { x, y };
      targetLayer.add(target);
    }
  }
}

function setupUI() {
  canvas.addEventListener('pointerdown', (event) => {
    audio.unlock();
    pointerDown = { x: event.clientX, y: event.clientY, id: event.pointerId, time: performance.now() };
  }, { passive: true });
  canvas.addEventListener('pointerup', (event) => {
    if (!pointerDown || pointerDown.id !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
    const elapsed = performance.now() - pointerDown.time;
    pointerDown = null;
    if (distance < (isTouchDevice ? 15 : 8) && elapsed < 800) handleBoardTap(event);
  }, { passive: true });
  canvas.addEventListener('pointercancel', () => { pointerDown = null; }, { passive: true });

  ui.sound.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    audio.enabled = soundEnabled;
    ui.sound.classList.toggle('is-muted', !soundEnabled);
    ui.sound.setAttribute('aria-label', soundEnabled ? '关闭声音' : '开启声音');
    ui.sound.innerHTML = `<span class="icon icon-sound" aria-hidden="true">${soundEnabled ? '◖)))' : '◖·'}</span>`;
    if (soundEnabled) { audio.unlock(); audio.play('move'); }
  });
  document.querySelector('#reset-button').addEventListener('click', resetGame);
  document.querySelector('#reset-top').addEventListener('click', resetGame);
  document.querySelector('#camera-button').addEventListener('click', () => {
    controls.reset();
    showToast('视角已回到指挥台');
  });
  ui.undo.addEventListener('click', undoMove);
  document.querySelector('#mode-button').addEventListener('click', () => {
    mode = mode === 'ai' ? 'local' : 'ai';
    ui.modeLabel.textContent = mode === 'ai' ? '人机' : '双人';
    showToast(mode === 'ai' ? '已切换为人机对战' : '已切换为双人同屏');
    updateHud();
  });
  document.querySelector('#hint-button').addEventListener('click', showHint);
}

function handleBoardTap(event) {
  if (animating || game.gameOver) return;
  if (mode === 'ai' && game.turn === 'black') {
    showToast('楚军正在行军，请稍候');
    return;
  }
  const square = pickSquare(event);
  if (!square) return;
  const code = game.pieceAt(square.x, square.y);
  if (selected) {
    const candidate = selectedMoves.find((move) => move.to.x === square.x && move.to.y === square.y);
    if (candidate) {
      playMove(candidate, 'human');
      return;
    }
    if (code && sideOf(code) === game.turn) {
      selectSquare(square.x, square.y);
      return;
    }
    clearSelection();
    return;
  }
  if (code && sideOf(code) === game.turn) selectSquare(square.x, square.y);
}

function pickSquare(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster = raycaster || new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);

  // Once a unit is selected, resolve the tap against the regular 9x10 grid
  // itself. This keeps a tall figure, relief edge, or transparent marker from
  // stealing the destination hit on touch screens.
  if (selected) {
    const boardPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.38);
    const boardPoint = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(boardPlane, boardPoint)) {
      const x = Math.round(boardPoint.x + 4);
      const y = Math.round(boardPoint.z + 4.5);
      if (x >= 0 && x < BOARD.width && y >= 0 && y < BOARD.height
        && Math.abs(boardPoint.x - (x - 4)) <= .58
        && Math.abs(boardPoint.z - (y - 4.5)) <= .58) {
        return { x, y };
      }
    }
  }

  const squareFromHits = (hits) => {
    for (const hit of hits) {
      let current = hit.object;
      while (current) {
        if (current.userData?.square) return current.userData.square;
        current = current.parent;
      }
    }
    return null;
  };

  if (selected) {
    const markerSquare = squareFromHits(raycaster.intersectObjects(markerLayer.children, true));
    if (markerSquare) return markerSquare;
    const targetSquare = squareFromHits(raycaster.intersectObjects(targetLayer.children, true));
    if (targetSquare) return targetSquare;
  }
  return squareFromHits(raycaster.intersectObjects(pieceLayer.children, true));
}

function selectSquare(x, y) {
  const code = game.pieceAt(x, y);
  if (!code) return;
  clearSelection(false);
  selected = { x, y, code };
  selectedMoves = game.legalMovesFrom(x, y);
  const group = piecesOnBoard.get(squareKey(x, y));
  if (group) {
    group.userData.selected = true;
    const frame = group.getObjectByName('selection-frame');
    if (frame) frame.visible = true;
  }
  for (const move of selectedMoves) addMoveMarker(move.to.x, move.to.y, Boolean(move.captured));
  const meta = PIECES[code];
  ui.hint.textContent = `${meta.label} · ${meta.unit === 'commander' ? '统帅' : meta.unit === 'cavalry' ? '骑兵' : meta.unit === 'artillery' ? '火炮' : meta.unit === 'chariot' ? '战车' : meta.unit === 'guard' ? '护卫' : meta.unit === 'elephant' ? '战象' : '先锋'} · 可行军 ${selectedMoves.length} 处`;
  ui.hint.classList.remove('hidden');
  ui.status.textContent = `${meta.label} 已出列 · 选择琥珀色落点`;
}

function clearSelection(resetStatus = true) {
  if (selected) {
    const group = piecesOnBoard.get(squareKey(selected.x, selected.y));
    if (group) {
      group.userData.selected = false;
      const frame = group.getObjectByName('selection-frame');
      if (frame) frame.visible = false;
    }
  }
  selected = null;
  selectedMoves = [];
  for (const marker of markersOnBoard.values()) markerLayer.remove(marker);
  markersOnBoard.clear();
  if (resetStatus) updateHud();
}

function addMoveMarker(x, y, capture) {
  const key = squareKey(x, y);
  const ring = new THREE.Mesh(
    capture ? new THREE.TorusGeometry(.22, .045, 6, 20) : new THREE.CylinderGeometry(.12, .12, .025, 16),
    new THREE.MeshBasicMaterial({ color: capture ? 0xe0785b : 0xf4c762, transparent: true, opacity: .9, depthWrite: false }),
  );
  ring.name = 'move-marker';
  ring.rotation.x = capture ? -Math.PI / 2 : 0;
  const worldX = x - 4;
  const worldZ = y - 4.5;
  ring.position.set(worldX, terrainHeight(worldX, worldZ) + .19, worldZ);
  ring.userData.square = { x, y };
  markerLayer.add(ring);
  markersOnBoard.set(key, ring);
}

function renderBoard() {
  const wanted = new Set();
  for (let y = 0; y < BOARD.height; y += 1) {
    for (let x = 0; x < BOARD.width; x += 1) {
      const code = game.pieceAt(x, y);
      if (!code) continue;
      const key = squareKey(x, y);
      wanted.add(key);
      const existing = piecesOnBoard.get(key);
      if (existing && existing.userData.code === code) {
        existing.userData.square = { x, y };
        existing.position.set(x - 4, terrainHeight(x - 4, y - 4.5), y - 4.5);
        continue;
      }
      if (existing) pieceLayer.remove(existing);
      const piece = createPiece(code);
      piece.position.set(x - 4, terrainHeight(x - 4, y - 4.5), y - 4.5);
      piece.userData.square = { x, y };
      pieceLayer.add(piece);
      piecesOnBoard.set(key, piece);
    }
  }
  for (const [key, group] of piecesOnBoard) {
    if (!wanted.has(key)) {
      pieceLayer.remove(group);
      piecesOnBoard.delete(key);
    }
  }
}

function createPiece(code) {
  const meta = PIECES[code];
  const side = meta.side;
  const palette = COLORS[side];
  const group = new THREE.Group();
  group.userData.code = code;
  group.userData.side = side;
  group.userData.type = meta.type;
  group.name = `piece-${code}`;
  const body = new THREE.MeshStandardMaterial({ color: palette.body, roughness: .78, metalness: .08 });
  const edge = new THREE.MeshStandardMaterial({ color: palette.edge, roughness: .58, metalness: .22 });
  const metal = new THREE.MeshStandardMaterial({ color: palette.metal, roughness: .45, metalness: .5 });
  // The unit stands directly on the battlefield. There is deliberately no
  // round chess token or pedestal under the feet.
  const type = meta.type;
  if (type === 'king') buildKing(group, body, edge, metal, side);
  else if (type === 'advisor') buildAdvisor(group, body, edge, metal, side);
  else if (type === 'elephant') buildElephant(group, body, edge, metal, side);
  else if (type === 'horse') buildHorse(group, body, edge, metal, side);
  else if (type === 'chariot') buildChariot(group, body, edge, metal, side);
  else if (type === 'cannon') buildCannon(group, body, edge, metal, side);
  else buildSoldier(group, body, edge, metal, side);
  // Keep the units adult-sized relative to a one-square battlefield grid.
  // Vehicles stay compact so their operators and weapons remain readable.
  const silhouetteScale = {
    king: 1.22,
    advisor: 1.22,
    elephant: 1.2,
    horse: 1.18,
    chariot: 1.06,
    cannon: 1.06,
    soldier: 1.28,
  }[type] || 1.2;
  group.scale.setScalar(silhouetteScale);
  group.rotation.y = side === 'red' ? Math.PI : 0;
  const frame = makeSelectionFrame();
  group.add(frame);
  group.traverse((object) => { if (object.isMesh) { object.castShadow = !isTouchDevice; object.receiveShadow = true; } });
  return group;
}

function addMesh(parent, geometry, material, x, y, z, rotation = null) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (rotation) mesh.rotation.set(rotation.x || 0, rotation.y || 0, rotation.z || 0);
  parent.add(mesh);
  return mesh;
}

let lamellarTexture;

function getLamellarTexture() {
  if (lamellarTexture) return lamellarTexture;
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 256, 256);
  gradient.addColorStop(0, '#e9c46a');
  gradient.addColorStop(.48, '#9b6b2d');
  gradient.addColorStop(1, '#5d3d1e');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256);
  // Overlapping fish-scale rows: one textured plane reads as many hand-made
  // brass lamellae without creating dozens of meshes per soldier.
  for (let row = -1; row < 10; row += 1) {
    const y = row * 29;
    for (let col = -1; col < 10; col += 1) {
      const x = col * 29 + (row % 2 ? 14 : 0);
      ctx.beginPath();
      ctx.moveTo(x, y + 4); ctx.quadraticCurveTo(x + 14, y - 5, x + 28, y + 4);
      ctx.lineTo(x + 24, y + 25); ctx.quadraticCurveTo(x + 14, y + 31, x + 4, y + 25);
      ctx.closePath();
      ctx.fillStyle = row % 3 === 0 ? '#f1d17a' : '#c19343'; ctx.fill();
      ctx.strokeStyle = '#5d3d1e'; ctx.lineWidth = 2; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,241,172,.38)'; ctx.lineWidth = 1; ctx.stroke();
    }
  }
  lamellarTexture = new THREE.CanvasTexture(canvas);
  lamellarTexture.colorSpace = THREE.SRGBColorSpace;
  lamellarTexture.wrapS = THREE.RepeatWrapping; lamellarTexture.wrapT = THREE.RepeatWrapping;
  return lamellarTexture;
}

function addHumanoid(group, body, edge, metal, options = {}) {
  const scale = options.scale || 1;
  const skin = new THREE.MeshStandardMaterial({ color: options.skin || 0xa56f58, roughness: .72, metalness: .03 });
  const cloth = new THREE.MeshStandardMaterial({ color: options.clothColor || body.color, roughness: .86, metalness: .03 });
  const dark = new THREE.MeshStandardMaterial({ color: options.darkColor || 0x25262a, roughness: .76, metalness: .1 });
  const armor = new THREE.MeshStandardMaterial({ color: options.armorColor || edge.color, roughness: .5, metalness: .32 });
  const goldArmor = new THREE.MeshStandardMaterial({ map: getLamellarTexture(), color: 0xffffff, roughness: .42, metalness: .4 });
  const parts = {};

  // Long adult silhouette with soft cloth boots and articulated lamellar
  // armour. Feet begin at y=0: there is intentionally no chess-piece base.
  for (const x of [-.11, .11]) {
    addMesh(group, new THREE.BoxGeometry(.17 * scale, .1 * scale, .31 * scale), dark, x * scale, .055 * scale, .08 * scale);
    addMesh(group, new THREE.CylinderGeometry(.065 * scale, .082 * scale, .38 * scale, 8), armor, x * scale, .29 * scale, 0);
    addMesh(group, new THREE.BoxGeometry(.13 * scale, .2 * scale, .04 * scale), goldArmor, x * scale, .31 * scale, .115 * scale);
    addMesh(group, new THREE.BoxGeometry(.14 * scale, .06 * scale, .06 * scale), armor, x * scale, .5 * scale, .07 * scale);
  }

  parts.torso = addMesh(group, new THREE.CylinderGeometry(.18 * scale, .235 * scale, .46 * scale, 8), cloth, 0, .72 * scale, 0);
  // A single textured cuirass conveys hundreds of gold scales at mobile cost.
  addMesh(group, new THREE.BoxGeometry(.34 * scale, .38 * scale, .055 * scale), goldArmor, 0, .77 * scale, .16 * scale);
  addMesh(group, new THREE.BoxGeometry(.38 * scale, .055 * scale, .08 * scale), dark, 0, .98 * scale, .06 * scale);
  for (const x of [-.2, .2]) {
    const shoulder = addMesh(group, new THREE.CylinderGeometry(.1 * scale, .13 * scale, .22 * scale, 8), armor, x * scale, .96 * scale, .015 * scale, { z: x > 0 ? -.24 : .24 });
    shoulder.scale.z = .72;
    // Low-poly beast-head silhouette on each shoulder: brow, snout and jaw.
    addMesh(group, new THREE.SphereGeometry(.085 * scale, 8, 6), metal, x * scale, 1.02 * scale, .12 * scale);
    addMesh(group, new THREE.ConeGeometry(.045 * scale, .12 * scale, 6), metal, x * scale, .99 * scale, .19 * scale, { x: Math.PI / 2 });
  }

  parts.leftArm = addMesh(group, new THREE.CylinderGeometry(.055 * scale, .075 * scale, .32 * scale, 8), cloth, -.22 * scale, .84 * scale, 0, { z: -.42 });
  parts.rightArm = addMesh(group, new THREE.CylinderGeometry(.055 * scale, .075 * scale, .32 * scale, 8), cloth, .22 * scale, .84 * scale, 0, { z: .42 });
  addMesh(group, new THREE.CylinderGeometry(.052 * scale, .07 * scale, .25 * scale, 8), armor, -.29 * scale, .66 * scale, .08 * scale, { z: .25 });
  addMesh(group, new THREE.CylinderGeometry(.052 * scale, .07 * scale, .25 * scale, 8), armor, .29 * scale, .66 * scale, .08 * scale, { z: -.25 });
  addMesh(group, new THREE.SphereGeometry(.064 * scale, 8, 6), skin, -.32 * scale, .54 * scale, .12 * scale);
  addMesh(group, new THREE.SphereGeometry(.064 * scale, 8, 6), skin, .32 * scale, .54 * scale, .12 * scale);

  addMesh(group, new THREE.CylinderGeometry(.055 * scale, .055 * scale, .11 * scale, 8), skin, 0, 1.0 * scale, 0);
  parts.head = addMesh(group, new THREE.SphereGeometry(.14 * scale, 12, 9), skin, 0, 1.13 * scale, .025 * scale);
  parts.head.scale.set(1, 1.08, .91);
  // Ears, nose, brows and a small moustache keep the adult face readable.
  for (const x of [-.135, .135]) addMesh(group, new THREE.SphereGeometry(.036 * scale, 7, 5), skin, x * scale, 1.13 * scale, .02 * scale);
  addMesh(group, new THREE.ConeGeometry(.025 * scale, .07 * scale, 5), skin, 0, 1.11 * scale, .145 * scale, { x: Math.PI / 2 });
  for (const x of [-.055, .055]) {
    addMesh(group, new THREE.BoxGeometry(.06 * scale, .014 * scale, .014 * scale), dark, x * scale, 1.165 * scale, .13 * scale, { z: x > 0 ? -.08 : .08 });
    addMesh(group, new THREE.SphereGeometry(.012 * scale, 5, 4), dark, x * scale, 1.145 * scale, .142 * scale);
  }
  addMesh(group, new THREE.BoxGeometry(.08 * scale, .018 * scale, .018 * scale), dark, -.042 * scale, 1.075 * scale, .135 * scale, { z: -.12 });
  addMesh(group, new THREE.BoxGeometry(.08 * scale, .018 * scale, .018 * scale), dark, .042 * scale, 1.075 * scale, .135 * scale, { z: .12 });
  if (options.beard) addMesh(group, new THREE.ConeGeometry(.08 * scale, .16 * scale, 7), dark, 0, 1.03 * scale, .12 * scale);

  // Folded black soft cap and long rear ties, matching the reference figures.
  addMesh(group, new THREE.CylinderGeometry(.15 * scale, .17 * scale, .08 * scale, 8), dark, 0, 1.245 * scale, .005 * scale);
  addMesh(group, new THREE.ConeGeometry(.14 * scale, .19 * scale, 8), dark, 0, 1.36 * scale, -.01 * scale);
  addMesh(group, new THREE.BoxGeometry(.035 * scale, .3 * scale, .02 * scale), dark, -.075 * scale, 1.29 * scale, -.12 * scale, { z: -.08 });
  addMesh(group, new THREE.BoxGeometry(.035 * scale, .3 * scale, .02 * scale), dark, .075 * scale, 1.29 * scale, -.12 * scale, { z: .08 });
  addQinArmorDetails(group, edge, metal, scale);
  parts.weaponHand = parts.rightArm;
  group.userData.animationParts = parts;
  return parts;
}

function addQinArmorDetails(group, edge, metal, scale = 1) {
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2524, roughness: .78, metalness: .06 });
  const cord = new THREE.MeshStandardMaterial({ color: edge.color, roughness: .62, metalness: .15 });
  // Leather cross straps and bright red binding make the silhouette read as
  // hand-laced armour rather than a smooth sci-fi breastplate.
  addMesh(group, new THREE.BoxGeometry(.035 * scale, .36 * scale, .026 * scale), dark, 0, .77 * scale, .205 * scale, { z: .34 });
  addMesh(group, new THREE.BoxGeometry(.035 * scale, .36 * scale, .026 * scale), dark, 0, .77 * scale, .208 * scale, { z: -.34 });
  addMesh(group, new THREE.BoxGeometry(.34 * scale, .028 * scale, .035 * scale), cord, 0, .59 * scale, .205 * scale);
  addMesh(group, new THREE.BoxGeometry(.34 * scale, .026 * scale, .035 * scale), cord, 0, .96 * scale, .2 * scale);
  addMesh(group, new THREE.BoxGeometry(.32 * scale, .045 * scale, .055 * scale), dark, 0, .53 * scale, .08 * scale);
  // Side lamellae and skirt flaps suggest movement when the unit advances.
  for (const x of [-.2, .2]) {
    addMesh(group, new THREE.BoxGeometry(.07 * scale, .23 * scale, .045 * scale), metal, x * scale, .67 * scale, -.12 * scale, { z: x > 0 ? -.12 : .12 });
    addMesh(group, new THREE.BoxGeometry(.075 * scale, .18 * scale, .03 * scale), dark, x * scale, .51 * scale, .06 * scale, { z: x > 0 ? -.1 : .1 });
  }
  for (const x of [-.13, .13]) addMesh(group, new THREE.SphereGeometry(.022 * scale, 6, 4), metal, x * scale, .955 * scale, .225 * scale);
}

function addCloak(group, material, scale = 1, z = -.11) {
  const cloak = new THREE.Mesh(new THREE.ConeGeometry(.34 * scale, 1.05 * scale, 6, 1, true), material);
  cloak.position.set(0, .64 * scale, z);
  cloak.rotation.x = Math.PI;
  group.add(cloak);
  return cloak;
}

function addSword(group, material, metal, scale = 1, side = 1) {
  const hilt = addMesh(group, new THREE.CylinderGeometry(.035 * scale, .035 * scale, .2 * scale, 6), metal, .31 * scale * side, .56 * scale, .13 * scale, { z: side * .2 });
  const blade = addMesh(group, new THREE.BoxGeometry(.045 * scale, .46 * scale, .025 * scale), material, .34 * scale * side, .29 * scale, .15 * scale, { z: side * .2 });
  hilt.userData.weapon = true;
  blade.userData.weapon = true;
  return { hilt, blade };
}

function addSpear(group, metal, accent, scale = 1, x = .23) {
  const shaft = addMesh(group, new THREE.CylinderGeometry(.018 * scale, .018 * scale, 1.26 * scale, 6), metal, x * scale, .78 * scale, .13 * scale);
  const tip = addMesh(group, new THREE.ConeGeometry(.075 * scale, .2 * scale, 6), accent, x * scale, 1.5 * scale, .13 * scale);
  shaft.userData.weapon = true; tip.userData.weapon = true;
  return { shaft, tip };
}

function addGe(group, metal, accent, scale = 1, x = .25) {
  const shaft = addMesh(group, new THREE.CylinderGeometry(.018 * scale, .018 * scale, 1.3 * scale, 6), metal, x * scale, .8 * scale, .13 * scale);
  const blade = addMesh(group, new THREE.BoxGeometry(.28 * scale, .065 * scale, .035 * scale), accent, x * scale, 1.36 * scale, .13 * scale, { z: -.12 });
  const hook = addMesh(group, new THREE.BoxGeometry(.1 * scale, .045 * scale, .035 * scale), accent, (x + .1) * scale, 1.31 * scale, .13 * scale, { z: .36 });
  shaft.userData.weapon = true; blade.userData.weapon = true; hook.userData.weapon = true;
  return { shaft, blade, hook };
}

function buildKing(group, body, edge, metal, side) {
  addCloak(group, new THREE.MeshStandardMaterial({ color: side === 'red' ? 0x6b2825 : 0x334447, roughness: .82, metalness: .08 }), 1.16, -.16);
  addHumanoid(group, body, edge, metal, { scale: 1.16, skin: side === 'red' ? 0xa96e57 : 0x976e5d, beard: true });
  addMesh(group, new THREE.BoxGeometry(.08, .42, .06), metal, 0, 1.68, -.02);
  addMesh(group, new THREE.SphereGeometry(.065, 7, 5), edge, 0, 1.91, -.02);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(.38, .25), new THREE.MeshStandardMaterial({ color: edge.color, side: THREE.DoubleSide, roughness: .8 }));
  banner.position.set(-.21, 1.68, -.04); group.add(banner);
  addSword(group, edge, metal, 1.15, 1);
  group.userData.weaponType = 'sword';
}

function buildAdvisor(group, body, edge, metal, side) {
  addHumanoid(group, body, edge, metal, { scale: 1.02, skin: side === 'red' ? 0xa16b55 : 0x906a5b });
  const shield = addMesh(group, new THREE.BoxGeometry(.28, .38, .055), edge, -.25, .68, .2, { z: -.08 });
  shield.userData.shield = true;
  addMesh(group, new THREE.BoxGeometry(.035, .26, .045), metal, -.25, .68, .24);
  addSword(group, metal, edge, .98, 1);
  group.userData.weaponType = 'sword';
}

function buildElephant(group, body, edge, metal, side) {
  addCloak(group, new THREE.MeshStandardMaterial({ color: body.color, roughness: .78, metalness: .08 }), 1.04, -.13);
  addHumanoid(group, body, edge, metal, { scale: 1.04, skin: side === 'red' ? 0xa16f58 : 0x946b5a });
  for (const x of [-.18, .18]) {
    addMesh(group, new THREE.CylinderGeometry(.018, .022, 1.15, 6), metal, x, 1.0, -.03);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(.24, .18), new THREE.MeshStandardMaterial({ color: edge.color, side: THREE.DoubleSide, roughness: .8 }));
    flag.position.set(x, 1.53, -.03); group.add(flag);
  }
  addSpear(group, metal, edge, 1.02, .28);
  group.userData.weaponType = 'banner';
}

function buildHorse(group, body, edge, metal, side) {
  const horseBody = new THREE.MeshStandardMaterial({ color: body.color, roughness: .56, metalness: .18 });
  addMesh(group, new THREE.BoxGeometry(.5, .38, .72), horseBody, 0, .43, -.02);
  // The horse faces the same +Z front as its rider; the root is rotated for
  // the opposing army in createPiece().
  addMesh(group, new THREE.CylinderGeometry(.14, .18, .58, 8), horseBody, 0, .78, .32, { x: .26 });
  addMesh(group, new THREE.SphereGeometry(.17, 10, 7), horseBody, 0, 1.04, .49);
  addMesh(group, new THREE.BoxGeometry(.16, .1, .22), edge, 0, .99, .61, { x: .08 });
  addMesh(group, new THREE.BoxGeometry(.18, .035, .27), metal, 0, .94, .66, { x: .08 });
  for (const x of [-.18, .18]) for (const z of [-.24, .22]) addMesh(group, new THREE.CylinderGeometry(.05, .07, .42, 7), horseBody, x, .2, z, { z: x > 0 ? .12 : -.12 });
  const rider = new THREE.Group(); rider.position.set(0, .48, .02); group.add(rider);
  addHumanoid(rider, body, edge, metal, { scale: 1.04, skin: side === 'red' ? 0xa16d55 : 0x946b5a });
  addMesh(rider, new THREE.BoxGeometry(.26, .08, .08), metal, 0, .55, -.22);
  addSpear(rider, metal, edge, .94, .24);
  group.userData.weaponType = 'spear';
}

function buildChariot(group, body, edge, metal, side) {
  const cart = new THREE.MeshStandardMaterial({ color: body.color, roughness: .57, metalness: .3 });
  // Lower the carriage so the wheels touch the board instead of floating.
  addMesh(group, new THREE.BoxGeometry(.7, .34, .56), cart, 0, .17, 0);
  addMesh(group, new THREE.BoxGeometry(.6, .1, .48), edge, 0, .39, 0);
  for (const x of [-.36, .36]) {
    addMesh(group, new THREE.CylinderGeometry(.18, .18, .09, 14), metal, x, .18, .06, { z: Math.PI / 2 });
    addMesh(group, new THREE.CylinderGeometry(.045, .045, .105, 10), edge, x, .18, .06, { z: Math.PI / 2 });
  }
  // Qin-style drawbar and yoke give the chariot a clear vehicle silhouette.
  addMesh(group, new THREE.CylinderGeometry(.035, .045, .82, 8), cart, 0, .23, .43, { x: Math.PI / 2 });
  addMesh(group, new THREE.BoxGeometry(.58, .07, .07), edge, 0, .65, .28);
  const driver = new THREE.Group(); driver.position.set(0, .42, .02); group.add(driver);
  addHumanoid(driver, body, edge, metal, { scale: 1.04, skin: side === 'red' ? 0xa06c55 : 0x916a5a });
  addMesh(driver, new THREE.BoxGeometry(.34, .08, .07), edge, 0, .62, -.25);
  addSword(driver, edge, metal, .88, 1);
  group.userData.weaponType = 'sword';
}

function buildCannon(group, body, edge, metal, side) {
  const wood = new THREE.MeshStandardMaterial({ color: body.color, roughness: .55, metalness: .28 });
  addMesh(group, new THREE.BoxGeometry(.58, .17, .48), wood, 0, .085, 0);
  for (const x of [-.3, .3]) addMesh(group, new THREE.CylinderGeometry(.13, .13, .09, 12), metal, x, .13, 0, { z: Math.PI / 2 });
  addMesh(group, new THREE.BoxGeometry(.12, .12, .78), wood, 0, .42, .02);
  const barrel = addMesh(group, new THREE.BoxGeometry(.72, .055, .055), metal, 0, .59, .02);
  barrel.userData.weapon = true;
  const string = addMesh(group, new THREE.CylinderGeometry(.022, .022, .55, 6), metal, 0, .57, .02, { z: Math.PI / 2 });
  string.userData.weapon = true;
  addMesh(group, new THREE.ConeGeometry(.07, .14, 6), metal, -.39, .59, .02, { z: -Math.PI / 2 });
  addMesh(group, new THREE.ConeGeometry(.07, .14, 6), metal, .39, .59, .02, { z: Math.PI / 2 });
  const operator = new THREE.Group(); operator.position.set(0, .34, .08); group.add(operator);
  addHumanoid(operator, body, edge, metal, { scale: .98, skin: side === 'red' ? 0xa06c55 : 0x916a5a });
  addMesh(operator, new THREE.BoxGeometry(.26, .08, .09), edge, 0, .62, -.12);
  group.userData.weaponType = 'cannon';
}

function buildSoldier(group, body, edge, metal, side) {
  addHumanoid(group, body, edge, metal, { scale: 1.0, skin: side === 'red' ? 0xa8735a : 0x916858 });
  addGe(group, metal, edge, 1.0, .25);
  group.userData.weaponType = 'ge';
}

function makeSelectionFrame() {
  const points = [
    new THREE.Vector3(-.38, .018, -.46), new THREE.Vector3(.38, .018, -.46),
    new THREE.Vector3(.46, .018, -.38), new THREE.Vector3(.46, .018, .38),
    new THREE.Vector3(.38, .018, .46), new THREE.Vector3(-.38, .018, .46),
    new THREE.Vector3(-.46, .018, .38), new THREE.Vector3(-.46, .018, -.38),
  ];
  const frame = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x8ed1bf, transparent: true, opacity: .9 }));
  frame.name = 'selection-frame';
  frame.visible = false;
  return frame;
}

function makeFlagTexture(label, color) {
  const c = document.createElement('canvas'); c.width = 160; c.height = 90;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color === COLORS.red.edge ? '#87342d' : '#28363b';
  ctx.fillRect(0, 0, 160, 90);
  ctx.strokeStyle = '#e0ad67'; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 154, 84);
  ctx.fillStyle = '#f1d49b'; ctx.font = 'bold 35px "STKaiti", serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, 80, 46);
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

async function playMove(move, source) {
  if (animating || game.gameOver || !move) return;
  if (source === 'human' && mode === 'ai' && game.turn !== 'red') return;
  const movingCode = game.pieceAt(move.from.x, move.from.y);
  const capturedCode = game.pieceAt(move.to.x, move.to.y);
  const result = game.move(move);
  if (!result.ok) {
    showToast(result.reason === 'illegal-move' ? '此处无法行军' : '军令无效');
    return;
  }
  audio.unlock();
  const movingGroup = piecesOnBoard.get(squareKey(move.from.x, move.from.y));
  const capturedGroup = piecesOnBoard.get(squareKey(move.to.x, move.to.y));
  piecesOnBoard.delete(squareKey(move.from.x, move.from.y));
  piecesOnBoard.delete(squareKey(move.to.x, move.to.y));
  if (movingGroup) {
    movingGroup.userData.square = { ...move.to };
    piecesOnBoard.set(squareKey(move.to.x, move.to.y), movingGroup);
  }
  clearSelection(false);
  animating = true;
  updateHud(result, movingCode, capturedCode);
  const attackType = pieceType(movingCode || 'p');
  if (capturedCode) {
    // Impact audio and particles are fired from the contact frame inside the
    // movement timeline, so the hit reads as a real clash rather than a
    // pre-triggered overlay.
  } else {
    audio.play('move');
    spawnMarchDust(squareWorld(move.from.x, move.from.y));
  }
  await animatePieceMove(movingGroup, capturedGroup, move, Boolean(capturedCode), attackType, () => {
    audio.play(attackType === 'c' ? 'cannon' : 'capture');
    if (attackType !== 'c') audio.play('warcry');
    spawnCombatEffects(attackType, squareWorld(move.to.x, move.to.y));
  });
  if (capturedGroup) pieceLayer.remove(capturedGroup);
  renderBoard();
  animating = false;
  updateHud();
  if (game.gameOver) {
    audio.play('capture');
    showToast(game.status.includes('red') ? '汉军夺下中军！' : game.status.includes('black') ? '楚军攻破帅府！' : '战局暂止');
  } else if (mode === 'ai' && game.turn === 'black' && source !== 'ai') {
    scheduleAiMove();
  }
}

function animatePieceMove(movingGroup, capturedGroup, move, capture, attackType, onImpact) {
  return new Promise((resolve) => {
    if (!movingGroup) { resolve(); return; }
    const start = squareWorld(move.from.x, move.from.y);
    const end = squareWorld(move.to.x, move.to.y);
    const startTime = performance.now();
    const duration = prefersReducedMotion ? 100 : (capture ? 520 : 330);
    const originalY = .41;
    const startScale = capturedGroup ? capturedGroup.scale.clone() : null;
    const victimStart = capturedGroup ? capturedGroup.position.clone() : null;
    const initialRotation = movingGroup.rotation.clone();
    let impactFired = false;
    const loop = (now) => {
      const raw = Math.min(1, (now - startTime) / duration);
      const t = raw * raw * (3 - 2 * raw);
      movingGroup.position.x = THREE.MathUtils.lerp(start.x, end.x, t);
      movingGroup.position.z = THREE.MathUtils.lerp(start.z, end.z, t);
      movingGroup.position.y = originalY + Math.sin(Math.PI * t) * (capture ? .46 : .32);
      if (capture && capturedGroup) {
        const hitT = THREE.MathUtils.clamp((raw - .3) / .42, 0, 1);
        const hitEase = hitT * hitT;
        capturedGroup.scale.copy(startScale).multiplyScalar(1 - .7 * hitEase);
        const knock = THREE.MathUtils.clamp((raw - .48) / .42, 0, 1);
        capturedGroup.position.copy(victimStart);
        capturedGroup.position.x += (end.x - start.x) * .14 * knock;
        capturedGroup.position.z += (end.z - start.z) * .14 * knock;
        capturedGroup.rotation.x = Math.sin(knock * Math.PI) * .34;
        capturedGroup.rotation.z = Math.cos(knock * Math.PI) * .12;
        setGroupOpacity(capturedGroup, 1 - hitEase);
        movingGroup.rotation.z = initialRotation.z + Math.sin(Math.PI * hitT) * .16;
        movingGroup.rotation.x = initialRotation.x - Math.sin(Math.PI * hitT) * .08;
        const weaponParts = [];
        movingGroup.traverse((object) => { if (object.userData?.weapon) weaponParts.push(object); });
        for (const weapon of weaponParts) weapon.rotation.x = Math.sin(Math.PI * hitT) * .42;
        if (!impactFired && raw >= .48) {
          impactFired = true;
          onImpact?.();
        }
      }
      if (raw < 1) requestAnimationFrame(loop);
      else {
        movingGroup.position.set(end.x, originalY, end.z);
        movingGroup.rotation.copy(initialRotation);
        if (capturedGroup) { capturedGroup.scale.setScalar(.08); setGroupOpacity(capturedGroup, 0); }
        if (capture && !impactFired) { impactFired = true; onImpact?.(); }
        resolve();
      }
    };
    requestAnimationFrame(loop);
  });
}

function setGroupOpacity(group, opacity) {
  group.traverse((object) => {
    if (!object.isMesh && !object.isSprite) return;
    const material = object.material;
    if (!material) return;
    material.transparent = true;
    material.opacity = opacity;
  });
}

function scheduleAiMove() {
  clearTimeout(aiTimer);
  ui.turnSub.textContent = '楚军正在布阵…';
  aiTimer = setTimeout(() => {
    if (game.gameOver || game.turn !== 'black' || mode !== 'ai') return;
    const move = chooseBestMove(game, { side: 'black', depth: isTouchDevice ? 1 : 2 });
    if (move) playMove(move, 'ai');
  }, isTouchDevice ? 520 : 700);
}

function undoMove() {
  if (animating || !game.history.length) return;
  clearTimeout(aiTimer);
  clearSelection();
  const count = mode === 'ai' && game.turn === 'red' && game.history.length > 1 ? 2 : 1;
  for (let i = 0; i < count; i += 1) game.undo();
  clearPieceLayer();
  renderBoard();
  updateHud();
  showToast('战局已回退');
}

function resetGame() {
  clearTimeout(aiTimer);
  clearSelection(false);
  game.reset();
  clearPieceLayer();
  renderBoard();
  eventLines.length = 0;
  updateEventLog('鸿沟两岸，等待军令', true);
  updateHud();
  showToast('阵地重整，汉军先行');
  audio.unlock();
}

function clearPieceLayer() {
  for (const group of piecesOnBoard.values()) pieceLayer.remove(group);
  piecesOnBoard.clear();
}

function showHint() {
  if (animating || game.gameOver) return;
  let move;
  if (mode === 'ai' && game.turn === 'red') move = chooseBestMove(game, { side: 'red', depth: 1 });
  else move = game.legalMoves[0];
  if (!move) { showToast('暂时没有可行军路线'); return; }
  const code = game.pieceAt(move.from.x, move.from.y);
  const meta = PIECES[code];
  selectSquare(move.from.x, move.from.y);
  const marker = markersOnBoard.get(squareKey(move.to.x, move.to.y));
  if (marker) marker.material.color.set(0x8ed1bf);
  showToast(`军师建议：${meta.label} ${move.from.x + 1}路 → ${move.to.x + 1}路`);
  clearTimeout(hintTimer);
  hintTimer = setTimeout(clearSelection, 2600);
}

function updateHud(result = null, movingCode = null, capturedCode = null) {
  const side = game.turn;
  const redTurn = side === 'red';
  ui.turnDot.classList.toggle('black', !redTurn);
  ui.turnLabel.textContent = redTurn ? '汉军回合' : '楚军回合';
  ui.turnSub.textContent = game.gameOver ? '战局已定' : (mode === 'ai' && !redTurn ? '楚军正在布阵…' : '请下达军令');
  ui.round.textContent = `第 ${game.moveNumber} 回合`;
  ui.undo.disabled = !game.history.length || animating;
  const redCount = game.board.filter((piece) => piece && sideOf(piece) === 'red').length;
  const blackCount = game.board.filter((piece) => piece && sideOf(piece) === 'black').length;
  ui.redMaterial.textContent = String(redCount);
  ui.blackMaterial.textContent = String(blackCount);
  ui.statusStrip.classList.toggle('danger', game.status === 'check' || Boolean(capturedCode));
  if (game.gameOver) {
    ui.status.textContent = game.status.includes('red') ? '汉军完成合围 · 将帅归位' : game.status.includes('black') ? '楚军突破中军 · 汉帅失守' : '双方暂时僵持';
  } else if (result?.check) {
    ui.status.textContent = '将军！对方中军受到威胁';
  } else if (capturedCode && movingCode) {
    ui.status.textContent = `${PIECES[movingCode].label} 发起冲杀 · ${PIECES[capturedCode].label} 已阵亡`;
  } else if (!selected) {
    ui.status.textContent = redTurn ? '汉军先行 · 鸿沟为界' : '楚军回合 · 暂避锋芒';
  }
  if (result?.move && movingCode) {
    const from = result.move.from; const to = result.move.to;
    const text = `${PIECES[movingCode].label} ${from.x + 1}·${10 - from.y} → ${to.x + 1}·${10 - to.y}${capturedCode ? ` · 吃${PIECES[capturedCode].label}` : ''}`;
    updateEventLog(text);
  }
}

function updateEventLog(text, reset = false) {
  if (reset) eventLines.length = 0;
  eventLines.unshift(text);
  while (eventLines.length > 4) eventLines.pop();
  ui.log.innerHTML = eventLines.map((line, index) => `<li class="${index === 0 ? '' : 'event-muted'}">${escapeHtml(line)}</li>`).join('');
}

function showToast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1900);
}

function squareKey(x, y) { return `${x},${y}`; }
function squareWorld(x, y) {
  const worldX = x - 4;
  const worldZ = y - 4.5;
  return new THREE.Vector3(worldX, terrainHeight(worldX, worldZ), worldZ);
}
function escapeHtml(text) { return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }

function spawnMarchDust(position) {
  const count = isTouchDevice ? 8 : 13;
  for (let i = 0; i < count; i += 1) spawnParticle('dust', position.clone().setY(.44 + Math.random() * .04));
  cameraShake = Math.max(cameraShake, .012);
}

function spawnCombatEffects(type, position) {
  const cannon = type === 'c';
  const count = isTouchDevice ? (cannon ? 16 : 11) : (cannon ? 28 : 18);
  for (let i = 0; i < count; i += 1) spawnParticle(cannon ? 'smoke' : (i % 3 ? 'dust' : 'spark'), position.clone().setY(.5 + Math.random() * .18));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.12, .026, 6, 22), new THREE.MeshBasicMaterial({ color: cannon ? 0xffb657 : 0xf08a62, transparent: true, opacity: .9, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.copy(position).setY(.51); effectLayer.add(ring);
  effects.push({ kind: 'ring', mesh: ring, life: 0, maxLife: prefersReducedMotion ? .16 : .48, baseScale: 1 });
  cameraShake = Math.max(cameraShake, cannon ? .14 : .095);
}

function spawnParticle(kind, position) {
  const texture = kind === 'spark' ? getSparkTexture() : getSmokeTexture();
  const color = kind === 'spark' ? 0xffbd5e : kind === 'dust' ? 0xc19d78 : 0x9fa8a1;
  const material = new THREE.SpriteMaterial({ map: texture, color, transparent: true, opacity: kind === 'spark' ? .95 : .35, depthWrite: false, blending: kind === 'spark' ? THREE.AdditiveBlending : THREE.NormalBlending });
  const sprite = new THREE.Sprite(material);
  sprite.position.copy(position);
  const scale = kind === 'spark' ? .08 + Math.random() * .06 : .18 + Math.random() * .2;
  sprite.scale.setScalar(scale);
  effectLayer.add(sprite);
  const angle = Math.random() * Math.PI * 2;
  const speed = kind === 'spark' ? .8 + Math.random() * 1.9 : .12 + Math.random() * .42;
  effects.push({ kind, mesh: sprite, life: 0, maxLife: kind === 'spark' ? .28 + Math.random() * .24 : .65 + Math.random() * .65, vel: new THREE.Vector3(Math.cos(angle) * speed, kind === 'spark' ? .5 + Math.random() * .9 : .25 + Math.random() * .35, Math.sin(angle) * speed), baseScale: scale });
}

let smokeTexture;
let sparkTexture;
function getSmokeTexture() {
  if (smokeTexture) return smokeTexture;
  smokeTexture = makeParticleTexture('smoke'); return smokeTexture;
}
function getSparkTexture() {
  if (sparkTexture) return sparkTexture;
  sparkTexture = makeParticleTexture('spark'); return sparkTexture;
}
function makeParticleTexture(kind) {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  if (kind === 'spark') {
    ctx.fillStyle = '#fff0b5'; ctx.shadowColor = '#ff9c45'; ctx.shadowBlur = 18; ctx.beginPath(); ctx.arc(32, 32, 7, 0, Math.PI * 2); ctx.fill();
  } else {
    const gradient = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(240,237,213,.7)'); gradient.addColorStop(.45, 'rgba(172,177,160,.28)'); gradient.addColorStop(1, 'rgba(90,100,94,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  }
  const texture = new THREE.CanvasTexture(c); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

function updateEffects(delta) {
  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    effect.life += delta;
    const t = Math.min(1, effect.life / effect.maxLife);
    if (effect.kind === 'ring') {
      effect.mesh.scale.setScalar(1 + t * 4.3);
      effect.mesh.material.opacity = .86 * (1 - t);
    } else {
      effect.mesh.position.addScaledVector(effect.vel, delta);
      if (effect.kind !== 'spark') effect.vel.multiplyScalar(0.985);
      effect.vel.y -= effect.kind === 'spark' ? 1.55 * delta : -.05 * delta;
      const fade = 1 - t;
      effect.mesh.material.opacity = (effect.kind === 'spark' ? .95 : .34) * fade;
      effect.mesh.scale.setScalar(effect.baseScale * (effect.kind === 'smoke' ? 1 + t * 1.7 : 1 - t * .35));
    }
    if (t >= 1) {
      effectLayer.remove(effect.mesh);
      if (effect.mesh.material?.dispose) effect.mesh.material.dispose();
      effects.splice(i, 1);
    }
  }
}

function updateTorches(time) {
  for (const torch of torches) {
    const wave = Math.sin(time * 7 + torch.phase) * .12 + Math.sin(time * 13 + torch.phase * 1.8) * .06;
    torch.flame.scale.set(1 + wave, 1 - wave * .5, 1 + wave);
    torch.light.intensity = torch.base * (1 + wave * .7);
  }
}

function updateBattlefieldSmoke(time) {
  for (const smoke of battlefieldSmoke) {
    const drift = Math.sin(time * .34 + smoke.phase) * .16;
    smoke.puff.position.x = smoke.origin.x + drift;
    smoke.puff.position.z = smoke.origin.z + Math.cos(time * .28 + smoke.phase) * .08;
    const pulse = 1 + Math.sin(time * .55 + smoke.phase) * .08;
    smoke.puff.scale.setScalar(smoke.base * pulse);
    smoke.puff.material.opacity = .12 + (Math.sin(time * .42 + smoke.phase) + 1) * .025;
  }
}

function resize() {
  if (!renderer || !sceneWrap) return;
  const width = Math.max(1, sceneWrap.clientWidth);
  const height = Math.max(1, sceneWrap.clientHeight);
  const nextNarrow = width < 700;
  if (nextNarrow !== narrowViewport) {
    narrowViewport = nextNarrow;
    camera.fov = nextNarrow ? 42 : 32;
    camera.position.set(0, nextNarrow ? 18.7 : 12.2, nextNarrow ? 22.4 : 14.2);
    controls.maxDistance = nextNarrow ? 29 : 20;
    controls.target.set(0, .48, 0);
    controls.update();
    controls.saveState();
  }
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function renderLoop(now) {
  const delta = Math.min(.05, clock.getDelta());
  const time = now * .001;
  controls.update();
  updateEffects(delta);
  updateTorches(time);
  updateBattlefieldSmoke(time);
  for (const group of piecesOnBoard.values()) {
    if (group.userData.selected) {
      const frame = group.getObjectByName('selection-frame');
      if (frame) {
        const pulse = 1 + Math.sin(time * 4.3) * .08;
        frame.scale.setScalar(pulse);
      }
    }
  }
  const shake = cameraShake > 0 ? cameraShake * (1 - Math.min(1, delta * 5)) : 0;
  if (cameraShake > 0) cameraShake = Math.max(0, cameraShake - delta * .42);
  battleGroup.position.sub(shakeOffset);
  shakeOffset.set((Math.random() - .5) * shake, (Math.random() - .5) * shake * .35, (Math.random() - .5) * shake);
  battleGroup.position.add(shakeOffset);
  renderer.render(scene, camera);
  lastFrame = now;
  animationFrame = requestAnimationFrame(renderLoop);
}

class BattleAudio {
  constructor() {
    this.context = null;
    this.enabled = true;
    this.noiseBuffer = null;
  }

  unlock() {
    if (!this.enabled) return;
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      this.context = new AudioContextClass();
      this.noiseBuffer = this.createNoiseBuffer();
    }
    if (this.context.state === 'suspended') this.context.resume();
  }

  suspend() { if (this.context && this.context.state === 'running') this.context.suspend(); }
  resume() { if (this.enabled && this.context && this.context.state === 'suspended') this.context.resume(); }

  createNoiseBuffer() {
    const length = this.context.sampleRate * 1.2;
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    return buffer;
  }

  play(kind) {
    if (!this.enabled || !this.context) return;
    const now = this.context.currentTime;
    if (kind === 'move') {
      this.tone(115, 82, .18, 'triangle', .07, now);
      this.noise(.13, .05, 900, now + .015);
    } else if (kind === 'capture') {
      this.tone(170, 58, .22, 'sawtooth', .12, now);
      this.tone(410, 180, .12, 'square', .035, now + .035);
      this.noise(.32, .15, 700, now + .03);
      this.tone(250, 120, .18, 'triangle', .05, now + .12);
    } else if (kind === 'cannon') {
      this.tone(92, 34, .48, 'sine', .24, now);
      this.noise(.48, .25, 420, now);
      this.tone(780, 220, .08, 'square', .07, now + .025);
    } else if (kind === 'check') {
      this.tone(520, 760, .18, 'triangle', .09, now);
      this.tone(760, 980, .2, 'triangle', .06, now + .12);
    } else if (kind === 'warcry') {
      // A short two-syllable battle cry synthesized from a rough vocal band;
      // it stays light enough for mobile speakers but reads as a human shout.
      this.tone(180, 265, .19, 'sawtooth', .075, now);
      this.tone(235, 125, .24, 'triangle', .06, now + .12);
      this.noise(.16, .025, 1250, now + .02);
    }
  }

  tone(from, to, duration, type, gainValue, start) {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(from, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(gainValue, start + .012);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    oscillator.connect(gain).connect(this.context.destination);
    oscillator.start(start); oscillator.stop(start + duration + .03);
  }

  noise(duration, gainValue, filterFrequency, start) {
    if (!this.noiseBuffer) return;
    const source = this.context.createBufferSource(); source.buffer = this.noiseBuffer;
    const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = filterFrequency;
    const gain = this.context.createGain();
    gain.gain.setValueAtTime(.0001, start); gain.gain.exponentialRampToValueAtTime(gainValue, start + .01); gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    source.connect(filter).connect(gain).connect(this.context.destination); source.start(start); source.stop(start + duration + .03);
  }
}

audio = new BattleAudio();
init();
