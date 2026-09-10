import { useEffect, useRef } from "react";
import { t } from "./strings.js";

export function TextInputDialog(props: { title: string; value: string; onChange(value: string): void; placeholder?: string; confirmText: string; onSubmit(value: string): void; onCancel(): void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const submit = () => { const trimmed = props.value.trim(); if (trimmed) props.onSubmit(trimmed); };
  return <div className="dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onCancel(); }}>
    <div className="dialog" role="dialog" aria-label={props.title}>
      <h2>{props.title}</h2>
      <input ref={inputRef} className="dialog-input" value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); if (event.key === "Escape") props.onCancel(); }} />
      <div className="dialog-actions">
        <button type="button" onClick={props.onCancel}>{t("取消")}</button>
        <button type="button" className="primary" onClick={submit}>{props.confirmText}</button>
      </div>
    </div>
  </div>;
}
