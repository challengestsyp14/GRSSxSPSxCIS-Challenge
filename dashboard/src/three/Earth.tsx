import { useFrame } from '@react-three/fiber';
import { useMemo } from 'react';
import * as THREE from 'three';

import landDots from '../data/land-dots.json';
import { EARTH_CENTER, EARTH_R, directionFor } from './geo';
import { NOISE_GLSL } from './glsl';

export const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();

const oceanVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Ocean: dark water with a slow swell pattern, a Fresnel rim, and the sun's glint as a tight
// specular core inside a broad sheen, like sunlight on open sea seen from orbit.
const oceanFragment = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vNormal;
  varying vec3 vView;
  ${NOISE_GLSL}
  void main() {
    vec3 n = normalize(vNormal);
    float swell = fbm(n * 38.0) - 0.5;
    vec3 nw = normalize(n + 0.035 * vec3(swell, fbm(n * 38.0 + 5.0) - 0.5, -swell));
    float day = smoothstep(-0.25, 0.35, dot(n, uSun));
    vec3 deep = vec3(0.010, 0.024, 0.044);
    vec3 lit = vec3(0.028, 0.068, 0.115);
    vec3 col = mix(deep * 0.55, mix(deep, lit, 0.6), day) * (0.92 + 0.16 * swell);
    float fres = pow(clamp(1.0 - dot(n, vView), 0.0, 1.0), 3.0);
    col += vec3(0.30, 0.79, 0.94) * fres * 0.22;
    vec3 h = normalize(uSun + vView);
    float ndh = max(dot(nw, h), 0.0);
    float glint = pow(ndh, 320.0) * 0.55 + pow(ndh, 28.0) * 0.035;
    col += vec3(1.0, 0.88, 0.70) * glint * day * (0.6 + 0.6 * fres);
    gl_FragColor = vec4(col, 1.0);
  }
`;

const dotVertex = /* glsl */ `
  uniform float uSize;
  uniform vec3 uSun;
  attribute float aRand;
  varying float vLight;
  varying float vFacing;
  varying float vRand;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(world.xyz - vec3(0.0, ${(-EARTH_R).toFixed(1)}, 0.0));
    vLight = smoothstep(-0.2, 0.35, dot(n, uSun));
    vRand = aRand;
    vFacing = clamp(dot(n, normalize(cameraPosition - world.xyz)), 0.0, 1.0);
    vec4 mv = viewMatrix * world;
    gl_PointSize = uSize * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

// Land dots: cool on the day side; on the night side about one in five glows sodium-warm, as
// city lights do.
const dotFragment = /* glsl */ `
  varying float vLight;
  varying float vFacing;
  varying float vRand;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.18, d);
    vec3 day = vec3(0.60, 0.74, 0.88);
    vec3 night = vec3(0.30, 0.79, 0.94) * 0.32;
    vec3 col = mix(night, day, vLight);
    float alpha = (0.22 + 0.40 * vLight) * (0.35 + 0.65 * vFacing);
    float city = step(0.8, vRand) * (1.0 - vLight);
    col = mix(col, vec3(1.0, 0.70, 0.36) * (1.2 + 0.8 * fract(vRand * 37.0)), city);
    alpha = mix(alpha, 0.9 * (0.35 + 0.65 * vFacing), city);
    gl_FragColor = vec4(col, a * alpha);
  }
`;

// Clouds: a thin drifting fBm layer, grey-blue on the day side and almost black at night, so it
// breaks up the land pattern without brightening the globe.
const cloudFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  ${NOISE_GLSL}
  void main() {
    vec3 n = normalize(vNormal);
    vec3 p = n * 4.2 + vec3(uTime * 0.012, 0.0, uTime * 0.006);
    float f = fbm(p + 0.6 * vec3(fbm(p * 1.7), fbm(p * 1.7 + 3.1), 0.0));
    float cover = smoothstep(0.52, 0.78, f);
    float day = smoothstep(-0.15, 0.4, dot(n, uSun));
    float edge = clamp(dot(n, vView), 0.0, 1.0);
    vec3 col = mix(vec3(0.03, 0.05, 0.08), vec3(0.50, 0.58, 0.68), day);
    gl_FragColor = vec4(col, cover * (0.10 + 0.32 * day) * smoothstep(0.0, 0.35, edge));
  }
`;

// Atmosphere in three layers. Each approximates single scattering along the view ray: optical
// depth grows towards the limb, Rayleigh scattering lights the day side blue and the terminator
// orange, and a Henyey-Greenstein Mie lobe adds the forward-scattered haze around the sun.

/** Layer 1: Rayleigh scattering inside the shell, drawn over the surface. */
const rayleighFragment = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float mu = clamp(dot(vNormal, vView), 0.0, 1.0);
    float depth = pow(1.0 - mu, 2.2);
    float sun = dot(vNormal, uSun);
    float day = smoothstep(-0.18, 0.35, sun);
    float terminator = exp(-pow((sun + 0.02) / 0.16, 2.0));
    float cosT = dot(vView, uSun);
    float phase = 0.75 * (1.0 + cosT * cosT);
    vec3 sky = vec3(0.16, 0.40, 0.78) * phase * day;
    vec3 dusk = vec3(1.0, 0.45, 0.18) * terminator * 0.9;
    gl_FragColor = vec4((sky + dusk) * depth, depth * (0.14 + 0.38 * day + 0.3 * terminator));
  }
`;

