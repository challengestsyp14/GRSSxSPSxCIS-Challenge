// The explainer as still slides, rendered by `node explainer/render.mjs --slides` from the
// moments listed in explainer/slides.json: no voice over, no captions, no transcript.

import list from '../../explainer/slides.json';

export const SLIDES = list.map((s, i) => ({
  src: `/media/slides/slide-${String(i + 1).padStart(2, '0')}.jpg`,
  alt: s.alt,
}));
