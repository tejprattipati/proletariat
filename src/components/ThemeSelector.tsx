import { useEffect, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { Button, Modal } from './ui';
import type { AccentTheme } from '../lib/types';

const themes = [
  { id: 'green', name: 'Olive', hue: 83, scale: 1 },
  { id: 'blue', name: 'Muted blue', hue: 213, scale: .92 },
  { id: 'plum', name: 'Plum', hue: 282, scale: .88 },
  { id: 'rust', name: 'Rust', hue: 21, scale: .9 },
  { id: 'slate', name: 'Slate', hue: 205, scale: .42 },
] as const;
export function initialTheme(saved?: AccentTheme): AccentTheme {
  const preset = themes.find(item => item.id === saved?.id);
  if(preset)return preset;
  if(saved?.id==='custom' && Number.isFinite(saved.hue) && saved.hue>=0 && saved.hue<=360)return {id:'custom',hue:saved.hue,scale:.85};
  return themes[0];
}
export function ThemeSelector({value,onSave,disabled=false}:{value?:AccentTheme;onSave:(theme:AccentTheme)=>Promise<boolean>;disabled?:boolean}) {
  const [theme, setTheme] = useState<AccentTheme>(()=>initialTheme(value));
  const [open, setOpen] = useState(false);
  const [saving,setSaving]=useState(false);
  useEffect(()=>{if(!open)setTheme(initialTheme(value));},[value?.id,value?.hue,open]);
  useEffect(() => {
    document.documentElement.style.setProperty('--theme-hue', String(theme.hue));
    document.documentElement.style.setProperty('--theme-saturation-scale', String(theme.scale));
  }, [theme]);
  useEffect(()=>()=>{document.documentElement.style.removeProperty('--theme-hue');document.documentElement.style.removeProperty('--theme-saturation-scale');},[]);
  function close(){if(!saving){setTheme(initialTheme(value));setOpen(false);}}
  async function save(){if(saving||disabled)return;setSaving(true);try{if(await onSave(theme))setOpen(false);}finally{setSaving(false);}}
  return <><button className="icon-button" aria-label="Change accent theme" title="Change accent theme" disabled={disabled} onClick={() => setOpen(true)}><Palette size={17} /></button>{open && <Modal title="A color that feels like you" subtitle="Your saved accent belongs to this workspace account." onClose={close}><div className="form-stack"><div className="theme-presets" aria-label="Accent presets">{themes.map(preset => <button key={preset.id} className={`theme-preset ${theme.id === preset.id ? 'theme-preset-selected' : ''}`} disabled={saving} onClick={() => setTheme(preset)} aria-pressed={theme.id === preset.id}><span style={{ background: `hsl(${preset.hue} ${24 * preset.scale}% 35%)` }}>{theme.id === preset.id && <Check size={17} />}</span><strong>{preset.name}</strong></button>)}</div><label className="theme-custom"><span>Custom muted hue<span>{Math.round(theme.hue)}°</span></span><input type="range" min="0" max="360" step="1" value={theme.hue} disabled={saving} onChange={event => setTheme({ id: 'custom', hue: Number(event.target.value), scale: .85 })} aria-label="Custom accent hue" /><small>The accent stays muted; text and backgrounds keep their separate contrast levels.</small></label><div className="theme-preview"><span className="eyebrow">PREVIEW</span><h3>Room for what matters.</h3><p>A calm surface, a clear next step.</p><Button variant="primary" disabled={disabled||saving} loading={saving} onClick={()=>void save()}>Use this theme<Check size={14} /></Button></div><div className="form-actions"><Button disabled={saving} onClick={() => setTheme(themes[0])}>Restore green</Button><Button variant="primary" disabled={disabled||saving} loading={saving} onClick={()=>void save()}>Done</Button></div></div></Modal>}</>;
}