/** Layer 2: limb glow seen past the planet's edge, bright on the day side. */
const limbFragment = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(clamp(1.0 - abs(dot(vNormal, vView)), 0.0, 1.0), 2.4);
    float lit = smoothstep(-0.35, 0.4, dot(vNormal, uSun));
    vec3 col = mix(vec3(0.10, 0.22, 0.45), vec3(0.30, 0.79, 0.94), lit);
    gl_FragColor = vec4(col, rim * 0.46 * (0.3 + 0.7 * lit));
  }
`;

/** Layer 3: outer Mie haze, strongest when looking towards the sun through the limb. */
const mieFragment = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float rim = pow(clamp(1.0 - abs(dot(vNormal, vView)), 0.0, 1.0), 4.0);
    float g = 0.76;
    float cosT = dot(-vView, uSun);
    float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * cosT, 1.5);
    float lit = smoothstep(-0.2, 0.5, dot(vNormal, uSun));
    gl_FragColor = vec4(vec3(0.95, 0.9, 0.82), rim * lit * min(0.36, 0.04 + 0.045 * hg));
  }
`;

const fract = (x: number) => x - Math.floor(x);

export function Earth() {
  const dots = useMemo(() => {
    const data = landDots as number[];
    const positions = new Float32Array((data.length / 2) * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < data.length; i += 2) {
      directionFor(data[i] / 10, data[i + 1] / 10, v)
        .multiplyScalar(EARTH_R * 1.002)
        .add(EARTH_CENTER);
      positions.set([v.x, v.y, v.z], (i / 2) * 3);
    }
    const rand = new Float32Array(data.length / 2);
    for (let i = 0; i < rand.length; i++) rand[i] = fract(Math.sin(i * 12.9898) * 43758.5453);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    g.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
    return g;
  }, []);

  const uniforms = useMemo(
    () => ({ uSun: { value: SUN_DIR }, uSize: { value: 0.16 }, uTime: { value: 0 } }),
    [],
  );
  useFrame((_, dt) => {
    uniforms.uTime.value += Math.min(dt, 0.1);
  });

  const graticule = useMemo(() => {
    const pts: number[] = [];
    const v = new THREE.Vector3();
    const push = (lat: number, lon: number) => {
      directionFor(lat, lon, v)
        .multiplyScalar(EARTH_R * 1.001)
        .add(EARTH_CENTER);
      pts.push(v.x, v.y, v.z);
    };
    for (let lat = -75; lat <= 75; lat += 15) {
      for (let lon = -180; lon < 180; lon += 3) {
        push(lat, lon);
        push(lat, lon + 3);
      }
    }
    for (let lon = -180; lon < 180; lon += 15) {
      for (let lat = -84; lat < 84; lat += 3) {
        push(lat, lon);
        push(lat + 3, lon);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    return g;
  }, []);

  return (
    <group>
      <mesh position={EARTH_CENTER} renderOrder={0}>
        <sphereGeometry args={[EARTH_R, 128, 128]} />
        <shaderMaterial
          vertexShader={oceanVertex}
          fragmentShader={oceanFragment}
          uniforms={uniforms}
        />
      </mesh>
      <lineSegments geometry={graticule}>
        <lineBasicMaterial color="#4CC9F0" transparent opacity={0.06} depthWrite={false} />
      </lineSegments>
      <points geometry={dots} renderOrder={1}>
        <shaderMaterial
          vertexShader={dotVertex}
          fragmentShader={dotFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
        />
      </points>
      <mesh position={EARTH_CENTER} renderOrder={1.5}>
        <sphereGeometry args={[EARTH_R * 1.006, 128, 128]} />
        <shaderMaterial
          vertexShader={oceanVertex}
          fragmentShader={cloudFragment}
          uniforms={uniforms}
          transparent
          depthWrite={false}
        />
      </mesh>
      <mesh position={EARTH_CENTER} renderOrder={2}>
        <sphereGeometry args={[EARTH_R * 1.012, 96, 96]} />
        <shaderMaterial
          vertexShader={oceanVertex}
          fragmentShader={rayleighFragment}
          uniforms={uniforms}
          transparent
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh position={EARTH_CENTER} renderOrder={2}>
        <sphereGeometry args={[EARTH_R * 1.045, 96, 96]} />
        <shaderMaterial
          vertexShader={oceanVertex}
          fragmentShader={limbFragment}
          uniforms={uniforms}
          transparent
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      <mesh position={EARTH_CENTER} renderOrder={2}>
        <sphereGeometry args={[EARTH_R * 1.09, 64, 64]} />
        <shaderMaterial
          vertexShader={oceanVertex}
          fragmentShader={mieFragment}
          uniforms={uniforms}
          transparent
          side={THREE.BackSide}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
    </group>
  );
}
