import { useRef, useState } from 'react';
import { ClipboardPaste, FileUp, HardDrive, LoaderCircle } from 'lucide-react';
import { Modal } from './Modal';

interface ImportModalProps {
  saving: boolean;
  onClose: () => void;
  onImport: (path: string, content: string) => Promise<void>;
}

export function ImportModal({ saving, onClose, onImport }: ImportModalProps) {
  const [mode, setMode] = useState<'paste' | 'upload'>('paste');
  const [content, setContent] = useState('');
  const [targetPath, setTargetPath] = useState('working/voice_cloning.ipynb');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const readUpload = async (file?: File) => {
    if (!file) return;
    setError('');
    try {
      const text = await file.text();
      setContent(text);
      setTargetPath(`working/${file.name}`);
    } catch {
      setError('The selected file could not be read as text.');
    }
  };

  const submit = async () => {
    setError('');
    const cleanPath = targetPath.trim().replace(/^\/kaggle\//, '').replace(/^kaggle\//, '');
    if (!cleanPath.startsWith('working/') || cleanPath.length <= 'working/'.length) {
      setError('Choose a destination inside working/, for example working/train.py.');
      return;
    }
    if (!content.trim()) {
      setError('Paste your Kaggle code or choose a file first.');
      return;
    }
    try {
      await onImport(cleanPath, content);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Import failed.');
    }
  };

  return (
    <Modal
      title="Import Kaggle code"
      description="Paste a complete pipeline or upload an existing notebook. The destination is a real file in this repository."
      onClose={saving ? () => undefined : onClose}
      wide
      footer={
        <>
          <span className="modal-footer-note"><HardDrive size={14} /> Saved to disk immediately</span>
          <div className="modal-footer-actions">
            <button className="button secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="button primary" onClick={submit} disabled={saving}>
              {saving ? <LoaderCircle size={16} className="spin" /> : <FileUp size={16} />}
              {saving ? 'Saving…' : 'Import & save'}
            </button>
          </div>
        </>
      }
    >
      <div className="segmented-control import-tabs">
        <button className={mode === 'paste' ? 'active' : ''} onClick={() => setMode('paste')}>
          <ClipboardPaste size={15} /> Paste code
        </button>
        <button className={mode === 'upload' ? 'active' : ''} onClick={() => setMode('upload')}>
          <FileUp size={15} /> Upload file
        </button>
      </div>

      {mode === 'upload' && (
        <button className="upload-dropzone" onClick={() => fileInput.current?.click()}>
          <FileUp size={26} />
          <strong>Choose a .ipynb or .py file</strong>
          <span>{content ? 'File loaded. You can inspect or edit it below.' : 'The original file remains unchanged.'}</span>
        </button>
      )}
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept=".ipynb,.py,.txt,.md,text/plain,application/json"
        onChange={(event) => readUpload(event.target.files?.[0])}
      />

      <label className="field-label" htmlFor="import-destination">Repository destination</label>
      <div className="path-input">
        <span>/kaggle/</span>
        <input
          id="import-destination"
          value={targetPath}
          onChange={(event) => setTargetPath(event.target.value)}
          spellCheck={false}
        />
      </div>
      <p className="field-help">
        Use a <code>.py</code> destination for a script. For <code>.ipynb</code>, Python <code># %%</code> sections become cells automatically.
      </p>

      <label className="field-label" htmlFor="import-content">Source code</label>
      <textarea
        id="import-content"
        className="import-textarea"
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder="Paste your complete Kaggle Python code or notebook JSON here…"
        spellCheck={false}
      />
      {error && <div className="form-error" role="alert">{error}</div>}
    </Modal>
  );
}
