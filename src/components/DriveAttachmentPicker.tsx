import { useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ChevronRight, FileSpreadsheet, FileText, Folder, HardDrive, LoaderCircle, Search } from 'lucide-react';
import type { Resource } from '../lib/types';
import { Badge, Button, EmptyState, Modal, type ScreenProps } from './ui';

export function DriveAttachmentPicker({ state, run, busy, selectedIds, onSelect, onClose }: ScreenProps & { selectedIds: string[]; onSelect: (resources: Resource[], selectedResourceIds: string[]) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [parents, setParents] = useState<Resource[]>([]);
  const [picked, setPicked] = useState<string[]>(selectedIds);
  const [more, setMore] = useState(false);
  const [searched, setSearched] = useState(false);
  const parent = parents.at(-1);
  const resources = state.resources.filter(resource => resource.mode === state.settings.mode);
  const visible = resources.filter(resource => {
    if (query.trim()) return resource.name.toLowerCase().includes(query.trim().toLowerCase()) && (!parent || resource.parentId === parent.id);
    return parent ? resource.parentId === parent.id : !resource.parentId || !resources.some(folder => folder.id === resource.parentId);
  }).sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name));
  async function browse(folder?: Resource, nextPage = false, search = query) {
    const result = await run('resource.browse', { parentId: folder?.id, q: search.trim() || undefined, ...(nextPage ? { nextPage: true } : {}) });
    if (result) { setMore(result.message.includes('More results are available.')); setSearched(true); }
    return result;
  }
  return <Modal wide title="Add from Google Drive" subtitle="Browse, search, and choose files without leaving this conversation." onClose={onClose}>
    <div className="drive-picker">
      <div className="drive-picker-toolbar"><form className="search-field" onSubmit={event => { event.preventDefault(); void browse(parent); }}><Search size={16} /><input value={query} onChange={event => { setQuery(event.target.value); setMore(false); }} aria-label="Search Drive files to attach" placeholder="Search Drive files…" /><button type="submit" disabled={!!busy || !state.permissions.driveRead} aria-label="Search Drive">{busy === 'resource.browse' ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}</button></form><Button disabled={!!busy || !state.permissions.driveRead} onClick={() => void browse(parent)}><HardDrive size={14} />Browse</Button></div>
      <div className="folder-breadcrumb"><button disabled={!!busy || !state.permissions.driveRead} onClick={async () => { if (await browse(undefined, false, '')) { setParents([]); setQuery(''); } }}><HardDrive size={14} />Drive</button>{parents.map((folder, index) => <span key={folder.id}><ChevronRight size={12} /><button disabled={!!busy || !state.permissions.driveRead} onClick={async () => { if (await browse(folder, false, '')) { setParents(parents.slice(0, index + 1)); setQuery(''); } }}>{folder.name}</button></span>)}<Badge>{state.settings.mode === 'demo' ? 'Synthetic files' : 'Live Drive'}</Badge></div>
      {!state.permissions.driveRead && <p className="inline-alert">Drive read is off. Enable it in Connections to browse your account.</p>}
      {state.settings.mode === 'live' && !state.connections.some(connection => connection.provider === 'google' && connection.connected) && <div className="attachment-connection-note"><HardDrive size={18} /><div><strong>Google Drive is not connected.</strong><p>Connect Google from Connections. Local file uploads remain available in this chat.</p></div><a className="text-button" href="#connections" onClick={onClose}>Connect<ArrowRight size={13} /></a></div>}
      <div className="drive-picker-files">{visible.length ? visible.map(resource => {
        const isFolder = resource.kind === 'folder';
        const Icon = isFolder ? Folder : resource.kind === 'spreadsheet' ? FileSpreadsheet : FileText;
        const checked = picked.includes(resource.id);
        return <button type="button" key={resource.id} className={`drive-picker-file ${checked ? 'drive-file-selected' : ''}`} disabled={!!busy || !state.permissions.driveRead} onClick={async () => {
          if (isFolder) { if (await browse(resource, false, '')) { setParents([...parents, resource]); setQuery(''); } }
          else setPicked(current => checked ? current.filter(id => id !== resource.id) : [...current, resource.id]);
        }}><span className={`file-symbol file-${resource.kind}`}><Icon size={20} /></span><span><strong>{resource.name}</strong><small>{isFolder ? 'Open folder' : `${resource.kind} · ${resource.mode === 'demo' ? 'synthetic source' : 'Google Drive source'}`}</small></span>{isFolder ? <ChevronRight size={16} /> : <span className={`picker-check ${checked ? 'picker-checked' : ''}`}>{checked && <Check size={12} strokeWidth={3} />}</span>}</button>;
      }) : <EmptyState icon={query ? Search : Folder} title={query ? 'No matching files' : searched ? 'This folder is empty' : 'Choose a source for this chat'} action={<Button disabled={!!busy || !state.permissions.driveRead} onClick={() => void browse(parent)}><Search size={14} />{query ? 'Search connected Drive' : 'Browse Drive'}</Button>}>{query ? 'Try a different file name or search connected Drive.' : 'Browse loaded folders or search your connected account.'}</EmptyState>}</div>
      <div className="drive-picker-footer"><span>{picked.length} file{picked.length === 1 ? '' : 's'} selected</span>{more && <Button disabled={!!busy} onClick={() => void browse(parent, true)}>Load more<ArrowRight size={13} /></Button>}{parent && <Button variant="ghost" disabled={!!busy} onClick={async () => { const next = parents.slice(0, -1); if (await browse(next.at(-1), false, '')) { setParents(next); setQuery(''); } }}><ArrowLeft size={13} />Back</Button>}<Button variant="primary" disabled={!!busy} onClick={() => onSelect(resources.filter(resource => picked.includes(resource.id) && resource.kind !== 'folder'), picked)}><Check size={14} />Use selected files</Button></div>
    </div>
  </Modal>;
}
