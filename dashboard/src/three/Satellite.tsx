import { useCursor } from '@react-three/drei';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

import { EARTH_CENTER } from './geo';
import { foilBumpTexture, foilColorTexture, sarAntennaTexture, solarCellTexture } from './textures';

/** Parabolic reflector with its boresight along +Z. */
export function parabolaGeometry(
  radius: number,
  depth: number,
  segments = 48,
): THREE.LatheGeometry {
  const pts: THREE.Vector2[] = [];
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const r = (i / steps) * radius;
    pts.push(new THREE.Vector2(r, (depth * r * r) / (radius * radius)));
  }
  const g = new THREE.LatheGeometry(pts, segments);
  g.rotateX(Math.PI / 2);
  return g;
}

export interface SatelliteHandle {
  group: THREE.Group;
  /** World position of the downlink antenna feed. */
  feedWorld(out: THREE.Vector3): THREE.Vector3;
}

interface Props {
  /** Where the satellite is and what its dish should point at, read every frame. */
  getState: () => {
    position: THREE.Vector3;
    target: THREE.Vector3 | null;
    visible: number;
    transmitting: boolean;
  };
  onSelect?: () => void;
  hoverable?: boolean;
  /** TerraSAR-X and TanDEM-X to scale, or a generic Earth-observation satellite. */
  variant?: 'tsx' | 'generic';
}

export const SAT_SCALE = 0.86;

// TerraSAR-X, to scale: a hexagonal body 5 m long and 2.4 m across, flown with its long axis
// along the velocity. Solar cells cover the upper facets, the 4.8 m phased-array radar
// antenna runs along a lower side facet, and the X-band downlink antenna sits at the end of a
// 3.3 m boom under the body, clear of the radar.
const R = 0.7; // circumradius of the hexagon
const A = R * Math.cos(Math.PI / 6); // apothem: centre to the middle of a facet
const SIDE = R; // facet width
const LENGTH = 2.9;
const BOOM = 1.9;

// Generic Earth-observation satellite: a box bus in gold insulation, two deployed solar wings
// along the orbit normal, a nadir-pointing instrument, and the same X-band antenna on its boom.
const BUS = { w: 1.1, h: 0.95, l: 1.5 } as const;
const WING = 2.2;

/** Facet normals, degrees from +X towards +Y: bottom, lower right, upper right, top, ... */
const FACET = { bottom: -90, lowerRight: -30, upperRight: 30, top: 90, upperLeft: 150 } as const;

/** Pose of a plate lying on a facet, `lift` above its surface, with local +Y outwards. */
function onFacet(deg: number, lift: number) {
  const a = (deg * Math.PI) / 180;
  return {
    position: [(A + lift) * Math.cos(a), (A + lift) * Math.sin(a), 0] as const,
    rotation: [0, 0, a - Math.PI / 2] as const,
  };
}

const tmpZ = new THREE.Vector3();
const tmpY = new THREE.Vector3();
const tmpX = new THREE.Vector3();
const basis = new THREE.Matrix4();
const localTarget = new THREE.Vector3();

