import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../contexts/ThemeContext';
import LandingPage from './LandingPage';

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => {
  const actual = jest.requireActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

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
  beforeEach(() => mockNavigate.mockReset());

  it('offers MU and NBIS next to Bitcoin', () => {
    renderLanding();
    expect(screen.getByRole('button', { name: /bitcoin/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /micron/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /nebius/i })).toBeTruthy();
  });

  it('routes a designated name into Volatility Puts', () => {
    renderLanding();
    fireEvent.click(screen.getByRole('button', { name: /nebius/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/strategies?tab=volatility-puts&symbol=NBIS');
  });
});
