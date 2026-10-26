import { LoaderCircle } from 'lucide-react';
import type { CellOutput } from '../lib/notebook';
import type { JobOutput } from '../types';

interface OutputViewProps {
  outputs: Array<CellOutput | JobOutput>;
  running?: boolean;
  emptyLabel?: string;
}

function mediaSource(output: CellOutput) {
  if (output.text.startsWith('data:')) return output.text;
  if (output.mime === 'image/svg+xml' && output.text.trimStart().startsWith('<')) {
    return `data:image/svg+xml;utf8,${encodeURIComponent(output.text)}`;
  }
  return `data:${output.mime};base64,${output.text.replace(/\s/g, '')}`;
}

export function OutputView({ outputs, running, emptyLabel }: OutputViewProps) {
  if (outputs.length === 0 && !running && !emptyLabel) return null;
  return (
    <div className="output-view" aria-live="polite">
      {outputs.map((output, index) => {
        if (output.name === 'image') {
          return (
            <div className="media-output" key={index}>
              <img src={mediaSource(output)} alt="Notebook cell output" />
            </div>
          );
        }
        if (output.name === 'audio') {
          return (
            <div className="media-output" key={index}>
              <audio controls src={mediaSource(output)} />
            </div>
          );
        }
        return (
          <pre key={index} className={`text-output output-${output.name}`}>
            {output.text}
          </pre>
        );
      })}
      {running && (
        <div className="output-running">
          <LoaderCircle size={14} className="spin" /> Running in the persistent Python kernel…
        </div>
      )}
      {!running && outputs.length === 0 && emptyLabel && (
        <div className="output-empty">{emptyLabel}</div>
      )}
    </div>
  );
}
