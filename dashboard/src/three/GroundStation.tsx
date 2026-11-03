import { useCursor } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { parabolaGeometry } from './Satellite';

export type StationTone = 'ok' | 'warn' | 'bad' | 'idle';

export const TONE_COLORS: Record<StationTone, string> = {
  ok: '#4CC9F0',
  warn: '#FBBF24',
  bad: '#F8485E',
  idle: '#7D8EA3',
};

export interface StationHandle {
  group: THREE.Group;
  /** World position of the receive feed (the beam's end point). */
  feedWorld(out: THREE.Vector3): THREE.Vector3;
}

interface Props {
  getState: () => { target: THREE.Vector3 | null; tone: StationTone; ringSpeed: number };
  onSelect?: () => void;
}

const up = new THREE.Vector3(0, 1, 0);
const local = new THREE.Vector3();

export const GroundStation = forwardRef<StationHandle, Props>(function GroundStation(
  { getState, onSelect },
  ref,
) {
  const group = useRef<THREE.Group>(null!);
  const turntable = useRef<THREE.Group>(null!);
  const elevation = useRef<THREE.Group>(null!);
  const feed = useRef<THREE.Mesh>(null!);
  const beacon = useRef<THREE.MeshBasicMaterial>(null!);
  const status = useRef<THREE.MeshBasicMaterial>(null!);
  const rings = useRef<THREE.Mesh[]>([]);
  const az = useRef(0);
  const el = useRef(0.6);
  const phase = useRef(0);
  const [hovered, setHovered] = useState(false);
  useCursor(hovered);

  const mat = useMemo(
    () => ({
      concrete: new THREE.MeshStandardMaterial({
        color: '#39424e',
        roughness: 0.92,
        metalness: 0.05,
      }),
      steel: new THREE.MeshStandardMaterial({ color: '#8b96a3', roughness: 0.4, metalness: 0.8 }),
      dishFront: new THREE.MeshStandardMaterial({
        color: '#e9eef3',
        roughness: 0.38,
        metalness: 0.35,
        side: THREE.DoubleSide,
      }),
      white: new THREE.MeshStandardMaterial({ color: '#dfe5eb', roughness: 0.55, metalness: 0.15 }),
      dark: new THREE.MeshStandardMaterial({ color: '#1b222b', roughness: 0.7, metalness: 0.3 }),
      glass: new THREE.MeshStandardMaterial({ color: '#0f1a26', roughness: 0.15, metalness: 0.9 }),
    }),
    [],
  );
  const dish = useMemo(() => parabolaGeometry(0.95, 0.3, 64), []);
  const fence = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * 1.9, 0.16, Math.sin(a) * 1.9));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, []);

  useImperativeHandle(ref, () => ({
    group: group.current,
    feedWorld: (out) => feed.current.getWorldPosition(out),
  }));

  useFrame(({ clock }, dt) => {
    const st = getState();
    const t = clock.elapsedTime;

    // Slew the pedestal towards the target in azimuth and elevation.
    if (st.target) {
      local.copy(st.target);
      group.current.worldToLocal(local);
      local.y -= 0.95;
      const targetAz = Math.atan2(local.x, local.z);
      const targetEl = Math.atan2(local.y, Math.hypot(local.x, local.z));
      let dAz = targetAz - az.current;
      dAz = Math.atan2(Math.sin(dAz), Math.cos(dAz));
      const k = 1 - Math.exp(-dt * 4);
      az.current += dAz * k;
      el.current += (THREE.MathUtils.clamp(targetEl, 0.05, 1.5) - el.current) * k;
    } else {
      el.current += (1.2 - el.current) * (1 - Math.exp(-dt * 1.5));
    }
    turntable.current.rotation.y = az.current;
    elevation.current.rotation.x = -el.current;

    const color = TONE_COLORS[st.tone];
    status.current.color.set(color);
    beacon.current.opacity = Math.sin(t * 3.2) > 0.3 ? 1 : 0.1;
    const feedMat = feed.current.material as THREE.MeshBasicMaterial;
    feedMat.color.set(color);

    // Three phase-offset transceiver rings; faster when the station is affected.
    phase.current += dt * st.ringSpeed;
    rings.current.forEach((ring, i) => {
      if (!ring) return;
      const p = (phase.current / 2.4 + i / 3) % 1;
      ring.scale.setScalar(0.5 + p * 4.2);
      const m = ring.material as THREE.MeshBasicMaterial;
      m.opacity = (1 - p) * 0.55;
      m.color.set(color);
    });
  });

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect?.();
  };

  return (
    <group
      ref={group}
      onClick={onSelect ? select : undefined}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      {/* Pad and fence */}
      <mesh material={mat.concrete} position={[0, 0.03, 0]}>
        <cylinderGeometry args={[2.0, 2.1, 0.08, 64]} />
      </mesh>
      <lineLoop geometry={fence}>
        <lineBasicMaterial color="#6b7888" transparent opacity={0.7} />
      </lineLoop>
      {Array.from({ length: 24 }, (_, i) => {
        const a = (i / 24) * Math.PI * 2;
        return (
          <mesh
            key={i}
            material={mat.steel}
            position={[Math.cos(a) * 1.9, 0.12, Math.sin(a) * 1.9]}
          >
            <cylinderGeometry args={[0.012, 0.012, 0.2, 5]} />
          </mesh>
        );
      })}

      {/* Pedestal */}
      <mesh material={mat.white} position={[0, 0.4, 0]}>
        <cylinderGeometry args={[0.2, 0.3, 0.72, 24]} />
      </mesh>

      {/* Azimuth turntable → yoke → elevation axis → reflector */}
      <group ref={turntable} position={[0, 0.8, 0]}>
        <mesh material={mat.steel}>
          <cylinderGeometry args={[0.34, 0.34, 0.1, 32]} />
        </mesh>
        {[-0.32, 0.32].map((x) => (
          <mesh key={x} material={mat.white} position={[x, 0.18, 0]}>
            <boxGeometry args={[0.07, 0.36, 0.22]} />
          </mesh>
        ))}
        <group ref={elevation} position={[0, 0.15, 0]}>
          <mesh material={mat.steel} rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[0.05, 0.05, 0.72, 12]} />
          </mesh>
          <mesh material={mat.white} position={[0, 0, -0.08]}>
            <boxGeometry args={[0.4, 0.4, 0.18]} />
          </mesh>
          <group position={[0, 0, 0.02]}>
            <mesh geometry={dish} material={mat.dishFront} />
            {/* Back structure ribs */}
            {Array.from({ length: 8 }, (_, i) => (
              <mesh
                key={i}
                material={mat.steel}
                position={[
                  Math.cos((i / 8) * Math.PI * 2) * 0.45,
                  Math.sin((i / 8) * Math.PI * 2) * 0.45,
                  0.02,
                ]}
                rotation={[0, 0, (i / 8) * Math.PI * 2]}
              >
                <boxGeometry args={[0.9, 0.02, 0.03]} />
              </mesh>
            ))}
            {/* Subreflector on four struts */}
            {Array.from({ length: 4 }, (_, i) => {
              const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
              const r = 0.62;
              const start = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0.17);
              const end = new THREE.Vector3(0, 0, 0.78);
              const mid = start.clone().add(end).multiplyScalar(0.5);
              const dir = end.clone().sub(start);
              const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
              return (
                <mesh key={i} material={mat.steel} position={mid} quaternion={q}>
                  <cylinderGeometry args={[0.012, 0.012, dir.length(), 6]} />
                </mesh>
              );
            })}
            <mesh material={mat.white} position={[0, 0, 0.8]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.12, 0.09, 0.04, 24]} />
            </mesh>
            <mesh material={mat.dark} position={[0, 0, 0.16]} rotation={[-Math.PI / 2, 0, 0]}>
              <coneGeometry args={[0.07, 0.22, 16]} />
            </mesh>
            <mesh ref={feed} position={[0, 0, 0.3]}>
              <sphereGeometry args={[0.04, 12, 12]} />
              <meshBasicMaterial color="#4CC9F0" toneMapped={false} />
            </mesh>
          </group>
        </group>
      </group>

      {/* Equipment shelter with status strip */}
      <group position={[1.15, 0, -0.55]} rotation={[0, -0.4, 0]}>
        <mesh material={mat.white} position={[0, 0.3, 0]}>
          <boxGeometry args={[0.8, 0.46, 0.5]} />
        </mesh>
        <mesh material={mat.dark} position={[0.18, 0.24, 0.252]}>
          <boxGeometry args={[0.16, 0.3, 0.01]} />
        </mesh>
        <mesh material={mat.glass} position={[-0.18, 0.34, 0.252]}>
          <boxGeometry args={[0.22, 0.12, 0.01]} />
        </mesh>
        <mesh position={[0, 0.5, 0.252]}>
          <boxGeometry args={[0.6, 0.025, 0.01]} />
          <meshBasicMaterial ref={status} color="#4CC9F0" toneMapped={false} />
        </mesh>
        <mesh material={mat.steel} position={[-0.3, 0.58, 0]}>
          <boxGeometry args={[0.14, 0.1, 0.18]} />
        </mesh>
      </group>

      {/* Radome on a short tower */}
      <group position={[-1.05, 0, 0.55]}>
        <mesh material={mat.steel} position={[0, 0.2, 0]}>
          <cylinderGeometry args={[0.06, 0.08, 0.4, 10]} />
        </mesh>
        <mesh material={mat.white} position={[0, 0.5, 0]}>
          <sphereGeometry args={[0.24, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
        </mesh>
      </group>

      {/* Lattice mast with obstruction beacon */}
      <group position={[-1.2, 0, -0.8]}>
        {[0, 1, 2].map((k) => {
          const a = (k / 3) * Math.PI * 2;
          return (
            <mesh
              key={k}
              material={mat.steel}
              position={[Math.cos(a) * 0.05, 0.8, Math.sin(a) * 0.05]}
            >
              <cylinderGeometry args={[0.008, 0.012, 1.6, 4]} />
            </mesh>
          );
        })}
        <mesh position={[0, 1.63, 0]}>
          <sphereGeometry args={[0.035, 10, 10]} />
          <meshBasicMaterial ref={beacon} color="#ff3b4e" transparent toneMapped={false} />
        </mesh>
      </group>

      {/* Pulsing transceiver rings on the ground */}
      {[0, 1, 2].map((i) => (
        <mesh
          key={i}
          ref={(el) => {
            if (el) rings.current[i] = el;
          }}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.02, 0]}
        >
          <ringGeometry args={[0.96, 1, 96]} />
          <meshBasicMaterial
            transparent
            depthWrite={false}
            toneMapped={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}

      {/* Click volume */}
      {onSelect && (
        <mesh position={[0, 0.9, 0]}>
          <cylinderGeometry args={[2.1, 2.1, 1.9, 16]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      )}
    </group>
  );
});
