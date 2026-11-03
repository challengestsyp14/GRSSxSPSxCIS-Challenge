// Supporting actors: rogue transmitters, the jammer, other stations and relay arcs.

import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef, type ReactNode } from 'react';
import * as THREE from 'three';

import {
  EARTH_CENTER,
  EARTH_R,
  RELAY_LINKS,
  STATIONS,
  directionFor,
  stationById,
  surfacePoint,
  surfaceQuaternion,
} from './geo';

export function SceneLabel({
  children,
  tone = 'default',
  visible = true,
}: {
  children: ReactNode;
  tone?: 'default' | 'bad' | 'warn' | 'ok' | 'accent';
  visible?: boolean;
}) {
  return (
    <Html center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div className={`scene-label scene-label--${tone}`} style={{ opacity: visible ? 1 : 0 }}>
        {children}
      </div>
    </Html>
  );
}

function Rings({
  getState,
  radius = 1,
}: {
  getState: () => { color: THREE.Color; speed: number; opacity: number };
  radius?: number;
}) {
  const refs = useRef<THREE.Mesh[]>([]);
  const phase = useRef(0);
  useFrame((_, dt) => {
    const st = getState();
    phase.current += dt * st.speed;
    refs.current.forEach((m, i) => {
      if (!m) return;
      const p = (phase.current / 2.4 + i / 3) % 1;
      m.scale.setScalar(radius * (0.3 + p * 3));
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.opacity = (1 - p) * 0.6 * st.opacity;
      mat.color.copy(st.color);
      m.visible = st.opacity > 0.01;
    });
  });
  return (
    <>
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          ref={(el) => {
            if (el) refs.current[i] = el;
          }}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.03, 0]}
        >
          <ringGeometry args={[0.94, 1, 72]} />
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
    </>
  );
}

/** Portable ground transmitter: tripod, horn aimed at the target, warning glow. */
export function RogueTransmitter({
  lat,
  lon,
  aim,
  label,
  getState,
}: {
  lat: number;
  lon: number;
  aim: THREE.Vector3;
  label: string;
  getState: () => { strength: number; color: THREE.Color };
}) {
  const group = useRef<THREE.Group>(null!);
  const glow = useRef<THREE.MeshBasicMaterial>(null!);
  const position = useMemo(() => surfacePoint(lat, lon), [lat, lon]);
  const quaternion = useMemo(() => surfaceQuaternion(lat, lon), [lat, lon]);
  const hornYaw = useMemo(() => {
    const local = aim.clone().sub(position).applyQuaternion(quaternion.clone().invert());
    return Math.atan2(local.x, local.z);
  }, [aim, position, quaternion]);
  const metal = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#6c7580', metalness: 0.7, roughness: 0.45 }),
    [],
  );
  const labelState = useRef({ visible: false });

  useFrame(({ clock }) => {
    const st = getState();
    const g = group.current;
    g.visible = st.strength > 0.02;
    labelState.current.visible = g.visible;
    const s = 0.4 + 0.6 * st.strength;
    g.scale.setScalar(s);
    glow.current.color.copy(st.color).multiplyScalar(1.6 + 0.8 * Math.sin(clock.elapsedTime * 9));
  });

  return (
    <group ref={group} position={position} quaternion={quaternion}>
      {[0, 1, 2].map((k) => {
        const a = (k / 3) * Math.PI * 2;
        return (
          <mesh
            key={k}
            material={metal}
            position={[Math.cos(a) * 0.12, 0.25, Math.sin(a) * 0.12]}
            rotation={[Math.sin(a) * 0.3, 0, -Math.cos(a) * 0.3]}
          >
            <cylinderGeometry args={[0.012, 0.012, 0.52, 5]} />
          </mesh>
        );
      })}
      <group position={[0, 0.55, 0]} rotation={[0, hornYaw, 0]}>
        <mesh material={metal} rotation={[Math.PI / 2 - 0.35, 0, 0]} position={[0, 0.02, 0.08]}>
          <coneGeometry args={[0.14, 0.34, 4, 1, true]} />
        </mesh>
        <mesh material={metal}>
          <boxGeometry args={[0.18, 0.12, 0.16]} />
        </mesh>
      </group>
      <mesh position={[0, 0.55, 0]}>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial ref={glow} transparent opacity={0.9} toneMapped={false} />
      </mesh>
      <Rings
        radius={0.5}
        getState={() => ({ ...getState(), speed: 2.6, opacity: getState().strength })}
      />
      <group position={[0, 1.25, 0]}>
        <SceneLabelDynamic label={label} getState={getState} />
      </group>
    </group>
  );
}

