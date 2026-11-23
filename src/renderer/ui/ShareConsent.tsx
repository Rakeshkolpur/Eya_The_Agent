import React from 'react';
import { Icon } from './icons';

/**
 * What turning on screen sharing means, said plainly, with the button that turns it on. Nothing starts looking at the screen until
 * this button is pressed — in the app, in the quick panel, or (by voice) after a clear spoken yes.
 */
export function ShareConsent({ onStart, onCancel, compact = false }: { onStart: () => void; onCancel?: () => void; compact?: boolean }): React.ReactElement {
  return (
    <div className={`share-consent ${compact ? 'compact' : ''}`} role="region" aria-label="Share your screen with Eya">
      <div className="share-consent-title">
        <Icon name="screen" size={compact ? 16 : 20} /> Share your screen with Eya?
      </div>
      <ul className="share-consent-list">
        <li>Eya looks at your screen about once a second, only while this is on.</li>
        <li>Each picture goes to Gemini so she can answer you. Pictures are never saved.</li>
        <li>Eya's own windows are left out of the picture.</li>
        <li>If a chat app is showing while Chats are OFF, she stops looking until it is gone.</li>
        <li>It switches itself off after 15 quiet minutes, and you can stop it any time.</li>
      </ul>
      <div className="share-consent-actions">
        <button type="button" className="btn primary" onClick={onStart}>
          Start sharing
        </button>
        {onCancel !== undefined && (
          <button type="button" className="btn" onClick={onCancel}>
            Not now
          </button>
        )}
      </div>
    </div>
  );
}
