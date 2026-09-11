import React, { useCallback, useLayoutEffect, useRef, useState } from "react";

export function Segmented<T extends string>(props: { value: T; options: Array<[T, React.ReactNode]>; onChange(value: T): void; vertical?: boolean; className?: string; "aria-label"?: string }) {
  const nodes = useRef(new Map<T, HTMLButtonElement>());
  const [pill, setPill] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const measure = useCallback(() => { const node = nodes.current.get(props.value); if (!node) return; const next = { x: node.offsetLeft, y: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight }; setPill((old) => old && old.x === next.x && old.y === next.y && old.width === next.width && old.height === next.height ? old : next); }, [props.value]);
  useLayoutEffect(() => { measure(); });
  return <div className={`segments${props.vertical ? " vertical" : ""}${props.className ? ` ${props.className}` : ""}`} role="tablist" aria-label={props["aria-label"]}>
    {pill && <span className="segment-pill" style={{ transform: `translate(${pill.x}px, ${pill.y}px)`, width: pill.width, height: pill.height }} aria-hidden="true" />}
    {props.options.map(([value, label]) => <button type="button" key={value} role="tab" aria-selected={props.value === value} ref={(node) => { if (node) nodes.current.set(value, node); else nodes.current.delete(value); }} className={props.value === value ? "active" : ""} onClick={() => props.onChange(value)}>{label}</button>)}
  </div>;
}
