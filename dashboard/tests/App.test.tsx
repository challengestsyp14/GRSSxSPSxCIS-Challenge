import { render, screen } from '@testing-library/react';

import App from '../src/App';

describe('App', () => {
  it('shows the testbed title while the engine trains', () => {
    render(<App />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'Secure Ground-Link Testbed',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Training the Isolation Forest');
  });
});
