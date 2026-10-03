import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ArrowUpRight, Check, CircleDashed, LoaderCircle, X, type LucideIcon } from 'lucide-react';
import type { ActionResult, Agent, WorkspaceState } from '../lib/types';

export type ActionFn = (type: string, payload?: Record<string, unknown>) => Promise<ActionResult | null>;
export interface ScreenProps { state: WorkspaceState; run: ActionFn; busy: string | null; }
export function Button({ children, className = '', variant = 'secondary', loading, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean }) {
  return <button className={`button button-${variant} ${className}`} {...props} disabled={props.disabled || loading}>{loading && <LoaderCircle size={15} className="spin" />}{children}</button>;
}
export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: 'neutral' | 'green' | 'orange' | 'red' | 'purple'; dot?: boolean }) { return <span className={`badge badge-${tone}`}>{dot && <i />}{children}</span>; }
export function Avatar({ agent, small = false }: { agent: Agent; small?: boolean }) {
  const colors = ['olive', 'clay', 'lavender', 'blue'];
  const color = colors[agent.id.split('').reduce((n, c) => n + c.charCodeAt(0), 0) % colors.length];
  return <span className={`avatar avatar-${color} ${small ? 'avatar-small' : ''}`}>{agent.initials || agent.name.slice(0, 2).toUpperCase()}</span>;
}
export function EmptyState({ icon: Icon = CircleDashed, title, children, action }: { icon?: LucideIcon; title: string; children: ReactNode; action?: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon size={24} strokeWidth={1.5} /></span><h3>{title}</h3><p>{children}</p>{action}</div>; }
export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const titleId = useId(); const ref = useRef<HTMLDivElement>(null); const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const root = ref.current;
    root?.querySelector<HTMLElement>('input, textarea, select, button')?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === 'Escape') closeRef.current();
      if (e.key !== 'Tab' || !root) return;
      const list = Array.from(root.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')).filter(el => el.offsetParent !== null);
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><div className={`modal ${wide ? 'modal-wide' : ''}`} ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId}><header className="modal-header"><div><h2 id={titleId}>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></header>{children}</div></div>;
}
export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) { return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: () => void; disabled?: boolean; label: string }) { return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange} className={`toggle ${checked ? 'toggle-on' : ''}`}><span>{checked && <Check size={11} strokeWidth={3} />}</span></button>; }
export const shortTime = (date: string, timezone?: string) => { try { return new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(new Date(date)); } catch { return '—'; } };
export const shortDate = (date: string) => { try { return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(date.length === 10 ? `${date}T12:00:00` : date)); } catch { return '—'; } };
export const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value);
export const duration = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
export function SafeLink({ url, children, className = '' }: { url?: string; children: ReactNode; className?: string }) { if (!url || !/^https?:\/\//i.test(url)) return <span className={className}>{children}</span>; return <a className={`external-link ${className}`} href={url} target="_blank" rel="noreferrer">{children}<ArrowUpRight size={13} /></a>; }
export function SectionHead({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) { return <div className="section-heading"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>; }