function SceneLabelDynamic({
  label,
  getState,
}: {
  label: string;
  getState: () => { strength: number; color: THREE.Color };
}) {
  const el = useRef<HTMLDivElement>(null);
  useFrame(() => {
    const st = getState();
    if (!el.current) return;
    el.current.style.opacity = st.strength > 0.1 ? '1' : '0';
    el.current.style.color = `#${st.color.getHexString()}`;
  });
  return (
    <Html center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
      <div ref={el} className="scene-label" style={{ opacity: 0 }}>
        {label}
      </div>
    </Html>
  );
}

/** Jammer: a noise bloom whose radius follows attack power, with static speckle. */
export function Jammer({
  lat,
  lon,
  getState,
}: {
  lat: number;
  lon: number;
  getState: () => { strength: number; power: number };
}) {
  const group = useRef<THREE.Group>(null!);
  const bloom = useRef<THREE.Mesh>(null!);
  const speckle = useRef<THREE.Points>(null!);
  const position = useMemo(() => surfacePoint(lat, lon), [lat, lon]);
  const quaternion = useMemo(() => surfaceQuaternion(lat, lon), [lat, lon]);
  const count = 420;
  const speckleGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    return g;
  }, []);
  const violet = useMemo(() => new THREE.Color('#A78BFA'), []);

  useFrame(({ clock }) => {
    const st = getState();
    const g = group.current;
    g.visible = st.strength > 0.02;
    if (!g.visible) return;
    const r = (0.6 + st.power * 0.16) * st.strength;
    bloom.current.scale.setScalar(r);
    const m = bloom.current.material as THREE.MeshBasicMaterial;
    m.opacity = 0.16 + 0.08 * Math.sin(clock.elapsedTime * 20);
    const pos = speckleGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 - 1;
      const a = Math.random() * Math.PI * 2;
      const rr = r * Math.cbrt(Math.random()) * 1.15;
      const s = Math.sqrt(1 - u * u);
      pos.setXYZ(i, Math.cos(a) * s * rr, Math.abs(u) * rr + 0.1, Math.sin(a) * s * rr);
    }
    pos.needsUpdate = true;
  });

  return (
    <group ref={group} position={position} quaternion={quaternion}>
      <mesh ref={bloom} position={[0, 0.2, 0]}>
        <sphereGeometry args={[1, 32, 32]} />
        <meshBasicMaterial
          color={violet}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <points ref={speckle} geometry={speckleGeo}>
        <pointsMaterial
          color={new THREE.Color(1.5, 1.1, 2.6)}
          size={0.05}
          transparent
          opacity={0.9}
          depthWrite={false}
          toneMapped={false}
        />
      </points>
      <mesh position={[0, 0.35, 0]}>
        <cylinderGeometry args={[0.05, 0.08, 0.7, 8]} />
        <meshStandardMaterial color="#2e2448" metalness={0.6} roughness={0.5} />
      </mesh>
      <Rings
        radius={0.7}
        getState={() => ({ color: violet, speed: 2, opacity: getState().strength })}
      />
      <group position={[0, 1.6, 0]}>
        <SceneLabelDynamic
          label="NOISE JAMMER"
          getState={() => ({ strength: getState().strength, color: violet })}
        />
      </group>
    </group>
  );
}

