import { Environment, Html, Lightformer, OrbitControls, Stars } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  SMAA,
  Vignette,
} from '@react-three/postprocessing';
import { BlendFunction } from 'postprocessing';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

import type { Focus } from '../engineContext';
import { HANDOVER_STATION, SATELLITE, STATION, STATION_LABEL, STATION_PLACE } from '../sim/copy';
import { clamp, easeInOutCubic, smooth } from '../sim/noise';
import type { Engine } from '../sim/engine';
import { passProfile } from '../sim/geometry';
import { Beam, type BeamState } from './Beam';
import { Jammer, RelayArcs, RogueTransmitter, StationMarker, stationPosition } from './Actors';
import { Earth, SUN_DIR } from './Earth';
import { ATTACKERS, STATIONS, orbitArcPoints, orbitPoint, surfacePoint } from './geo';
import { GroundStation, type StationHandle, type StationTone } from './GroundStation';
import { Satellite, type SatelliteHandle } from './Satellite';
import { Sky } from './Sky';

const COLORS = {
  accent: new THREE.Color('#4CC9F0'),
  bad: new THREE.Color('#F8485E'),
  warn: new THREE.Color('#FBBF24'),
  ok: new THREE.Color('#34D399'),
  idle: new THREE.Color('#7D8EA3'),
  jam: new THREE.Color('#A78BFA'),
  tamper: new THREE.Color('#F472B6'),
  uplink: new THREE.Color('#FF9F5A'),
};

const STATION_ORIGIN = new THREE.Vector3(0, 0, 0);
/** The uplink leaves the station beside the downlink, so the two beams read apart. */
const UPLINK_OFFSET = new THREE.Vector3(0.32, 0.06, 0.12);
/** Lens fringing at the frame edges, high tier only. */
const CA_OFFSET = new THREE.Vector2(0.0007, 0.0005);
const FALLBACK = stationPosition(HANDOVER_STATION);

interface SceneProps {
  engine: Engine;
  focus: Focus;
  setFocus: (f: Focus) => void;
  reduced: boolean;
}

type Tier = 0 | 1 | 2;

/** Render quality per tier: low drops the bloom pass, high adds MSAA and a sharper pixel ratio. */
/** How much the shell's frame scales the testbed up, so the canvas renders at the shown size. */
function frameZoom(): number {
  try {
    const frame = window.frameElement;
    if (!frame || !window.innerWidth) return 1;
    return Math.max(1, frame.getBoundingClientRect().width / window.innerWidth);
  } catch {
    return 1;
  }
}

const TIERS: Record<Tier, { dpr: number; bloom: boolean; samples: number }> = {
  0: { dpr: 0.8, bloom: false, samples: 0 },
  1: { dpr: 1, bloom: true, samples: 0 },
  2: { dpr: 1.5, bloom: true, samples: 4 },
};
const TIER_KEY = 'gs-lab.gfx-tier';

function loadTier(): Tier {
  try {
    const v = window.localStorage.getItem(TIER_KEY);
    return v === '0' ? 0 : v === '2' ? 2 : 1;
  } catch {
    return 1;
  }
}

function saveTier(t: Tier) {
  try {
    window.localStorage.setItem(TIER_KEY, String(t));
  } catch {
    // Storage unavailable: the tier is re-measured next visit.
  }
}

