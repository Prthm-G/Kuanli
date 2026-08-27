'use client';

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Upload, Loader2, AlertTriangle, CheckCircle, FileSpreadsheet } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Flag {
  level: 'blocker' | 'review';
  sheet: string;
  rowNumber: number;
  student: string;
  code: string;
  detail: string;
}

interface Summary {
  sheet: string;
  stats: Record<string, number>;
  heldBack: Array<{ student: string; row: number; reason: string }>;
  flags: Flag[];
  unmappedHeaders: string[];
  written?: Record<string, number>;
}

/**
 * Import an admission spreadsheet into the register.
 *
 * Deliberately preview-first: the file is parsed server-side and the operator
 * sees exactly what would be created, what is held back and every flag BEFORE
 * anything is written. The preview and the write run the same parser, so the
 * numbers shown are the numbers applied.
 */
export function AdmissionImportModal({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheets, setSheets] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState<string>('');
  const [preview, setPreview] = useState<Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Summary | null>(null);

  function reset() {
    setFile(null);
    setSheets(null);
    setSheet('');
    setPreview(null);
    setDone(null);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function post(f: File, opts: { sheet?: string; dryRun: boolean }) {
    const body = new FormData();
    body.append('file', f);
    const params = new URLSearchParams();
    if (opts.sheet) params.set('sheet', opts.sheet);
    if (opts.dryRun) params.set('dryRun', '1');
    const res = await fetch(`/api/admissions/import?${params}`, { method: 'POST', body });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? 'Import failed');
    return json;
  }

  async function onPick(f: File) {
    setBusy(true);
    setFile(f);
    try {
      const json = await post(f, { dryRun: true });
      setSheets(json.sheets ?? []);
      if ((json.sheets ?? []).length === 1) await runPreview(f, json.sheets[0]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not read that file');
      reset();
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(f: File, s: string) {
    setBusy(true);
    setSheet(s);
    try {
      setPreview(await post(f, { sheet: s, dryRun: true }));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Preview failed');
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!file || !sheet) return;
    setBusy(true);
    try {
      const json: Summary = await post(file, { sheet, dryRun: false });
      setDone(json);
      onImported();
      toast.success(`Imported ${json.written?.contacts ?? 0} new students from ${sheet}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  }

  const flagsByCode = new Map<string, Flag[]>();
  for (const f of preview?.flags ?? []) {
    if (f.code === 'duplicate-phone') continue;
    const list = flagsByCode.get(f.code) ?? [];
    list.push(f);
    flagsByCode.set(f.code, list);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import admissions from Excel</DialogTitle>
          <DialogDescription>
            Upload a cycle tab from the office workbook. Nothing is written until you
            confirm, and re-importing the same sheet adds nothing new.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <CheckCircle className="h-4 w-4 text-primary" />
              Imported {done.sheet}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {Object.entries(done.written ?? {}).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border p-2">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="text-foreground font-semibold">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {!file && (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
              >
                <Upload className="h-6 w-6" />
                <span className="text-sm font-medium">Choose an .xlsx file</span>
              </button>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onPick(f);
              }}
            />

            {file && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileSpreadsheet className="h-4 w-4" />
                {file.name}
              </p>
            )}

            {sheets && sheets.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Which cycle?</span>
                <select
                  value={sheet}
                  onChange={(e) => file && void runPreview(file, e.target.value)}
                  className="border-border bg-muted text-foreground h-9 rounded border px-2 text-sm"
                >
                  <option value="">Select a sheet…</option>
                  {sheets.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {busy && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Reading the spreadsheet…
              </p>
            )}

            {preview && (
              <div className="flex flex-col gap-3">
                <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  {(
                    [
                      ['To import', preview.stats.importable],
                      ['Held back', preview.stats.heldBack],
                      ['Enrolled', preview.stats.enrolled],
                      ['Application', preview.stats.applicationStarted],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="rounded-lg border border-border p-2">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="text-foreground font-semibold">{value}</dd>
                    </div>
                  ))}
                </dl>

                {preview.heldBack.length > 0 && (
                  <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
                    <p className="flex items-center gap-2 text-sm font-medium text-amber-500">
                      <AlertTriangle className="h-4 w-4" />
                      {preview.heldBack.length} row(s) held back — these share a phone
                      number and need a human decision
                    </p>
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {preview.heldBack.slice(0, 8).map((h) => (
                        <li key={`${h.student}-${h.row}`}>
                          row {h.row} · <span className="text-foreground">{h.student}</span> — {h.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {flagsByCode.size > 0 && (
                  <details className="rounded-lg border border-border p-3">
                    <summary className="cursor-pointer text-sm font-medium text-foreground">
                      {[...flagsByCode.values()].reduce((n, l) => n + l.length, 0)} row(s)
                      imported with a warning
                    </summary>
                    <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                      {[...flagsByCode.entries()].map(([code, list]) => (
                        <li key={code}>
                          <span className="text-foreground">{code}</span>: {list.length}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                Cancel
              </Button>
              <Button onClick={runImport} disabled={!preview || busy || preview.stats.importable === 0}>
                {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Import {preview?.stats.importable ?? 0} students
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
