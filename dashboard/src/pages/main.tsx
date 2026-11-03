import '@fontsource/space-grotesk/latin-600.css';
import '@fontsource/space-grotesk/latin-700.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/jetbrains-mono/latin-500.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import '../index.css';
import '../explain.css';
import '../redesign.css';
import '../topbar.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PAGES } from '../ui/SiteNav';
import { AttacksPage } from './AttacksPage';
import { ProtectionPage } from './ProtectionPage';
import { SignalPage } from './SignalPage';
import { SlidesPage } from './SlidesPage';

const ROUTES = {
  '/signal': SignalPage,
  '/attacks': AttacksPage,
  '/protection': ProtectionPage,
  '/slides': SlidesPage,
} as const;

const queryPage = new URLSearchParams(window.location.search).get('page');
const requested = queryPage
  ? `/${queryPage.replace(/^\/+|\/+$/g, '')}`
  : window.location.pathname.replace(/\/+$/, '');
// The explainer video became slides: its old address opens them.
const moved = requested === '/noise' ? '/slides' : requested;
const route = (moved in ROUTES ? moved : '/signal') as keyof typeof ROUTES;
const Page = ROUTES[route];
const title = PAGES.find((p) => p.path === route)?.title;
document.title = `${title} · Secure Ground-Link Testbed`;

const container = document.getElementById('root');

if (!container) {
  throw new Error('Root container #root was not found in pages.html');
}

createRoot(container).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
