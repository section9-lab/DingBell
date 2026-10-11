import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './app';
import { TooltipProvider } from './components/ui/tooltip';
import './styles.css';

const router = createBrowserRouter([{ path: '*', element: <App /> }]);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider><RouterProvider router={router}/></TooltipProvider>
  </StrictMode>,
);
