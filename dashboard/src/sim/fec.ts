// The forward error correction the downlink assumes, as in digital_twin/fec.py: the CCSDS
// rate-1/2, K = 7 convolutional code with soft-decision Viterbi decoding, QPSK, one 1115-byte
// transfer frame per packet, the channel SNR taken as Es/N0. Above the decoding threshold a frame
// arrives bit-exact; below it the decoder fails and the frame is lost (the CRC says so). Noise
// never flips a bit the HMAC would see.

/** First-event error weights a_d of the code, d = 10 to 18. */
const DISTANCE_SPECTRUM: [number, number][] = [
  [10, 11],
  [12, 38],
  [14, 193],
  [16, 1331],
  [18, 7275],
];
const FRAME_INFO_BITS = 1115 * 8;

/** Tail probability of the standard normal law, via erfc (Abramowitz & Stegun 7.1.26). */
function qFunction(x: number): number {
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t *
    (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return 0.5 * poly * Math.exp(-z * z);
}

/** Probability the Viterbi decoder fails on a frame at Es/N0 = `esN0Db` dB. */
export function frameErrorRate(esN0Db: number): number {
  const ecN0 = 10 ** (esN0Db / 10) / 2;
  let pEvent = 0;
  for (const [d, a] of DISTANCE_SPECTRUM) pEvent += a * qFunction(Math.sqrt(2 * d * ecN0));
  return Math.min(1, FRAME_INFO_BITS * pEvent);
}

/** A uniform number in [0, 1) fixed for each frame slot, so a frame is lost or not, once. */
export function frameDraw(slot: number): number {
  let h = Math.imul(slot ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
