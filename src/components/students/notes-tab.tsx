'use client';

import { useState, useCallback } from 'react';
import { StickyNote, Plus } from 'lucide-react';
import { format } from 'date-fns';

import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { ContactNote } from '@/types';
import { Button } from '@/components/ui/button';

interface NotesTabProps {
  contactId: string;
  notes: ContactNote[];
  onAdded: (n: ContactNote) => void;
}

/** Add and read notes on this record (moved from the inbox contact sidebar unchanged). */
export function NotesTab({ contactId, notes, onAdded }: NotesTabProps) {
  const { accountId } = useAuth();
  const [newNote, setNewNote] = useState('');
  const [addingNote, setAddingNote] = useState(false);

  const handleAddNote = useCallback(async () => {
    if (!newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from('contact_notes')
      .insert({
        contact_id: contactId,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      onAdded(data);
      setNewNote('');
    }
    setAddingNote(false);
  }, [contactId, newNote, accountId, onAdded]);

  return (
    <div>
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs font-medium tracking-wider uppercase">
        <StickyNote className="h-3 w-3" />
        Notes
      </div>
      <div className="mt-2">
        <div className="flex gap-2">
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="Add a note..."
            rows={2}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 flex-1 resize-none rounded-lg border px-3 py-2 text-xs outline-none"
          />
          <Button
            size="sm"
            className="bg-primary hover:bg-primary/90 h-auto px-2"
            onClick={handleAddNote}
            disabled={!newNote.trim() || addingNote}
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        <div className="mt-2 space-y-2">
          {notes.map((note) => (
            <div key={note.id} className="bg-muted rounded-lg px-3 py-2">
              <p className="text-muted-foreground text-xs whitespace-pre-wrap">
                {note.note_text}
              </p>
              <p className="text-muted-foreground mt-1 text-[10px]">
                {format(new Date(note.created_at), 'MMM d, yyyy HH:mm')}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
