'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Eye, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { createClient } from '@/lib/supabase/client';
import {
  loadApplication,
  loadContactDocuments,
  markAllUploaded,
  saveApplication,
  setDocumentUploaded,
  type ApplicationRecord,
  type ContactDocument,
  type ContactDocuments,
} from '@/lib/applications/application-queries';

const MAX_BYTES = 16 * 1024 * 1024;

interface DocumentsTabProps {
  contactId: string;
  accountId: string;
  userId: string;
  /** The contact's enrollment code (LPU, AMI, DBU...); the application's own wins. */
  contactUniversity: string | null;
  /** Agent or above. */
  canEdit: boolean;
  /** Owner or admin: may switch "Keep files". */
  canKeepFiles: boolean;
  onChanged?: () => void;
}

const day = (iso: string) => format(new Date(iso), 'MMM d, yyyy');

export function DocumentsTab({
  contactId,
  accountId,
  userId,
  contactUniversity,
  canEdit,
  canKeepFiles,
  onChanged,
}: DocumentsTabProps) {
  const [app, setApp] = useState<ApplicationRecord | null>(null);
  const [view, setView] = useState<ContactDocuments | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadType, setUploadType] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const db = createClient();
      const a = await loadApplication(db, contactId);
      setApp(a);
      // Same fallback the database uses to count required documents.
      const university = a?.university || contactUniversity || 'LPU';
      setView(await loadContactDocuments(db, accountId, contactId, university));
    } catch (e) {
      console.error('Failed to load documents:', e);
      toast.error('Could not load the documents');
    }
  }, [accountId, contactId, contactUniversity]);

  useEffect(() => {
    void load();
  }, [load]);

  const guard = async (fn: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      console.error(failure, e);
      toast.error(e instanceof Error && e.message ? e.message : failure);
    } finally {
      setBusy(false);
    }
  };

  const preview = async (documentId: string) => {
    try {
      const res = await fetch(`/api/applications/documents/${documentId}/url`, {
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !body.url) {
        toast.error(body.error ?? 'Could not open the file');
        return;
      }
      window.open(body.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      console.error('Failed to open document:', e);
      toast.error('Could not open the file');
    }
  };

  const startUpload = (docType: string | null) => {
    setUploadType(docType);
    fileInput.current?.click();
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error('The file is larger than 16 MB');
      return;
    }
    void guard(async () => {
      const form = new FormData();
      form.set('file', file);
      form.set('contactId', contactId);
      if (uploadType) form.set('docType', uploadType);
      const res = await fetch('/api/applications/documents', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? 'Upload failed');
      }
      toast.success('File uploaded');
    }, 'Could not upload the file');
  };

  const status = (d: ContactDocument) => (
    <span className="text-muted-foreground text-[10px]">
      {d.status === 'verified'
        ? 'verified'
        : d.status === 'rejected'
          ? 'rejected'
          : 'received'}
      {d.uploadedToPortalAt ? `, on portal ${day(d.uploadedToPortalAt)}` : ''}
    </span>
  );

  const docActions = (d: ContactDocument) => (
    <div className="mt-1 flex items-center gap-3">
      {d.fileDeletedAt ? (
        <span className="text-muted-foreground text-[10px]">
          file deleted on {day(d.fileDeletedAt)}
        </span>
      ) : d.storagePath ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1 text-xs"
          onClick={() => void preview(d.id)}
        >
          <Eye className="mr-1 h-3 w-3" aria-hidden="true" />
          Preview
        </Button>
      ) : (
        <span className="text-muted-foreground text-[10px]">
          not stored yet (verify to archive)
        </span>
      )}
      {canEdit && (
        <label className="text-muted-foreground flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={d.uploadedToPortalAt != null}
            disabled={busy}
            onChange={(e) =>
              void guard(
                () =>
                  setDocumentUploaded(
                    createClient(),
                    d.id,
                    userId,
                    e.target.checked
                  ),
                'Could not update the document'
              )
            }
          />
          Uploaded to portal
        </label>
      )}
    </div>
  );

  return (
    <div className="space-y-3 p-4" aria-busy={busy || !view}>
      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFile}
      />

      {canEdit && (
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            disabled={busy || !view}
            onClick={() =>
              void guard(async () => {
                const n = await markAllUploaded(createClient(), contactId);
                toast.success(
                  n === 0
                    ? 'Nothing left to mark'
                    : `${n} document(s) marked uploaded`
                );
              }, 'Could not mark the documents')
            }
          >
            All required documents uploaded
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => startUpload(null)}
          >
            <Upload className="mr-1 h-3 w-3" aria-hidden="true" />
            Upload a file
          </Button>
        </div>
      )}

      {!view ? (
        <p className="text-muted-foreground text-xs">Loading...</p>
      ) : (
        <>
          <div className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
            Required documents
          </div>
          {view.required.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No required list for this university.
            </p>
          ) : (
            <ul className="space-y-2">
              {view.required.map((r) => (
                <li key={r.docType} className="bg-muted rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-foreground text-sm">{r.label}</span>
                    {r.doc ? (
                      status(r.doc)
                    ) : (
                      <span className="text-muted-foreground text-[10px]">
                        missing
                      </span>
                    )}
                  </div>
                  {r.doc ? docActions(r.doc) : null}
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-1 h-6 px-1 text-xs"
                      disabled={busy}
                      onClick={() => startUpload(r.docType)}
                    >
                      <Upload className="mr-1 h-3 w-3" aria-hidden="true" />
                      {r.doc ? 'Replace' : 'Upload'}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {view.other.length > 0 && (
            <>
              <div className="text-muted-foreground pt-2 text-xs font-medium tracking-wider uppercase">
                Other files
              </div>
              <ul className="space-y-2">
                {view.other.map((d) => (
                  <li key={d.id} className="bg-muted rounded-lg px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-foreground text-sm">
                        {d.docType ?? 'Unsorted'}, {day(d.createdAt)}
                      </span>
                      {status(d)}
                    </div>
                    {docActions(d)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {canKeepFiles && (
        <div className="border-border flex items-center justify-between gap-2 border-t pt-3">
          <label
            htmlFor={`retain-${contactId}`}
            className="text-foreground text-xs"
          >
            Keep files after enrolment
          </label>
          <Switch
            id={`retain-${contactId}`}
            checked={app?.retainFiles ?? false}
            disabled={busy || !view}
            onCheckedChange={(checked) =>
              void guard(
                () =>
                  saveApplication(createClient(), {
                    accountId,
                    contactId,
                    retainFiles: checked === true,
                  }),
                'Could not change Keep files'
              )
            }
          />
        </div>
      )}
    </div>
  );
}
