import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { App } from './app';
import { TooltipProvider } from './components/ui/tooltip';
import { InterfaceMotion } from './components/motion';
import './styles.css';

const router = createBrowserRouter([{ path: '*', element: <App /> }]);
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InterfaceMotion><TooltipProvider><RouterProvider router={router}/></TooltipProvider></InterfaceMotion>
  </StrictMode>,
);