function Scene(props: SceneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [tier, setTier] = useState<Tier>(loadTier);
  const [onScreen, setOnScreen] = useState(true);
  // The GPU can drop the WebGL context (driver reset, memory pressure). The browser restores it
  // and three.js re-uploads every resource; if that never happens, offer a reload.
  const [lost, setLost] = useState(false);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!lost) {
      setStuck(false);
      return;
    }
    const id = window.setTimeout(() => setStuck(true), 6000);
    return () => window.clearTimeout(id);
  }, [lost]);

  const changeTier = useCallback((t: Tier) => {
    setTier(t);
    saveTier(t);
  }, []);

  const q = TIERS[tier];
  return (
    <div ref={wrap} className="scene-root">
      <Canvas
        dpr={Math.min(
          (window.devicePixelRatio || 1) * frameZoom(),
          q.dpr * Math.max(1, frameZoom()),
        )}
        frameloop={onScreen && !lost ? 'always' : 'never'}
        camera={{
          fov: 38,
          near: 0.1,
          far: 900,
          position: new THREE.Vector3(26, 11, 20).applyAxisAngle(UP, overviewTurn()),
        }}
        gl={{
          antialias: false,
          powerPreference: 'high-performance',
          alpha: false,
          toneMapping: THREE.ACESFilmicToneMapping,
          toneMappingExposure: 1.05,
        }}
        aria-label={`3D view of ${SATELLITE} passing over the ${STATION_PLACE} ground station`}
        onCreated={({ gl }) => {
          const canvas = gl.domElement;
          canvas.addEventListener('webglcontextlost', (e) => {
            // Without preventDefault the browser never restores the context.
            e.preventDefault();
            // A lost context usually means the GPU was overloaded: come back one tier lower.
            setTier((t) => {
              const next = Math.max(0, t - 1) as Tier;
              saveTier(next);
              return next;
            });
            setLost(true);
          });
          canvas.addEventListener('webglcontextrestored', () => setLost(false));
        }}
      >
        <color attach="background" args={['#04070C']} />
        <QualityGovernor tier={tier} onChange={changeTier} />
        <SceneContent {...props} bloom={q.bloom} samples={q.samples} fine={tier === 2} />
      </Canvas>
      {lost && (
        <div className="viewport__loading">
          {stuck ? (
            <div className="viewport__lost">
              The graphics driver stopped the 3D view.
              <button className="demo-button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </div>
          ) : (
            'Restoring 3D view…'
          )}
        </div>
      )}
    </div>
  );
}

export default memo(Scene);

const WINDOW_MS = 2000;
const WARMUP_MS = 3000;

/**
 * Measures the frame rate in 2 s windows and moves one tier down when it drops below 40 fps, or
 * one tier up after three windows at full refresh rate. A tier that had to be left is never
 * re-entered in the same session, so the quality cannot oscillate.
 */
function QualityGovernor({ tier, onChange }: { tier: Tier; onChange: (t: Tier) => void }) {
  const st = useRef({ born: performance.now(), t0: 0, frames: 0, last: 0, good: 0, cap: 2 });
  useEffect(() => {
    st.current.t0 = 0;
    st.current.good = 0;
  }, [tier]);

  useFrame(() => {
    const s = st.current;
    const now = performance.now();
    // Hidden tab, paused loop or a hitch: restart the window instead of counting the gap.
    if (now - s.born < WARMUP_MS || document.hidden || now - s.last > 1000) s.t0 = 0;
    s.last = now;
    if (!s.t0) {
      s.t0 = now;
      s.frames = 0;
      return;
    }
    s.frames++;
    const span = now - s.t0;
    if (span < WINDOW_MS) return;
    const fps = (s.frames * 1000) / span;
    s.t0 = now;
    s.frames = 0;
    if (fps < 40 && tier > 0) {
      s.cap = tier - 1;
      onChange((tier - 1) as Tier);
    } else if (fps > 56 && tier < s.cap) {
      if (++s.good >= 3) onChange((tier + 1) as Tier);
    } else {
      s.good = 0;
    }
  });
  return null;
}

function satVisibility(elevationDeg: number): number {
  return smooth(-2.5, 2, elevationDeg);
}

