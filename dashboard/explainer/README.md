# "Hiding in the noise" slides

Source of the slides on the `/slides` page (`public/media/slides/slide-01.jpg` to `slide-09.jpg`):
the explainer's scenes drawn on a canvas and captured at the moments listed in `slides.json`. The
site shows them as still slides, with no voice over, captions or transcript.

| File                        | What it is                                                                 |
| --------------------------- | -------------------------------------------------------------------------- |
| `scene.html`                | The scenes: every frame drawn on a canvas as a function of time            |
| `scene.js`                  | The scenes, laid out on the timeline of `src/noise/explainer.json`         |
| `slides.json`               | The moment of each slide and its text alternative                          |
| `render.mjs`                | Headless Chromium: `--slides` writes the slides; `--stills t1,t2` previews |
| `script.json`, `narrate.py` | The scene texts and the tool that wrote the timeline                       |

Figures on the slides come from `src/sim/linkFacts.ts` (pinned by `tests/sim.test.ts`) and the
natural noise is the dashboard's own model in `src/sim/signals.ts`.

## Re-render

```bash
cd dashboard
node explainer/render.mjs --slides
```

`render.mjs` reads `CHROMIUM` and `PLAYWRIGHT` (module path) from the environment. Preview frames
go to `explainer/build/` (git-ignored).
