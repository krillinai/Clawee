import { Check, RotateCcw, X } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';

type Point = { x: number; y: number };
export function FeedbackScreenshotEditor({ file, onSave, onCancel }: { file: File; onSave: (file: File) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement | undefined>(undefined);
  const start = useRef<Point | undefined>(undefined);
  const [selection, setSelection] = useState<{ left: number; top: number; width: number; height: number }>();
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    const url = URL.createObjectURL(file); const bitmap = new Image(); let active = true;
    bitmap.onload = () => {
      const target = canvas.current;
      if (!active || !target) return;
      if (bitmap.naturalWidth * bitmap.naturalHeight > 25000000) { setError('截图像素超过限额。'); return; }
      target.width = bitmap.naturalWidth; target.height = bitmap.naturalHeight;
      const context = target.getContext('2d');
      if (!context) { setError('截图编辑不可用。'); return; }
      context.drawImage(bitmap, 0, 0); image.current = bitmap; setReady(true);
    };
    bitmap.onerror = () => { if (active) setError('截图无法解码，请移除后重新选择。'); };
    bitmap.src = url;
    return () => { active = false; mounted.current = false; URL.revokeObjectURL(url); };
  }, [file]);
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) };
  }
  function rectangle(from: Point, to: Point) { return { left: Math.min(from.x, to.x), top: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) }; }
  function finish(event: PointerEvent<HTMLCanvasElement>) {
    if (!start.current) return;
    const region = rectangle(start.current, point(event)); const target = event.currentTarget; const context = target.getContext('2d');
    if (context) {
      const left = Math.floor(region.left * target.width); const top = Math.floor(region.top * target.height);
      context.fillStyle = '#000000';
      context.fillRect(left, top, Math.ceil((region.left + region.width) * target.width) - left, Math.ceil((region.top + region.height) * target.height) - top);
    }
    start.current = undefined; setSelection(undefined);
  }
  function save() {
    if (saving || !ready) return;
    setSaving(true);
    canvas.current?.toBlob(blob => {
      if (!mounted.current) return;
      setSaving(false);
      if (!blob) { setError('截图保存失败。'); return; }
      if (blob.size > 10 * 1024 * 1024) { setError('遮盖后的截图超过 10 MiB，请使用较小截图。'); return; }
      onSave(new File([blob], 'screenshot.png', { type: 'image/png' }));
    }, 'image/png');
  }
  return <section aria-label="截图遮盖" className="min-w-0 space-y-2">
    <div className="flex items-center justify-between"><span className="text-sm">遮盖截图</span><div className="flex gap-1">
      <Button title="重置遮盖" aria-label="重置遮盖" variant="ghost" size="icon" disabled={!ready || saving} onClick={() => { const target = canvas.current; if (target && image.current) target.getContext('2d')?.drawImage(image.current, 0, 0); }}><RotateCcw size={16} /></Button>
      <Button title="保存遮盖" aria-label="保存遮盖" variant="ghost" size="icon" disabled={!ready || saving} onClick={save}><Check size={16} /></Button>
      <Button title="取消遮盖" aria-label="取消遮盖" variant="ghost" size="icon" disabled={saving} onClick={onCancel}><X size={16} /></Button>
    </div></div>
    <div className="relative mx-auto w-fit max-w-full"><canvas ref={canvas} aria-label="截图遮盖画布" className="block max-h-[45dvh] max-w-full cursor-crosshair touch-none" onPointerDown={event => { if (!ready || saving) return; start.current = point(event); event.currentTarget.setPointerCapture?.(event.pointerId); }} onPointerMove={event => { if (start.current) setSelection(rectangle(start.current, point(event))); }} onPointerUp={finish} onPointerCancel={() => { start.current = undefined; setSelection(undefined); }} />
      {selection ? <div className="pointer-events-none absolute border-2 border-red-500" style={{ left: `${selection.left * 100}%`, top: `${selection.top * 100}%`, width: `${selection.width * 100}%`, height: `${selection.height * 100}%` }} /> : null}
    </div>
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
  </section>;
}
