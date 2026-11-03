import { useMemo } from 'react';
import * as THREE from 'three';

import { SUN_DIR } from './Earth';
import { NOISE_GLSL } from './glsl';

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vDir = normalize(world.xyz - cameraPosition);
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_Position.z = gl_Position.w; // always on the far plane
  }
`;

// The Milky Way as a dusty band along a tilted great circle, faint nebula tints, and the sun:
// a hot disc, a tight corona and a wide glare that the bloom pass spreads further.
const skyFragment = /* glsl */ `
  uniform vec3 uSun;
  varying vec3 vDir;
  ${NOISE_GLSL}
  void main() {
    vec3 d = normalize(vDir);
    vec3 galaxy = normalize(vec3(0.32, 0.86, -0.40));
    float lat = dot(d, galaxy);
    float band = exp(-pow(lat / 0.20, 2.0));
    float core = exp(-pow(lat / 0.07, 2.0));
    float cloud = fbm(d * 3.2);
    float dust = smoothstep(0.42, 0.72, fbm(d * 7.5 + 3.0));
    float milky = band * (0.35 + 0.9 * cloud) * (1.0 - 0.75 * dust * core) + core * 0.35 * cloud;
    vec3 col = vec3(0.13, 0.15, 0.24) * milky * 0.085;
    col += vec3(0.28, 0.24, 0.30) * core * cloud * 0.03;

    float neb = fbm(d * 1.6 + 7.0);
    col += vec3(0.20, 0.06, 0.28) * smoothstep(0.55, 0.85, neb) * 0.035;
    col += vec3(0.02, 0.16, 0.22) * smoothstep(0.58, 0.9, fbm(d * 2.1 - 4.0)) * 0.03;

    float mu = max(dot(d, uSun), 0.0);
    col += vec3(1.0, 0.96, 0.88) * smoothstep(0.99955, 0.99985, mu) * 9.0;
    col += vec3(1.0, 0.86, 0.62) * pow(mu, 900.0) * 1.6;
    col += vec3(0.95, 0.78, 0.55) * pow(mu, 60.0) * 0.05;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Deep-space backdrop behind the star field. */
export function Sky() {
  const uniforms = useMemo(() => ({ uSun: { value: SUN_DIR } }), []);
  return (
    <mesh renderOrder={-10} frustumCulled={false}>
      <sphereGeometry args={[500, 64, 32]} />
      <shaderMaterial
        vertexShader={skyVertex}
        fragmentShader={skyFragment}
        uniforms={uniforms}
        side={THREE.BackSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