export const Satellite = forwardRef<SatelliteHandle, Props>(function Satellite(
  { getState, onSelect, hoverable = true, variant = 'tsx' },
  ref,
) {
  const tsx = variant === 'tsx';
  const bottom = tsx ? A : BUS.h / 2;
  const side = tsx ? R : BUS.w / 2;
  const group = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const antenna = useRef<THREE.Group>(null!);
  const feed = useRef<THREE.Mesh>(null!);
  const navL = useRef<THREE.MeshBasicMaterial>(null!);
  const navR = useRef<THREE.MeshBasicMaterial>(null!);
  const prev = useRef(new THREE.Vector3());
  const [hovered, setHovered] = useState(false);
  useCursor(hovered && hoverable);

  const mat = useMemo(() => {
    // One cell texture per facet length: the square 8 x 8 cell sheet repeats along the body.
    const solar = solarCellTexture().clone();
    solar.wrapS = solar.wrapT = THREE.RepeatWrapping;
    solar.repeat.set(1, 4);
    solar.needsUpdate = true;
    const foil = foilBumpTexture();
    const wing = solarCellTexture().clone();
    wing.wrapS = wing.wrapT = THREE.RepeatWrapping;
    wing.repeat.set(3, 1);
    wing.needsUpdate = true;
    return {
      // Silver-white multi-layer insulation over the body.
      mli: new THREE.MeshStandardMaterial({
        color: '#dfe4ea',
        metalness: 0.62,
        roughness: 0.32,
        bumpMap: foil,
        bumpScale: 0.7,
        envMapIntensity: 1.5,
      }),
      // Gold multi-layer insulation on the end bulkheads.
      gold: new THREE.MeshStandardMaterial({
        map: foilColorTexture(),
        metalness: 0.5,
        roughness: 0.34,
        bumpMap: foil,
        bumpScale: 0.9,
        envMapIntensity: 1.8,
        emissive: '#5a3a0c',
        emissiveIntensity: 0.55,
      }),
      silver: new THREE.MeshStandardMaterial({ color: '#c8d0da', metalness: 0.85, roughness: 0.3 }),
      dark: new THREE.MeshStandardMaterial({ color: '#15191f', metalness: 0.4, roughness: 0.6 }),
      // Cells under cover glass: a clear coat for the sharp sun reflection and a thin-film
      // sheen that shifts blue to violet with the viewing angle.
      panel: new THREE.MeshPhysicalMaterial({
        map: solar,
        metalness: 0.15,
        roughness: 0.5,
        clearcoat: 0.55,
        clearcoatRoughness: 0.22,
        iridescence: 0.5,
        iridescenceIOR: 1.5,
        iridescenceThicknessRange: [180, 420],
        envMapIntensity: 0.35,
        emissive: '#06213f',
        emissiveIntensity: 0.2,
      }),
      wing: new THREE.MeshPhysicalMaterial({
        map: wing,
        metalness: 0.15,
        roughness: 0.5,
        clearcoat: 0.55,
        clearcoatRoughness: 0.22,
        iridescence: 0.5,
        iridescenceIOR: 1.5,
        iridescenceThicknessRange: [180, 420],
        envMapIntensity: 0.35,
        emissive: '#06213f',
        emissiveIntensity: 0.2,
        side: THREE.DoubleSide,
      }),
      radar: new THREE.MeshStandardMaterial({
        map: sarAntennaTexture(),
        metalness: 0.25,
        roughness: 0.55,
        envMapIntensity: 0.8,
      }),
      white: new THREE.MeshStandardMaterial({ color: '#eef2f6', metalness: 0.2, roughness: 0.5 }),
    };
  }, []);

  const dish = useMemo(() => parabolaGeometry(0.24, 0.09), []);

  useImperativeHandle(ref, () => ({
    group: group.current,
    feedWorld: (out) => feed.current.getWorldPosition(out),
  }));

  useFrame(({ clock }, dt) => {
    const st = getState();
    const g = group.current;
    g.visible = st.visible > 0.01;
    if (!g.visible) {
      prev.current.copy(st.position);
      return;
    }
    g.position.copy(st.position);
    g.scale.setScalar(SAT_SCALE * (0.25 + 0.75 * st.visible));

    // Nadir-pointing attitude: -Y to Earth's centre, +Z (the long axis) along the velocity.
    tmpY.copy(st.position).sub(EARTH_CENTER).normalize();
    tmpZ.copy(st.position).sub(prev.current);
    if (tmpZ.lengthSq() < 1e-8 || dt === 0) tmpZ.set(0, 0, 1);
    tmpZ.addScaledVector(tmpY, -tmpZ.dot(tmpY));
    // A jump along the radius (pass wrap) leaves no heading: keep the last attitude.
    if (tmpZ.lengthSq() > 1e-10) {
      tmpZ.normalize();
      tmpX.crossVectors(tmpY, tmpZ).normalize();
      basis.makeBasis(tmpX, tmpY, tmpZ);
      g.quaternion.setFromRotationMatrix(basis);
    }
    prev.current.copy(st.position);

    // Antenna pointing mechanism steers the downlink antenna at the serving station.
    if (st.target) {
      localTarget.copy(st.target);
      antenna.current.parent!.worldToLocal(localTarget);
      localTarget.sub(antenna.current.position);
    }
    if (st.target && localTarget.lengthSq() > 1e-10) {
      antenna.current.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1),
        localTarget.normalize(),
      );
    }

    const t = clock.elapsedTime;
    if (navL.current) navL.current.opacity = Math.sin(t * 5) > 0.6 ? 1 : 0.08;
    if (navR.current) navR.current.opacity = Math.sin(t * 5 + 2) > 0.6 ? 1 : 0.08;
    const feedMat = feed.current.material as THREE.MeshBasicMaterial;
    feedMat.color.set(st.transmitting ? '#4CC9F0' : '#2a3544');
    feedMat.opacity = st.transmitting ? 0.65 + 0.35 * Math.sin(t * 19.6) : 0.4;
    body.current.scale.setScalar(hovered && hoverable ? 1.06 : 1);
  });

  const select = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    onSelect?.();
  };

  const radar = onFacet(FACET.lowerRight, 0.035);
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
      <group ref={body}>
        {!tsx && (
          <>
            {/* Box bus in gold multi-layer insulation */}
            <mesh material={mat.gold} castShadow>
              <boxGeometry args={[BUS.w, BUS.h, BUS.l]} />
            </mesh>
            {/* Deployed solar wings on their yokes */}
            {[-1, 1].map((s) => (
              <group key={s} position={[(s * BUS.w) / 2, 0.12, 0]}>
                <mesh
                  material={mat.silver}
                  position={[s * 0.22, 0, 0]}
                  rotation={[0, 0, Math.PI / 2]}
                >
                  <cylinderGeometry args={[0.022, 0.022, 0.44, 8]} />
                </mesh>
                <mesh material={mat.wing} position={[s * (0.44 + WING / 2), 0, 0]}>
                  <boxGeometry args={[WING, 0.02, 0.86]} />
                </mesh>
              </group>
            ))}
            {/* Nadir-pointing instrument */}
            <mesh material={mat.dark} position={[0, -BUS.h / 2 - 0.1, BUS.l / 2 - 0.35]}>
              <cylinderGeometry args={[0.17, 0.2, 0.2, 20]} />
            </mesh>
            <mesh material={mat.silver} position={[0.3, BUS.h / 2 + 0.06, -0.4]}>
              <cylinderGeometry args={[0.07, 0.07, 0.12, 16]} />
            </mesh>
          </>
        )}
        {tsx && (
          <>
            {/* Hexagonal body in silver multi-layer insulation, gold end bulkheads */}
            <mesh material={mat.mli} rotation={[Math.PI / 2, 0, 0]} castShadow>
              <cylinderGeometry args={[R, R, LENGTH, 6, 1, false, Math.PI / 6]} />
            </mesh>
            {[-1, 1].map((end) => (
              <mesh
                key={end}
                material={mat.gold}
                position={[0, 0, end * (LENGTH / 2 + 0.025)]}
                rotation={[Math.PI / 2, 0, 0]}
              >
                <cylinderGeometry args={[R * 0.97, R * 0.97, 0.05, 6, 1, false, Math.PI / 6]} />
              </mesh>
            ))}

            {/* Body-mounted solar array on the upper facets */}
            {[FACET.top, FACET.upperLeft].map((deg) => {
              const pose = onFacet(deg, 0.008);
              return (
                <mesh
                  key={deg}
                  material={mat.panel}
                  position={pose.position}
                  rotation={pose.rotation}
                >
                  <boxGeometry args={[SIDE * 0.9, 0.012, LENGTH * 0.92]} />
                </mesh>
              );
            })}

            {/* 4.8 m phased-array radar antenna along the lower right facet */}
            <group position={radar.position} rotation={radar.rotation}>
              <mesh material={mat.dark}>
                <boxGeometry args={[SIDE * 0.92, 0.06, LENGTH * 0.97]} />
              </mesh>
              <group position={[0, 0.031, 0]} rotation={[0, Math.PI / 2, 0]}>
                <mesh material={mat.radar} rotation={[-Math.PI / 2, 0, 0]}>
                  <planeGeometry args={[LENGTH * 0.95, SIDE * 0.86]} />
                </mesh>
              </group>
            </group>

            {/* Star trackers on the upper right facet, aft */}
            {[-0.95, -0.6].map((z) => {
              const pose = onFacet(FACET.upperRight, 0.08);
              return (
                <group
                  key={z}
                  position={[pose.position[0], pose.position[1], z]}
                  rotation={pose.rotation}
                >
                  <mesh material={mat.silver}>
                    <cylinderGeometry args={[0.07, 0.07, 0.16, 16]} />
                  </mesh>
                  <mesh material={mat.dark} position={[0, 0.11, 0]}>
                    <cylinderGeometry args={[0.1, 0.07, 0.08, 16, 1, true]} />
                  </mesh>
                </group>
              );
            })}

            {/* Cold-gas thrusters on the aft bulkhead */}
            {[
              [-0.3, -0.25],
              [0.3, -0.25],
              [-0.3, 0.25],
              [0.3, 0.25],
            ].map(([x, y]) => (
              <mesh
                key={`${x}${y}`}
                material={mat.dark}
                position={[x, y, -LENGTH / 2 - 0.1]}
                rotation={[-Math.PI / 2, 0, 0]}
              >
                <coneGeometry args={[0.06, 0.12, 12, 1, true]} />
              </mesh>
            ))}
          </>
        )}

        {/* S-band telemetry and command antennas: the telecommand uplink lands here */}
        <mesh material={mat.white} position={[0, bottom + 0.25, (tsx ? LENGTH : BUS.l) / 2 - 0.2]}>
          <cylinderGeometry args={[0.012, 0.012, 0.5, 6]} />
        </mesh>
        <mesh
          material={mat.white}
          position={[0.25, -bottom - 0.25, (tsx ? LENGTH : BUS.l) / 2 - 0.3]}
        >
          <cylinderGeometry args={[0.012, 0.012, 0.5, 6]} />
        </mesh>

        {/* X-band downlink antenna at the end of its boom, on a pointing mechanism */}
        <group position={[0, -bottom, tsx ? -0.75 : -0.35]}>
          <mesh material={mat.silver} position={[0, -BOOM / 2, 0]}>
            <cylinderGeometry args={[0.026, 0.026, BOOM, 10]} />
          </mesh>
          <mesh material={mat.silver} position={[0, -BOOM - 0.06, 0]}>
            <cylinderGeometry args={[0.04, 0.05, 0.14, 12]} />
          </mesh>
          <group ref={antenna} position={[0, -BOOM - 0.17, 0]}>
            <mesh geometry={dish} material={mat.white} />
            {[0, 1, 2].map((k) => {
              const a = (k / 3) * Math.PI * 2;
              return (
                <mesh
                  key={k}
                  material={mat.silver}
                  position={[Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0.11]}
                  rotation={[Math.cos(a) * 0.55, -Math.sin(a) * 0.55, 0]}
                >
                  <cylinderGeometry args={[0.006, 0.006, 0.22, 5]} />
                </mesh>
              );
            })}
            <mesh ref={feed} position={[0, 0, 0.2]}>
              <sphereGeometry args={[0.04, 16, 16]} />
              <meshBasicMaterial color="#4CC9F0" transparent toneMapped={false} />
            </mesh>
          </group>
        </group>

        {/* Navigation lights */}
        <mesh position={[side + 0.03, 0, (tsx ? LENGTH : BUS.l) / 2 - 0.1]}>
          <sphereGeometry args={[0.035, 8, 8]} />
          <meshBasicMaterial ref={navL} color="#ff3b4e" transparent toneMapped={false} />
        </mesh>
        <mesh position={[-side - 0.03, 0, (tsx ? LENGTH : BUS.l) / 2 - 0.1]}>
          <sphereGeometry args={[0.035, 8, 8]} />
          <meshBasicMaterial ref={navR} color="#34D399" transparent toneMapped={false} />
        </mesh>
      </group>

      {/* Generous invisible hit volume so the satellite is easy to click */}
      {onSelect && (
        <mesh position={[0, -0.8, 0]}>
          <boxGeometry args={[2.4, 3.6, 3.6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} colorWrite={false} />
        </mesh>
      )}
    </group>
  );
});
