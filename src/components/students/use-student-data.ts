'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Contact, Deal, ContactNote, PipelineStage, Tag } from '@/types';
import { toast } from 'sonner';

export type ContactTag = Tag & { contact_tag_id: string };

/** The student's deals + stages, notes and tags, moved from the inbox contact sidebar unchanged (R1b). */
export function useStudentData(contact: Contact) {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<ContactTag[]>([]);

  const reload = useCallback(async () => {
    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from('deals')
        .select('*, stage:pipeline_stages(*)')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('contact_notes')
        .select('*')
        .eq('contact_id', contact.id)
        .order('created_at', { ascending: false }),
      supabase
        .from('contact_tags')
        .select('id, tag_id, tags(*)')
        .eq('contact_id', contact.id),
    ]);

    if (dealsRes.data) {
      setDeals(dealsRes.data);
      const pipelineIds = [
        ...new Set((dealsRes.data as Deal[]).map((d) => d.pipeline_id)),
      ];
      if (pipelineIds.length > 0) {
        const { data: stageRows, error: stageError } = await supabase
          .from('pipeline_stages')
          .select('*')
          .in('pipeline_id', pipelineIds)
          .order('position');
        if (stageError) {
          // Without stages the picker falls back to a read-only badge: say why.
          console.error('Failed to load stages:', stageError.message);
          toast.error('Could not load stages. Refresh to change the stage.');
        }
        setStages((stageRows as PipelineStage[]) ?? []);
      } else {
        setStages([]);
      }
    }
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, [reload]);

  // A move made by a person also protects the lead from the Lost sweep for the
  // next 14 days (migration 091).
  const changeStage = useCallback(
    async (dealId: string, stageId: string) => {
      const { data, error } = await createClient()
        .from('deals')
        .update({ stage_id: stageId })
        .eq('id', dealId)
        .select('id');
      if (error || !data?.length) {
        console.error('Failed to change stage:', error?.message ?? 'no row');
        toast.error('Could not change the stage');
        return;
      }
      setDeals((prev) =>
        prev.map((d) =>
          d.id === dealId
            ? {
                ...d,
                stage_id: stageId,
                stage: stages.find((s) => s.id === stageId) ?? d.stage,
              }
            : d
        )
      );
    },
    [stages]
  );

  const addNote = useCallback((note: ContactNote) => {
    setNotes((prev) => [note, ...prev]);
  }, []);

  return { deals, stages, notes, tags, reload, changeStage, addNote };
}