/** Other ground stations: pylon, light and transceiver rings. */
export function StationMarker({
  id,
  getState,
  showLabel,
}: {
  id: string;
  getState: () => { color: THREE.Color; speed: number };
  showLabel?: boolean;
}) {
  const def = stationById(id);
  const position = useMemo(() => surfacePoint(def.lat, def.lon), [def]);
  const quaternion = useMemo(() => surfaceQuaternion(def.lat, def.lon), [def]);
  const light = useRef<THREE.MeshBasicMaterial>(null!);
  useFrame(() => {
    light.current.color.copy(getState().color).multiplyScalar(2);
  });
  return (
    <group position={position} quaternion={quaternion}>
      <mesh position={[0, 0.25, 0]}>
        <cylinderGeometry args={[0.05, 0.1, 0.5, 8]} />
        <meshStandardMaterial color="#aab4c0" metalness={0.5} roughness={0.5} />
      </mesh>
      <mesh position={[0, 0.56, 0]}>
        <sphereGeometry args={[0.09, 12, 12]} />
        <meshBasicMaterial ref={light} toneMapped={false} />
      </mesh>
      <Rings radius={0.55} getState={() => ({ ...getState(), opacity: 1 })} />
      {showLabel && (
        <group position={[0, 1.15, 0]}>
          <SceneLabel>{id}</SceneLabel>
        </group>
      )}
    </group>
  );
}

export function stationPosition(id: string): THREE.Vector3 {
  const def = stationById(id);
  return surfacePoint(def.lat, def.lon, 0.55);
}

/** Relay arcs between stations, lifted great circles with packets. */
export function RelayArcs({ getState }: { getState: () => { alertLink: string | null } }) {
  const arcs = useMemo(
    () =>
      RELAY_LINKS.map(([a, b]) => {
        const da = directionFor(stationById(a).lat, stationById(a).lon);
        const db = directionFor(stationById(b).lat, stationById(b).lon);
        const theta = da.angleTo(db);
        const pts: THREE.Vector3[] = [];
        for (let i = 0; i <= 64; i++) {
          const t = i / 64;
          const v = new THREE.Vector3().copy(da).lerp(db, t).normalize();
          const h = (0.03 + (0.2 * theta) / Math.PI) * Math.sin(Math.PI * t);
          pts.push(v.multiplyScalar(EARTH_R * (1 + h)).add(EARTH_CENTER));
        }
        const key = `${a}-${b}`;
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(pts),
          new THREE.LineBasicMaterial({
            color: '#4CC9F0',
            transparent: true,
            opacity: 0.32,
            depthWrite: false,
          }),
        );
        return { key, curve: new THREE.CatmullRomCurve3(pts), line };
      }),
    [],
  );
  const packets = useRef<THREE.InstancedMesh>(null!);
  const packetsPerArc = 2;
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colorOk = useMemo(() => new THREE.Color('#4CC9F0'), []);
  const colorBad = useMemo(() => new THREE.Color('#F8485E'), []);
  const tmpColor = useMemo(() => new THREE.Color(), []);

  useFrame(({ clock }) => {
    const { alertLink } = getState();
    const t = clock.elapsedTime;
    arcs.forEach((arc, i) => {
      const alert = arc.key === alertLink;
      const m = arc.line.material as THREE.LineBasicMaterial;
      m.color.copy(alert ? colorBad : colorOk);
      m.opacity = alert ? 0.55 + 0.35 * Math.sin(t * 14) : 0.32;
      for (let k = 0; k < packetsPerArc; k++) {
        const speed = alert ? 0.6 : 0.22;
        const p = (t * speed + k / packetsPerArc + i * 0.13) % 1;
        arc.curve.getPoint(p, dummy.position);
        dummy.scale.setScalar(alert ? 0.13 : 0.09);
        dummy.updateMatrix();
        const idx = i * packetsPerArc + k;
        packets.current.setMatrixAt(idx, dummy.matrix);
        packets.current.setColorAt(
          idx,
          tmpColor.copy(alert ? colorBad : colorOk).multiplyScalar(2.2),
        );
      }
    });
    packets.current.instanceMatrix.needsUpdate = true;
    if (packets.current.instanceColor) packets.current.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {arcs.map((arc) => (
        <primitive key={arc.key} object={arc.line} />
      ))}
      <instancedMesh ref={packets} args={[undefined, undefined, arcs.length * packetsPerArc]}>
        <sphereGeometry args={[1, 8, 8]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

export { STATIONS };