function SceneContent({
  engine,
  focus,
  setFocus,
  reduced,
  bloom,
  samples,
  fine,
}: SceneProps & { bloom: boolean; samples: number; fine: boolean }) {
  const sat = useRef<SatelliteHandle>(null);
  const station = useRef<StationHandle>(null);
  const satLabel = useRef<THREE.Group>(null!);

  const satPos = useMemo(() => new THREE.Vector3(), []);
  const feedA = useMemo(() => new THREE.Vector3(), []);
  const feedB = useMemo(() => new THREE.Vector3(), []);
  const beamColor = useMemo(() => new THREE.Color(), []);

  const orbitLine = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(orbitArcPoints(240));
    const line = new THREE.Line(
      g,
      new THREE.LineDashedMaterial({
        color: '#CEE6FF',
        dashSize: 0.35,
        gapSize: 0.28,
        transparent: true,
        opacity: 0.4,
      }),
    );
    line.computeLineDistances();
    return line;
  }, []);

  // Per-frame read models shared by the actors.
  const kindActive = (kind: string) => (engine.attack?.kind === kind ? engine.attackEnvelope : 0);
  const serving = () => (engine.route === 'MAT' ? FALLBACK : feedB);

  useFrame(() => {
    const pass = engine.visualPass();
    orbitPoint(pass.sceneAngle, satPos);
    if (station.current) station.current.feedWorld(feedB);
    if (sat.current) sat.current.feedWorld(feedA);
    satLabel.current.position.copy(satPos).add(new THREE.Vector3(0, 2.1, 0));
    satLabel.current.visible = pass.inView;
  });

  const stationTone = (): StationTone => {
    if (engine.quarantined) return 'idle';
    const kind = engine.attack?.kind;
    if (kind && engine.attackEnvelope > 0.2)
      return kind === 'jam'
        ? engine.route === 'MAT'
          ? 'idle'
          : 'warn'
        : kind === 'spoof' || kind === 'tamper'
          ? 'warn'
          : 'bad';
    return 'ok';
  };

  // The telecommand uplink climbs from the serving station to the satellite, beside the
  // downlink. Tampered commands ride it in red; forged and replayed ones come from the rogue
  // uplink station instead.
  const uplinkColor = useMemo(() => new THREE.Color(), []);
  const uplinkStart = useMemo(() => new THREE.Vector3(), []);
  const rogueUplink = useMemo(
    () => surfacePoint(ATTACKERS.uplink.lat, ATTACKERS.uplink.lon, 0.62),
    [],
  );
  const uplinkThreat = () => engine.uplinkRun?.threat ?? null;
  const uplink = (): BeamState => {
    const pass = engine.visualPass();
    const tampered = uplinkThreat() === 'cmdtamper';
    uplinkColor.copy(COLORS.uplink);
    if (tampered) uplinkColor.lerp(COLORS.bad, 0.75);
    uplinkStart.copy(serving()).add(UPLINK_OFFSET);
    return {
      a: uplinkStart,
      b: feedA,
      visible: pass.linkActive && !engine.quarantined,
      color: uplinkColor,
      opacity: 0.6,
      speed: tampered ? 2.6 : 1.3,
      wave: tampered ? 0.12 : 0,
      waveFreq: 7,
    };
  };
  const hostileUplink = (): BeamState => {
    const threat = uplinkThreat();
    return {
      a: rogueUplink,
      b: feedA,
      visible: engine.visualPass().linkActive && (threat === 'cmdinject' || threat === 'cmdreplay'),
      color: COLORS.bad,
      opacity: 0.85,
      flicker: 0.35,
      speed: 2.4,
    };
  };

  // The one downlink beam carries every scenario: colour and distortion follow the attack.
  const downlink = (): BeamState => {
    const pass = engine.visualPass();
    const hijack = kindActive('hijack');
    const spoof = kindActive('spoof');
    const tamper = kindActive('tamper');
    const jam = engine.route === 'ZAG' ? kindActive('jam') : 0;
    const quarantined = engine.quarantined;
    if (quarantined) beamColor.copy(COLORS.idle);
    else if (engine.route === 'MAT') beamColor.copy(COLORS.ok);
    else {
      beamColor.copy(COLORS.accent);
      if (hijack) beamColor.lerp(COLORS.bad, hijack);
      if (spoof) beamColor.lerp(COLORS.warn, spoof);
      if (tamper) beamColor.lerp(COLORS.tamper, tamper);
      if (jam) beamColor.lerp(COLORS.jam, jam);
    }
    return {
      a: feedA,
      b: serving(),
      visible: pass.linkActive,
      color: beamColor,
      opacity: quarantined ? 0.45 : 1 - 0.3 * jam,
      dashed: quarantined,
      flicker: clamp(jam * 1.2),
      static: jam,
      wave: 0.34 * hijack + 0.05 * spoof + 0.03 * tamper,
      waveFreq: 9,
      speed: engine.attack && engine.attackEnvelope > 0.2 ? 2.6 : 1.6,
    };
  };

  return (
    <>
      <ambientLight intensity={0.5} color="#9db8d8" />
      <directionalLight
        position={SUN_DIR.clone().multiplyScalar(60)}
        intensity={2.8}
        color="#fff6e8"
      />
      <directionalLight position={[20, -14, 24]} intensity={0.55} color="#4CC9F0" />
      <hemisphereLight args={['#2b4a6b', '#04070C', 0.35]} />
      {/* Studio-style reflections for the metal and foil, generated once on the GPU. */}
      <Environment resolution={64} frames={1} environmentIntensity={0.55}>
        <Lightformer
          form="rect"
          intensity={4}
          color="#fff4e0"
          position={SUN_DIR.clone().multiplyScalar(12).toArray()}
          scale={[10, 10, 1]}
          target={[0, 0, 0]}
        />
        <Lightformer
          form="ring"
          intensity={1.2}
          color="#4CC9F0"
          position={[0, -12, 6]}
          scale={8}
          target={[0, 0, 0]}
        />
        <Lightformer
          form="rect"
          intensity={0.8}
          color="#9db8d8"
          position={[-10, 4, -8]}
          scale={[6, 4, 1]}
          target={[0, 0, 0]}
        />
      </Environment>

      <Sky />
      <Stars
        radius={320}
        depth={90}
        count={6000}
        factor={6}
        saturation={0}
        fade
        speed={reduced ? 0 : 0.35}
      />
      <Earth />
      <primitive object={orbitLine} />

      <RelayArcs
        getState={() => ({
          alertLink:
            engine.attack && engine.attack.kind !== 'jam' && engine.attackEnvelope > 0.2
              ? 'GS-ZAG-GS-MAT'
              : null,
        })}
      />

      {STATIONS.filter((s) => s.id !== STATION).map((s) => (
        <StationMarker
          key={s.id}
          id={s.id}
          showLabel={s.id === HANDOVER_STATION || s.id === 'GS-SVB'}
          getState={() => {
            const handover = s.id === HANDOVER_STATION && engine.route === 'MAT';
            return { color: handover ? COLORS.ok : COLORS.accent, speed: handover ? 2 : 1 };
          }}
        />
      ))}

      <GroundStation
        ref={station}
        onSelect={() => setFocus('station')}
        getState={() => ({
          target: engine.visualPass().linkActive && engine.route === 'ZAG' ? satPos : null,
          tone: stationTone(),
          ringSpeed: stationTone() === 'bad' ? 2.6 : stationTone() === 'warn' ? 2 : 1,
        })}
      />
      <group position={[0, 2.6, 0]}>
        <Html center zIndexRange={[20, 0]}>
          <button className="scene-label scene-label--button" onClick={() => setFocus('station')}>
            {STATION_LABEL}
            {focus === 'overview' && <span className="scene-label__hint">click to zoom</span>}
          </button>
        </Html>
      </group>

      <Satellite
        ref={sat}
        variant={[31698, 36605].includes(passProfile().noradId ?? 0) ? 'tsx' : 'generic'}
        onSelect={() => setFocus('sat')}
        getState={() => {
          const pass = engine.visualPass();
          return {
            position: satPos,
            target: pass.linkActive ? serving() : null,
            visible: satVisibility(pass.elevationDeg),
            transmitting: pass.linkActive,
          };
        }}
      />
      <group ref={satLabel}>
        <Html center zIndexRange={[20, 0]}>
          <button className="scene-label scene-label--button" onClick={() => setFocus('sat')}>
            {SATELLITE}
            {focus === 'overview' && <span className="scene-label__hint">click to zoom</span>}
          </button>
        </Html>
      </group>

      <Beam getState={downlink} radiusA={0.04} radiusB={0.3} packetCount={5} />
      <Beam getState={uplink} radiusA={0.09} radiusB={0.025} packetCount={2} packetSize={0.075} />
      <Beam getState={hostileUplink} radiusA={0.1} radiusB={0.03} packetCount={3} />
      <RogueTransmitter
        lat={ATTACKERS.uplink.lat}
        lon={ATTACKERS.uplink.lon}
        aim={feedA}
        label={ATTACKERS.uplink.label}
        getState={() => {
          const threat = uplinkThreat();
          return {
            strength: threat === 'cmdinject' || threat === 'cmdreplay' ? 1 : 0,
            color: COLORS.bad,
          };
        }}
      />

      <RogueTransmitter
        lat={ATTACKERS.hijack.lat}
        lon={ATTACKERS.hijack.lon}
        aim={STATION_ORIGIN}
        label={ATTACKERS.hijack.label}
        getState={() => ({ strength: kindActive('hijack'), color: COLORS.bad })}
      />
      <RogueTransmitter
        lat={ATTACKERS.spoof.lat}
        lon={ATTACKERS.spoof.lon}
        aim={STATION_ORIGIN}
        label={ATTACKERS.spoof.label}
        getState={() => ({ strength: kindActive('spoof'), color: COLORS.warn })}
      />

      <Jammer
        lat={ATTACKERS.jam.lat}
        lon={ATTACKERS.jam.lon}
        getState={() => ({ strength: kindActive('jam'), power: engine.appliedPower })}
      />

      <CameraRig engine={engine} focus={focus} reduced={reduced} satPos={satPos} />

      {bloom && (
        <EffectComposer multisampling={samples}>
          <Bloom
            mipmapBlur
            intensity={1.05}
            luminanceThreshold={0.62}
            luminanceSmoothing={0.25}
            radius={0.72}
          />
          {fine ? (
            <ChromaticAberration offset={CA_OFFSET} radialModulation modulationOffset={0.35} />
          ) : (
            <SMAA />
          )}
          <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.12} />
          <Vignette offset={0.28} darkness={0.55} />
        </EffectComposer>
      )}
    </>
  );
}

