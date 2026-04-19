import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from './app';

describe('App', () => {
  const renderWithQuery = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  };

  it('should render successfully', () => {
    const { baseElement } = renderWithQuery();
    expect(baseElement).toBeTruthy();
  });

  it('should show the Syncra heading', () => {
    renderWithQuery();
    expect(screen.getByText('Syncra')).toBeTruthy();
  });
});
