import React from 'react';
import { createRoot } from 'react-dom/client';
import { OrbApp } from './orb';

const container = document.getElementById('root');
if (container === null) throw new Error('Missing #root');
createRoot(container).render(<OrbApp />);
