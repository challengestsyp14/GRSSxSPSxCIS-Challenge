// Isolation Forest (Liu, Ting & Zhou, 2008), trained in the browser on nominal passes only.

import { mulberry32 } from './noise';

type Node =
  | { leaf: true; size: number }
  | { leaf: false; feature: number; split: number; left: Node; right: Node };

const EULER = 0.5772156649;

/** Average path length of an unsuccessful BST search over n points. */
export function cFactor(n: number): number {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER) - (2 * (n - 1)) / n;
}

export interface IsolationForestOptions {
  nEstimators?: number;
  sampleSize?: number;
  seed?: number;
}

export class IsolationForest {
  private trees: Node[] = [];
  private psi = 0;
  readonly nEstimators: number;
  private readonly sampleSize: number;
  private readonly rand: () => number;

  constructor({ nEstimators = 256, sampleSize = 256, seed = 7 }: IsolationForestOptions = {}) {
    this.nEstimators = nEstimators;
    this.sampleSize = sampleSize;
    this.rand = mulberry32(seed);
  }

  fit(data: number[][]): this {
    if (data.length < 2) throw new Error('need at least two training vectors');
    this.psi = Math.min(this.sampleSize, data.length);
    const limit = Math.ceil(Math.log2(this.psi));
    this.trees = [];
    for (let t = 0; t < this.nEstimators; t++) {
      const sample: number[][] = [];
      for (let i = 0; i < this.psi; i++) sample.push(data[Math.floor(this.rand() * data.length)]);
      this.trees.push(this.build(sample, 0, limit));
    }
    return this;
  }

  private build(rows: number[][], depth: number, limit: number): Node {
    if (depth >= limit || rows.length <= 1) return { leaf: true, size: rows.length };

    const dims = rows[0].length;
    const candidates: { f: number; lo: number; hi: number }[] = [];
    for (let f = 0; f < dims; f++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const r of rows) {
        if (r[f] < lo) lo = r[f];
        if (r[f] > hi) hi = r[f];
      }
      if (hi > lo) candidates.push({ f, lo, hi });
    }
    if (candidates.length === 0) return { leaf: true, size: rows.length };

    const { f, lo, hi } = candidates[Math.floor(this.rand() * candidates.length)];
    const split = lo + this.rand() * (hi - lo);
    const left = rows.filter((r) => r[f] < split);
    const right = rows.filter((r) => r[f] >= split);
    return {
      leaf: false,
      feature: f,
      split,
      left: this.build(left, depth + 1, limit),
      right: this.build(right, depth + 1, limit),
    };
  }

  private pathLength(x: number[], node: Node, depth: number): number {
    let n = node;
    let d = depth;
    while (!n.leaf) {
      n = x[n.feature] < n.split ? n.left : n.right;
      d++;
    }
    return d + cFactor(n.size);
  }

  /** Anomaly score in (0, 1): ~0.5 or below is normal, towards 1 is anomalous. */
  score(x: number[]): number {
    if (this.trees.length === 0) throw new Error('fit the forest before scoring');
    let total = 0;
    for (const tree of this.trees) total += this.pathLength(x, tree, 0);
    return 2 ** (-(total / this.trees.length) / cFactor(this.psi));
  }
}

export function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
