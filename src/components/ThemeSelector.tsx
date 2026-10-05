import { useEffect, useState } from 'react';
import { Check, Palette } from 'lucide-react';
import { Button, Modal } from './ui';

const themes = [
  { id: 'green', name: 'Olive', hue: 83, scale: 1 },
  { id: 'blue', name: 'Muted blue', hue: 213, scale: .92 },
  { id: 'plum', name: 'Plum', hue: 282, scale: .88 },
  { id: 'rust', name: 'Rust', hue: 21, scale: .9 },
  { id: 'slate', name: 'Slate', hue: 205, scale: .42 },
] as const;
interface AccentTheme { id: string; hue: number; scale: number; }
const storageKey = 'proletariat-accent-theme';
function initialTheme(): AccentTheme {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (saved && Number.isFinite(saved.hue) && saved.hue >= 0 && saved.hue <= 360) {
      const preset = themes.find(item => item.id === saved.id);
      if (preset) return preset;
      if (saved.id === 'custom') return { id: 'custom', hue: saved.hue, scale: .85 };
    }
  } catch { /* Default theme also works when browser storage is unavailable. */ }
  return themes[0];
}
export function ThemeSelector() {
  const [theme, setTheme] = useState<AccentTheme>(initialTheme);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.documentElement.style.setProperty('--theme-hue', String(theme.hue));
    document.documentElement.style.setProperty('--theme-saturation-scale', String(theme.scale));
    try { localStorage.setItem(storageKey, JSON.stringify(theme)); } catch { /* Theme remains applied for this tab. */ }
  }, [theme]);
  return <><button className="icon-button" aria-label="Change accent theme" title="Change accent theme" onClick={() => setOpen(true)}><Palette size={17} /></button>{open && <Modal title="A color that feels like you" subtitle="Choose a bold, muted accent. Your layout and reading surfaces stay familiar." onClose={() => setOpen(false)}><div className="form-stack"><div className="theme-presets" aria-label="Accent presets">{themes.map(preset => <button key={preset.id} className={`theme-preset ${theme.id === preset.id ? 'theme-preset-selected' : ''}`} onClick={() => setTheme(preset)} aria-pressed={theme.id === preset.id}><span style={{ background: `hsl(${preset.hue} ${24 * preset.scale}% 35%)` }}>{theme.id === preset.id && <Check size={17} />}</span><strong>{preset.name}</strong></button>)}</div><label className="theme-custom"><span>Custom muted hue<span>{Math.round(theme.hue)}°</span></span><input type="range" min="0" max="360" step="1" value={theme.hue} onChange={event => setTheme({ id: 'custom', hue: Number(event.target.value), scale: .85 })} aria-label="Custom accent hue" /><small>The accent stays muted; text and backgrounds keep their separate contrast levels.</small></label><div className="theme-preview"><span className="eyebrow">PREVIEW</span><h3>Room for what matters.</h3><p>A calm surface, a clear next step.</p><Button variant="primary" onClick={() => setOpen(false)}>Use this theme<Check size={14} /></Button></div><div className="form-actions"><Button onClick={() => setTheme(themes[0])}>Restore green</Button><Button variant="primary" onClick={() => setOpen(false)}>Done</Button></div></div></Modal>}</>;
}
