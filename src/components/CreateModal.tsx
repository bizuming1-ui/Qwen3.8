import { useState } from 'react';
import { FilePlus2, FolderPlus, LoaderCircle } from 'lucide-react';
import { Modal } from './Modal';

interface CreateModalProps {
  creating: boolean;
  onClose: () => void;
  onCreate: (path: string, kind: 'file' | 'directory') => Promise<void>;
}

export function CreateModal({ creating, onClose, onCreate }: CreateModalProps) {
  const [kind, setKind] = useState<'file' | 'directory'>('file');
  const [path, setPath] = useState('working/experiment.py');
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    try {
      await onCreate(path.trim().replace(/^\/kaggle\//, '').replace(/^kaggle\//, ''), kind);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the entry.');
    }
  };

  return (
    <Modal
      title="Create in repository"
      description="Add a real file or folder below /kaggle."
      onClose={creating ? () => undefined : onClose}
      footer={
        <div className="modal-footer-actions align-right">
          <button className="button secondary" onClick={onClose} disabled={creating}>Cancel</button>
          <button className="button primary" onClick={submit} disabled={creating || !path.trim()}>
            {creating ? <LoaderCircle size={16} className="spin" /> : kind === 'file' ? <FilePlus2 size={16} /> : <FolderPlus size={16} />}
            Create {kind}
          </button>
        </div>
      }
    >
      <div className="segmented-control">
        <button className={kind === 'file' ? 'active' : ''} onClick={() => setKind('file')}><FilePlus2 size={15} /> File</button>
        <button className={kind === 'directory' ? 'active' : ''} onClick={() => setKind('directory')}><FolderPlus size={15} /> Folder</button>
      </div>
      <label className="field-label" htmlFor="new-entry-path">Path</label>
      <div className="path-input">
        <span>/kaggle/</span>
        <input id="new-entry-path" value={path} onChange={(event) => setPath(event.target.value)} autoFocus />
      </div>
      {error && <div className="form-error" role="alert">{error}</div>}
    </Modal>
  );
}
