// Browser port of testbed/trust_anchor.py, computed for real with Web Crypto.
//
// Same frame format, same HMAC-SHA256 seal, same order of checks (MAC first, so a forged frame
// can never burn a genuine nonce, then the anti-replay window), and the same SHA-256 hash chain
// from the same genesis block. Block hashes are byte-for-byte identical to the Python module:
// tests/sim.test.ts and tests/test_testbed.py check the same golden values.

import { ReplayWindow, toHex } from './crypto';

export const GENESIS_PAYLOAD = 'GENESIS_ROOT_ANCHOR_TUNISIA_GS01';
export const ZERO_HASH = '0'.repeat(64);

const encoder = new TextEncoder();

/** The satellite-side frame: the part the MAC covers. */
export interface Frame {
  satellite_id: string;
  sequence: number;
  /** Unix seconds. */
  timestamp: number;
  hw_token: string;
  /** Payload bytes as lowercase hex. */
  payload: string;
}

export type AuthReason = 'AUTHENTIC' | 'MAC_MISMATCH' | 'STALE_OR_REUSED_NONCE';

export interface Block {
  index: number;
  previous_hash: string;
  payload: string | Record<string, string | number>;
  hash: string;
}

/** frame_bytes() in ingester.py. */
export function frameText(f: Frame): string {
  return `${f.satellite_id}|${f.sequence}|${f.timestamp.toFixed(6)}|${f.hw_token}|${f.payload}`;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))));
}

/** seal() in ingester.py: HMAC-SHA256 over the frame text, as hex. */
export async function seal(key: CryptoKey, f: Frame): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(frameText(f)))));
}

/** Python's json.dumps(obj, sort_keys=True) for a flat object of ASCII strings and integers. */
export function pyJsonDumps(obj: Record<string, string | number>): string {
  const value = (v: string | number) => {
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new Error('only integers are encoded like Python');
      return String(v);
    }
    return JSON.stringify(v).replace(
      /[\u007f-￿]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  };
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${value(obj[k])}`).join(', ')}}`;
}

/** _hash_block() in trust_anchor.py. */
export function hashBlock(prev: string, payload: Block['payload']): Promise<string> {
  const body = typeof payload === 'string' ? payload : pyJsonDumps(payload);
  return sha256Hex(`${prev}:${body}`);
}

/** Compares two hex strings in time independent of where they first differ. */
function sameHex(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface AuthResult {
  ok: boolean;
  reason: AuthReason;
  /** The tag the station computes over the received frame with its own key. */
  expectedMac: string;
  frameDigest: string;
}

export interface ChainCheck {
  ok: boolean;
  message: string;
  checked: number;
  ms: number;
}

export class TrustAnchorLedger {
  readonly chain: Block[] = [];
  readonly replay = new ReplayWindow(64);

  private constructor(genesis: Block) {
    this.chain.push(genesis);
  }

  static async create(): Promise<TrustAnchorLedger> {
    return new TrustAnchorLedger({
      index: 0,
      previous_hash: ZERO_HASH,
      payload: GENESIS_PAYLOAD,
      hash: await hashBlock(ZERO_HASH, GENESIS_PAYLOAD),
    });
  }

  get genesisRoot(): string {
    return this.chain[0].hash;
  }

  get height(): number {
    return this.chain.length - 1;
  }

  /** MAC first, so a forged frame can never burn a genuine nonce; then freshness. */
  async authenticate(f: Frame, mac: string, key: CryptoKey): Promise<AuthResult> {
    const [expectedMac, frameDigest] = await Promise.all([seal(key, f), sha256Hex(frameText(f))]);
    if (!sameHex(mac, expectedMac)) {
      return { ok: false, reason: 'MAC_MISMATCH', expectedMac, frameDigest };
    }
    if (!this.replay.accept(f.sequence)) {
      return { ok: false, reason: 'STALE_OR_REUSED_NONCE', expectedMac, frameDigest };
    }
    return { ok: true, reason: 'AUTHENTIC', expectedMac, frameDigest };
  }

  /** append_packet(): records a frame and its verdict in the chain. */
  async append(f: Frame, mac: string, frameDigest: string, verdict: AuthReason): Promise<Block> {
    const prev = this.chain[this.chain.length - 1];
    const payload = {
      sequence: f.sequence,
      satellite_id: f.satellite_id,
      hw_token: f.hw_token,
      sha256_hash: frameDigest,
      mac,
      verdict,
    };
    const block: Block = {
      index: this.chain.length,
      previous_hash: prev.hash,
      payload,
      hash: await hashBlock(prev.hash, payload),
    };
    this.chain.push(block);
    return block;
  }

  /** verify_chain(): re-derives every block hash from `from` (1 = the whole chain). */
  async verifyChain(from = 1): Promise<ChainCheck> {
    const started = performance.now();
    const end = this.chain.length;
    const done = (ok: boolean, message: string, checked: number): ChainCheck => ({
      ok,
      message,
      checked,
      ms: performance.now() - started,
    });
    if (from <= 1 && this.chain[0].hash !== (await hashBlock(ZERO_HASH, GENESIS_PAYLOAD))) {
      return done(false, 'Genesis block altered.', 0);
    }
    for (let i = Math.max(1, from); i < end; i++) {
      const block = this.chain[i];
      if (block.previous_hash !== this.chain[i - 1].hash) {
        return done(false, `Chain broken at index ${i}: previous hash mismatch.`, i - from);
      }
      if (block.hash !== (await hashBlock(block.previous_hash, block.payload))) {
        return done(false, `Tampering detected at index ${i}: hash mismatch.`, i - from);
      }
    }
    return done(
      true,
      'Ledger integrity verified: every block links back to the genesis root.',
      end - Math.max(1, from),
    );
  }
}
