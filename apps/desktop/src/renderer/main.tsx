import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '@mona/ui/tokens.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Mona renderer root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