type Mode = Focus | 'attack';

/**
 * The overview looks at the station from the south-east (azimuth 127°), framed for the
 * reference pass, which culminates near the zenith. A live pass is lower, so the overview
 * turns about the station to look toward the azimuth where it culminates: the pass then
 * crosses the sky beyond the station, as seen from the same three-quarter angle.
 */
function overviewTurn(): number {
  const profile = passProfile();
  // A positive turn about +Y lowers the azimuth: the camera ends up at culmination + 217°.
  return profile.source === 'reference' ? 0 : -((profile.culminationAzDeg + 90) * Math.PI) / 180;
}

const UP = new THREE.Vector3(0, 1, 0);

function overviewPose(): { target: THREE.Vector3; offset: THREE.Vector3 } {
  const turn = overviewTurn();
  return {
    target: new THREE.Vector3(0.5, 4.4, 0).applyAxisAngle(UP, turn),
    offset: new THREE.Vector3(21, 6.4, 16).applyAxisAngle(UP, turn),
  };
}

const POSES: Record<Exclude<Mode, 'sat'>, { target: THREE.Vector3; offset: THREE.Vector3 }> = {
  overview: { target: new THREE.Vector3(0.5, 4.4, 0), offset: new THREE.Vector3(21, 6.4, 16) },
  attack: { target: new THREE.Vector3(-0.6, 1.4, 0.4), offset: new THREE.Vector3(9.5, 4.6, 10.5) },
  station: { target: new THREE.Vector3(0, 1.1, 0), offset: new THREE.Vector3(5.2, 2.4, 5.8) },
};
const SAT_OFFSET = new THREE.Vector3(8.8, 2.1, 10.2);
const DISTANCE_LIMITS: Record<Mode, [number, number]> = {
  overview: [8, 70],
  attack: [5, 40],
  station: [2.6, 16],
  sat: [2.4, 18],
};

