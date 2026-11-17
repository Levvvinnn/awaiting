import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './avatar.css';

/** Placeholder: the avatar character and its states arrive in M3. */
function Avatar() {
  return null;
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <Avatar />
  </StrictMode>,
);
