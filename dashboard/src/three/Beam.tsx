import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';

const vertex = /* glsl */ `
  uniform float uTime;
  uniform float uWave;
  uniform float uWaveFreq;
  uniform float uStatic;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  float vhash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    vUv = uv;
    // Distortion across the beam, tapered to zero at both ends so it stays attached.
    float along = uv.y;
    float taper = sin(3.14159265 * along);
    float phase = along * uWaveFreq * 6.2831853 - uTime * 18.0;
    vec3 p = position;
    p.x += uWave * taper * sin(phase);
    p.z += uWave * 0.6 * taper * cos(phase * 1.3);
    float jitter = vhash(floor(uTime * 40.0) + floor(along * 90.0)) - 0.5;
    p.x += uStatic * 0.16 * taper * jitter;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uSpeed;
  uniform float uDensity;
  uniform float uDashed;
  uniform float uFlicker;
  uniform float uAlongX;
  uniform float uStatic;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vView;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float along = mix(vUv.y, vUv.x, uAlongX);
    float soft = pow(clamp(abs(dot(normalize(vNormal), normalize(vView))), 0.0, 1.0), 1.4);
    float stripes = fract(along * uDensity - uTime * uSpeed);
    float pulse = pow(stripes, 6.0);
    float dash = mix(1.0, step(0.45, fract(along * uDensity * 0.5 - uTime * uSpeed * 0.5)), uDashed);
    float flick = mix(1.0, 0.35 + 0.65 * step(0.45, hash(floor(uTime * 24.0) + floor(along * 18.0))), uFlicker);
    float ends = smoothstep(0.0, 0.04, along) * smoothstep(1.0, 0.94, along);
    // Broadband static: fine grain that re-rolls every frame, with bright sparks.
    float grain = hash(floor(uTime * 60.0) * 1.7 + floor(along * 240.0) * 7.13 + floor(vUv.x * 14.0));
    float spark = step(0.93, grain) * uStatic;
    float stat = mix(1.0, 0.35 + 0.9 * grain, uStatic);
    float a = (0.16 + 0.9 * pulse + 0.8 * spark) * soft * dash * flick * stat * ends * uOpacity;
    gl_FragColor = vec4(uColor * (1.0 + 1.6 * pulse) + vec3(spark * 0.9), a);
  }
`;

export interface BeamState {
  a: THREE.Vector3;
  b: THREE.Vector3;
  visible: boolean;
  color: THREE.Color;
  opacity: number;
  dashed?: boolean;
  flicker?: number;
  speed?: number;
  packets?: boolean;
  /** Lateral oscillation amplitude (scene units) and cycles along the beam. */
  wave?: number;
  waveFreq?: number;
  /** High-frequency static distortion, 0..1. */
  static?: number;
}

interface Props {
  getState: () => BeamState;
  radiusA?: number;
  radiusB?: number;
  packetCount?: number;
  packetSize?: number;
}

const Y = new THREE.Vector3(0, 1, 0);
const dir = new THREE.Vector3();
const mid = new THREE.Vector3();
const tmp = new THREE.Vector3();
const dummy = new THREE.Object3D();
const axisX = new THREE.Vector3();
const axisZ = new THREE.Vector3();

/** Straight beam between two moving points, with packets travelling from a to b. */
export function Beam({
  getState,
  radiusA = 0.05,
  radiusB = 0.5,
  packetCount = 4,
  packetSize = 0.09,
}: Props) {
  const mesh = useRef<THREE.Mesh>(null!);
  const packets = useRef<THREE.InstancedMesh>(null!);
  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color('#4CC9F0') },
      uTime: { value: 0 },
      uOpacity: { value: 1 },
      uSpeed: { value: 1.6 },
      uDensity: { value: 7 },
      uDashed: { value: 0 },
      uFlicker: { value: 0 },
      uAlongX: { value: 0 },
      uWave: { value: 0 },
      uWaveFreq: { value: 6 },
      uStatic: { value: 0 },
    }),
    [],
  );
  const geometry = useMemo(() => {
    // Bottom (y = -0.5) at a, top (y = +0.5) at b; enough rings along it to bend smoothly.
    const g = new THREE.CylinderGeometry(radiusB, radiusA, 1, 32, 160, true);
    return g;
  }, [radiusA, radiusB]);
  const packetMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 2.4, 2.9), toneMapped: false }),
    [],
  );

  useFrame(({ clock }) => {
    const st = getState();
    const m = mesh.current;
    dir.subVectors(st.b, st.a);
    const len = dir.length();
    m.visible = st.visible && st.opacity > 0.01 && len > 1e-4;
    packets.current.visible = m.visible && st.packets !== false;
    if (!m.visible) return;

    mid.addVectors(st.a, st.b).multiplyScalar(0.5);
    m.position.copy(mid);
    m.quaternion.setFromUnitVectors(Y, tmp.copy(dir).normalize());
    m.scale.set(1, len, 1);

    const t = clock.elapsedTime;
    uniforms.uTime.value = t;
    uniforms.uColor.value.copy(st.color);
    uniforms.uOpacity.value = st.opacity;
    uniforms.uDashed.value = st.dashed ? 1 : 0;
    uniforms.uFlicker.value = st.flicker ?? 0;
    uniforms.uSpeed.value = st.speed ?? 1.6;
    uniforms.uDensity.value = Math.max(3, len * 0.7);
    uniforms.uWave.value = st.wave ?? 0;
    uniforms.uWaveFreq.value = st.waveFreq ?? 6;
    uniforms.uStatic.value = st.static ?? 0;
    axisX.set(1, 0, 0).applyQuaternion(m.quaternion);
    axisZ.set(0, 0, 1).applyQuaternion(m.quaternion);

    packetMaterial.color.copy(st.color).multiplyScalar(2.6);
    const speed = (st.speed ?? 1.6) * 0.32;
    for (let i = 0; i < packetCount; i++) {
      const p = (t * speed + i / packetCount) % 1;
      dummy.position.copy(st.a).lerp(st.b, p);
      // Packets ride the same distortion as the beam.
      const taper = Math.sin(Math.PI * p);
      const phase = p * (st.waveFreq ?? 6) * Math.PI * 2 - t * 18;
      const wave = st.wave ?? 0;
      dummy.position
        .addScaledVector(axisX, wave * taper * Math.sin(phase))
        .addScaledVector(axisZ, wave * 0.6 * taper * Math.cos(phase * 1.3));
      dummy.scale.setScalar(packetSize * (0.6 + 0.4 * Math.sin(p * Math.PI)));
      dummy.updateMatrix();
      packets.current.setMatrixAt(i, dummy.matrix);
    }
    packets.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      <mesh ref={mesh} geometry={geometry} renderOrder={5}>
        <shaderMaterial
          vertexShader={vertex}
          fragmentShader={fragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
      <instancedMesh ref={packets} args={[undefined, packetMaterial, packetCount]} renderOrder={6}>
        <sphereGeometry args={[1, 12, 12]} />
      </instancedMesh>
    </>
  );
}