function CameraRig({
  engine,
  focus,
  reduced,
  satPos,
}: {
  engine: Engine;
  focus: Focus;
  reduced: boolean;
  satPos: THREE.Vector3;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, size } = useThree();
  const shift = useRef(0);
  const [mode, setMode] = useState<Mode>('overview');
  const modeRef = useRef<Mode>('overview');
  const anim = useRef<{
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    t0: number;
    dur: number;
  } | null>(null);
  const followed = useRef(new THREE.Vector3());
  const focusPoint = useRef(new THREE.Vector3());
  // The overview follows the pass flown (live or reference); the other poses frame the station.
  const poses = useMemo(() => ({ ...POSES, overview: overviewPose() }), []);

  const pointFor = (m: Mode, out: THREE.Vector3) =>
    m === 'sat' ? out.copy(satPos) : out.copy(poses[m].target);
  // Portrait screens need the camera further back to keep both bodies in frame.
  const aspectScale = Math.max(1, Math.pow(1.5 / (size.width / Math.max(size.height, 1)), 0.85));
  const offsetFor = (m: Mode) =>
    m === 'sat'
      ? SAT_OFFSET
      : m === 'station'
        ? poses[m].offset
        : poses[m].offset.clone().multiplyScalar(aspectScale);

  const go = (m: Mode) => {
    const c = controls.current;
    if (!c) return;
    // Spend leftover drag momentum now, so it cannot rotate the camera once the flight ends.
    c.enableDamping = false;
    c.update();
    c.enableDamping = true;
    // Disabled right away: an enabled update would clamp the camera to the new mode's
    // distance limits before the flight starts.
    c.enabled = false;
    anim.current = {
      fromPos: camera.position.clone(),
      fromTarget: c.target.clone(),
      t0: performance.now(),
      dur: reduced ? 0 : m === 'attack' || modeRef.current === 'attack' ? 1.0 : 1.35,
    };
    modeRef.current = m;
    setMode(m);
  };

  useEffect(() => {
    go(focus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;

    // Shift the projection centre into the uncovered part of the view while the detail overlay
    // sits on the right (it does above 900 px of window width; below, it docks at the bottom).
    // The overlay is min(460 px, 52 %) wide with an 8–12 px margin, as in index.css.
    const overlay = Math.min(460, size.width * 0.52) + 12;
    const wantShift = focus !== 'overview' && window.innerWidth > 900 ? overlay / 2 : 0;
    shift.current += (wantShift - shift.current) * (reduced ? 1 : 1 - Math.exp(-dt * 5));
    const cam = camera as THREE.PerspectiveCamera;
    if (Math.abs(shift.current) > 0.5)
      cam.setViewOffset(size.width, size.height, shift.current, 0, size.width, size.height);
    else if (cam.view?.enabled) cam.clearViewOffset();

    // In the overview, attacks pull the camera to the station region and release it afterwards.
    if (focus === 'overview') {
      const hot = engine.state === 'UNDER ATTACK' || engine.state === 'JAMMING';
      if (hot && modeRef.current === 'overview' && !anim.current) go('attack');
      if (!hot && !engine.attack && modeRef.current === 'attack' && !anim.current) go('overview');
    }

    const m = modeRef.current;
    const fp = pointFor(m, focusPoint.current);
    const a = anim.current;
    if (a) {
      const p = a.dur === 0 ? 1 : easeInOutCubic((performance.now() - a.t0) / (a.dur * 1000));
      c.target.lerpVectors(a.fromTarget, fp, p);
      camera.position.lerpVectors(a.fromPos, fp.clone().add(offsetFor(m)), p);
      // The controls are off during the flight, so aim the camera here or it keeps its old heading.
      camera.lookAt(c.target);
      c.enabled = false;
      if (p >= 1) {
        anim.current = null;
        c.enabled = true;
        followed.current.copy(fp);
      }
    } else if (m === 'sat') {
      // Follow the moving satellite while keeping the user's orbit around it.
      const delta = fp.clone().sub(followed.current);
      camera.position.add(delta);
      c.target.add(delta);
      followed.current.copy(fp);
    }
  });

  const [minD, maxD] = DISTANCE_LIMITS[mode];
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      enablePan={false}
      minDistance={minD}
      maxDistance={maxD}
      maxPolarAngle={Math.PI * 0.49}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
    />
  );
}
