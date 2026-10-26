import { useState } from 'react';
import { GitBranch, Github, LoaderCircle, Save } from 'lucide-react';
import type { GitStatus } from '../types';
import { Modal } from './Modal';

interface SyncModalProps {
  gitStatus: GitStatus | null;
  dirty: boolean;
  syncing: boolean;
  onClose: () => void;
  onSync: (message: string) => Promise<void>;
}

export function SyncModal({ gitStatus, dirty, syncing, onClose, onSync }: SyncModalProps) {
  const [message, setMessage] = useState('Update voice cloning workspace');
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    try {
      await onSync(message);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'GitHub sync failed.');
    }
  };

  return (
    <Modal
      title="Commit & push to GitHub"
      description="Save your work, commit kaggle/working, and push the current branch to origin."
      onClose={syncing ? () => undefined : onClose}
      footer={
        <>
          <span className="modal-footer-note"><GitBranch size={14} /> {gitStatus?.branch || 'current branch'}</span>
          <div className="modal-footer-actions">
            <button className="button secondary" onClick={onClose} disabled={syncing}>Cancel</button>
            <button className="button primary" onClick={submit} disabled={syncing || !message.trim()}>
              {syncing ? <LoaderCircle size={16} className="spin" /> : <Github size={16} />}
              {syncing ? 'Pushing…' : dirty ? 'Save, commit & push' : 'Commit & push'}
            </button>
          </div>
        </>
      }
    >
      <div className="sync-summary">
        <div><span>Destination</span><strong>origin / {gitStatus?.branch || '…'}</strong></div>
        <div><span>Workspace changes</span><strong>{gitStatus?.changes.length ?? 0}{dirty ? ' + unsaved editor' : ''}</strong></div>
      </div>
      {dirty && (
        <div className="notice info"><Save size={16} /> Your open editor will be saved to disk before Git runs.</div>
      )}
      <label className="field-label" htmlFor="commit-message">Commit message</label>
      <input
        id="commit-message"
        className="text-input"
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        maxLength={200}
        autoFocus
      />
      <div className="change-list">
        <span className="field-label">Changes detected by Git</span>
        {gitStatus?.changes.length ? (
          <pre>{gitStatus.changes.slice(0, 30).join('\n')}</pre>
        ) : (
          <p className="muted">No committed-file differences detected. Unsaved edits are included after saving.</p>
        )}
      </div>
      <p className="field-help">Only <code>kaggle/working</code> is staged by this action. Large datasets and generated artifacts remain ignored.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Modal>
  );
}
