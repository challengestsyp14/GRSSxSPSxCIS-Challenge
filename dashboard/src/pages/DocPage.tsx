import type { ReactNode } from 'react';

import { Aurora } from '../reactbits/Aurora';
import { ClickSpark } from '../reactbits/ClickSpark';
import { PAGES, type PagePath } from '../ui/SiteNav';
import { TopBar } from '../ui/TopBar';
import { pageHref } from '../ui/pageHref';

/** Shell of every page after the dashboard: fixed top bar, hero, content, previous/next. */
export function DocPage({
  path,
  eyebrow,
  lead,
  aside,
  children,
}: {
  path: PagePath;
  eyebrow: string;
  lead: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const i = PAGES.findIndex((p) => p.path === path);
  const page = PAGES[i];
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];

  return (
    <div className="app doc-page">
      <Aurora />
      <ClickSpark />
      <TopBar current={path} />

      <main className="npage">
        <header className="npage__head">
          <p className="explain__eyebrow">
            {i} / {PAGES.length - 1} · {eyebrow}
          </p>
          <h1 className="explain__title">{page.title}</h1>
          <p className="explain__lead">{lead}</p>
          {aside}
        </header>

        {children}

        <nav className="pager" aria-label="Previous and next page">
          {prev && (
            <a className="pager__link" href={pageHref(prev.path)} rel="prev">
              <span className="pager__dir">← Previous</span>
              <span className="pager__title">{prev.title}</span>
            </a>
          )}
          {next && (
            <a className="pager__link pager__link--next" href={pageHref(next.path)} rel="next">
              <span className="pager__dir">Next →</span>
              <span className="pager__title">{next.title}</span>
            </a>
          )}
        </nav>
      </main>

      <footer className="npage__foot">
        <p>
          Emulation only: nothing here transmits or receives RF. Attacks are software injectors
          acting on synthetic frames; figures come from the testbed’s link model and synthetic
          traffic, to be re-measured on the official reference datasets.
        </p>
        <p>
          Frames are sealed and verified for real with Web Crypto (HMAC-SHA256, SHA-256 hash chain
          from a genesis root, Ed25519-signed re-keys); the Isolation Forest is trained in the
          browser on nominal passes; the physical layer is the digital twin’s chi-square engine,
          against SGP4 and the ITU-R P.618 link budget.
        </p>
        <p className="npage__legal">
          Fonts: Space Grotesk, Inter, JetBrains Mono (SIL OFL 1.1) · Land outlines: Natural Earth
          (public domain)
        </p>
      </footer>
    </div>
  );
}
