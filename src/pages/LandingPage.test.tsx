import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../contexts/ThemeContext';
import LandingPage from './LandingPage';

function renderLanding() {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <LandingPage />
      </ThemeProvider>
    </MemoryRouter>
  );
}

describe('LandingPage designated names', () => {
  it('offers MU and NBIS next to Bitcoin', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: /bitcoin/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /micron/i })).toBeTruthy();
    expect(screen.getByRole('link', { name: /nebius/i })).toBeTruthy();
  });

  it('deep-links a designated name into Volatility Puts', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: /micron/i }).getAttribute('href')).toBe(
      '/strategies?tab=volatility-puts&symbol=MU'
    );
    expect(screen.getByRole('link', { name: /nebius/i }).getAttribute('href')).toBe(
      '/strategies?tab=volatility-puts&symbol=NBIS'
    );
  });
});
