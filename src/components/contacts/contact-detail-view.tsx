'use client';

import { useState, useEffect, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { formatCurrency } from '@/lib/currency';
import { toast } from 'sonner';
import type {
  Contact,
  ContactSource,
  Tag,
  ContactNote,
  CustomField,
  Deal,
} from '@/types';
import { CONTACT_SOURCES } from '@/lib/contacts/source';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ContactFollowupsTab } from '@/components/followups/contact-followups-tab';
import { PortalCredentialsTab } from '@/components/contacts/portal-credentials-tab';
import { StudentPayments } from '@/components/payments/student-payments';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Loader2,
  Plus,
  Trash2,
  Save,
  DollarSign,
} from 'lucide-react';

interface ContactDetailViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null;
  onUpdated: () => void;
}

export function ContactDetailView({
  open,
  onOpenChange,
  contactId,
  onUpdated,
}: ContactDetailViewProps) {
  const supabase = createClient();
  const { accountId, defaultCurrency } = useAuth();

  const [contact, setContact] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedPhone, setCopiedPhone] = useState(false);

  // Details tab
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editCompany, setEditCompany] = useState('');
  const [editUniversityRoll, setEditUniversityRoll] = useState('');
  const [editSource, setEditSource] = useState<ContactSource>('organic');
  const [editSourceDetail, setEditSourceDetail] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Tags tab
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [contactTagIds, setContactTagIds] = useState<string[]>([]);
  const [savingTags, setSavingTags] = useState(false);

  // Notes tab
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [newNote, setNewNote] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNotes, setLoadingNotes] = useState(false);

  // Custom fields tab
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [loadingCustom, setLoadingCustom] = useState(false);

  // Deals tab
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loadingDeals, setLoadingDeals] = useState(false);

  const fetchContact = useCallback(async () => {
    if (!contactId) return;
    setLoading(true);

    const { data } = await supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (data) {
      setContact(data);
      setEditName(data.name ?? '');
      setEditPhone(data.phone);
      setEditEmail(data.email ?? '');
      setEditCompany(data.company ?? '');
      setEditUniversityRoll(data.university_roll_number ?? '');
      setEditSource(data.source ?? 'organic');
      setEditSourceDetail(data.source_detail ?? '');
    }
    setLoading(false);
  }, [contactId, supabase]);

  const fetchTags = useCallback(async () => {
    if (!contactId) return;

    const [tagsRes, contactTagsRes] = await Promise.all([
      supabase.from('tags').select('*').order('name'),
      supabase
        .from('contact_tags')
        .select('tag_id')
        .eq('contact_id', contactId),
    ]);

    if (tagsRes.data) setAllTags(tagsRes.data);
    if (contactTagsRes.data) {
      setContactTagIds(contactTagsRes.data.map((ct) => ct.tag_id));
    }
  }, [contactId, supabase]);

  const fetchNotes = useCallback(async () => {
    if (!contactId) return;
    setLoadingNotes(true);

    const { data } = await supabase
      .from('contact_notes')
      .select('*')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });

    if (data) setNotes(data);
    setLoadingNotes(false);
  }, [contactId, supabase]);

  const fetchCustomFields = useCallback(async () => {
    if (!contactId) return;
    setLoadingCustom(true);

    const [fieldsRes, valuesRes] = await Promise.all([
      supabase.from('custom_fields').select('*').order('field_name'),
      supabase
        .from('contact_custom_values')
        .select('*')
        .eq('contact_id', contactId),
    ]);

    if (fieldsRes.data) setCustomFields(fieldsRes.data);
    if (valuesRes.data) {
      const map: Record<string, string> = {};
      valuesRes.data.forEach((v) => {
        map[v.custom_field_id] = v.value ?? '';
      });
      setCustomValues(map);
    }
    setLoadingCustom(false);
  }, [contactId, supabase]);

  const fetchDeals = useCallback(async () => {
    if (!contactId) return;
    setLoadingDeals(true);
    const { data } = await supabase
      .from('deals')
      .select('*, stage:pipeline_stages(*)')
      .eq('contact_id', contactId)
      .order('created_at', { ascending: false });
    setDeals((data ?? []) as Deal[]);
    setLoadingDeals(false);
  }, [contactId, supabase]);

  useEffect(() => {
    if (open && contactId) {
      fetchContact();
      fetchTags();
      fetchNotes();
      fetchCustomFields();
      fetchDeals();
    }
  }, [
    open,
    contactId,
    fetchContact,
    fetchTags,
    fetchNotes,
    fetchCustomFields,
    fetchDeals,
  ]);

  async function copyPhone() {
    if (!contact) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopiedPhone(true);
    setTimeout(() => setCopiedPhone(false), 2000);
  }

  async function saveDetails() {
    if (!contactId || !editPhone.trim()) {
      toast.error('Phone number is required');
      return;
    }

    setSavingDetails(true);
    const { error } = await supabase
      .from('contacts')
      .update({
        name: editName.trim() || null,
        phone: editPhone.trim(),
        email: editEmail.trim() || null,
        company: editCompany.trim() || null,
        university_roll_number: editUniversityRoll.trim() || null,
        source: editSource,
        source_detail:
          editSource === 'reference' ? editSourceDetail.trim() || null : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', contactId);

    if (error) {
      toast.error('Failed to update contact');
    } else {
      toast.success('Contact updated');
      fetchContact();
      onUpdated();
    }
    setSavingDetails(false);
  }

  async function toggleTag(tagId: string) {
    if (!contactId) return;
    setSavingTags(true);

    const isSelected = contactTagIds.includes(tagId);

    if (isSelected) {
      const { error } = await supabase
        .from('contact_tags')
        .delete()
        .eq('contact_id', contactId)
        .eq('tag_id', tagId);
      if (!error) {
        setContactTagIds((prev) => prev.filter((id) => id !== tagId));
        onUpdated();
      }
    } else {
      const { error } = await supabase
        .from('contact_tags')
        .insert({ contact_id: contactId, tag_id: tagId });
      if (!error) {
        setContactTagIds((prev) => [...prev, tagId]);
        onUpdated();
      }
    }
    setSavingTags(false);
  }

  async function addNote() {
    if (!contactId || !newNote.trim()) return;
    setSavingNote(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user || !accountId) {
      toast.error('Not authenticated');
      setSavingNote(false);
      return;
    }

    const { error } = await supabase.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: user.id,
      note_text: newNote.trim(),
    });

    if (error) {
      toast.error('Failed to add note');
    } else {
      setNewNote('');
      fetchNotes();
      toast.success('Note added');
    }
    setSavingNote(false);
  }

  async function deleteNote(noteId: string) {
    const { error } = await supabase
      .from('contact_notes')
      .delete()
      .eq('id', noteId);

    if (error) {
      toast.error('Failed to delete note');
    } else {
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      toast.success('Note deleted');
    }
  }

  async function saveCustomFields() {
    if (!contactId) return;
    setSavingCustom(true);

    try {
      // Delete existing values and re-insert
      await supabase
        .from('contact_custom_values')
        .delete()
        .eq('contact_id', contactId);

      const rows = Object.entries(customValues)
        .filter(([, val]) => val.trim())
        .map(([fieldId, val]) => ({
          contact_id: contactId,
          custom_field_id: fieldId,
          value: val.trim(),
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from('contact_custom_values')
          .insert(rows);
        if (error) throw error;
      }

      toast.success('Custom fields saved');
    } catch {
      toast.error('Failed to save custom fields');
    }
    setSavingCustom(false);
  }

  function getInitials(name?: string | null) {
    if (!name) return '?';
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground w-full p-0 sm:max-w-lg"
      >
        {loading || !contact ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="text-primary size-6 animate-spin" />
          </div>
        ) : (
          <div className="flex h-full flex-col">
            {/* Header */}
            <SheetHeader className="border-border/50 border-b p-4">
              <div className="flex items-center gap-3">
                <Avatar className="bg-muted border-border size-12 border">
                  <AvatarFallback className="bg-primary/10 text-primary text-sm font-medium">
                    {getInitials(contact.name)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <SheetTitle className="text-popover-foreground truncate">
                    {contact.name || 'Unknown'}
                  </SheetTitle>
                  <SheetDescription className="text-muted-foreground mt-0.5 text-xs">
                    Contact details
                  </SheetDescription>
                  <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-3 text-xs">
                    <button
                      onClick={copyPhone}
                      className="hover:text-primary flex cursor-pointer items-center gap-1 transition-colors"
                    >
                      <Phone className="size-3" />
                      {contact.phone}
                      {copiedPhone ? (
                        <Check className="text-primary size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                    {contact.email && (
                      <span className="flex items-center gap-1">
                        <Mail className="size-3" />
                        {contact.email}
                      </span>
                    )}
                    {contact.company && (
                      <span className="flex items-center gap-1">
                        <Building2 className="size-3" />
                        {contact.company}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </SheetHeader>

            {/* Tabs */}
            <Tabs
              defaultValue="details"
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList className="bg-muted/50 border-border mx-4 mt-3 border-b">
                <TabsTrigger
                  value="details"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Details
                </TabsTrigger>
                <TabsTrigger
                  value="tags"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Tags
                </TabsTrigger>
                <TabsTrigger
                  value="notes"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Notes
                </TabsTrigger>
                <TabsTrigger
                  value="custom"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Custom Fields
                </TabsTrigger>
                <TabsTrigger
                  value="deals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Deals
                </TabsTrigger>
                <TabsTrigger
                  value="followups"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Follow-ups
                </TabsTrigger>
                <TabsTrigger
                  value="payments"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Payments
                </TabsTrigger>
                <TabsTrigger
                  value="portals"
                  className="data-active:bg-muted data-active:text-primary text-muted-foreground"
                >
                  Portals
                </TabsTrigger>
              </TabsList>

              {/* Details Tab */}
              <TabsContent
                value="details"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Name
                    </Label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Phone <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      value={editPhone}
                      onChange={(e) => setEditPhone(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Email
                    </Label>
                    <Input
                      value={editEmail}
                      onChange={(e) => setEditEmail(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Company
                    </Label>
                    <Input
                      value={editCompany}
                      onChange={(e) => setEditCompany(e.target.value)}
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      University Roll No.
                    </Label>
                    <Input
                      value={editUniversityRoll}
                      onChange={(e) => setEditUniversityRoll(e.target.value)}
                      placeholder="Issued by the university after admission"
                      className="bg-muted border-border text-foreground h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-muted-foreground text-xs">
                      Source
                    </Label>
                    {/* Unlike the create form, every value is selectable here —
                        this is the correction surface for mis-attributions. */}
                    <select
                      value={editSource}
                      onChange={(e) =>
                        setEditSource(e.target.value as ContactSource)
                      }
                      className="bg-muted border-border text-foreground h-8 w-full rounded-md border px-2 text-sm"
                    >
                      {CONTACT_SOURCES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {editSource === 'reference' && (
                    <div className="space-y-1.5">
                      <Label className="text-muted-foreground text-xs">
                        Referred by
                      </Label>
                      <Input
                        value={editSourceDetail}
                        onChange={(e) => setEditSourceDetail(e.target.value)}
                        placeholder="Name of the person who referred them"
                        className="bg-muted border-border text-foreground h-8 text-sm"
                      />
                    </div>
                  )}
                  <Button
                    onClick={saveDetails}
                    disabled={savingDetails}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                    size="sm"
                  >
                    {savingDetails ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                    Save Changes
                  </Button>
                </div>
              </TabsContent>

              {/* Tags Tab */}
              <TabsContent
                value="tags"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                <div className="space-y-3">
                  <p className="text-muted-foreground text-xs">
                    Click a tag to add or remove it from this contact.
                  </p>
                  {allTags.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      No tags available. Create tags in Settings.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {allTags.map((tag) => {
                        const selected = contactTagIds.includes(tag.id);
                        return (
                          <button
                            key={tag.id}
                            onClick={() => toggleTag(tag.id)}
                            disabled={savingTags}
                            className={`inline-flex cursor-pointer items-center rounded-full px-3 py-1 text-xs font-medium transition-all ${
                              selected
                                ? 'ring-primary ring-offset-border ring-2 ring-offset-1'
                                : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{
                              backgroundColor: tag.color + '20',
                              color: tag.color,
                            }}
                          >
                            {selected && <Check className="mr-1 size-3" />}
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* Notes Tab */}
              <TabsContent
                value="notes"
                className="flex min-h-0 flex-1 flex-col px-4 py-3"
              >
                <div className="mb-3 space-y-2">
                  <Textarea
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    placeholder="Write a note..."
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground min-h-[60px] resize-none text-sm"
                  />
                  <Button
                    onClick={addNote}
                    disabled={!newNote.trim() || savingNote}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                  >
                    {savingNote ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Plus className="size-3.5" />
                    )}
                    Add Note
                  </Button>
                </div>

                <div className="flex-1 space-y-2 overflow-y-auto">
                  {loadingNotes ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="text-muted-foreground size-5 animate-spin" />
                    </div>
                  ) : notes.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      No notes yet.
                    </p>
                  ) : (
                    notes.map((note) => (
                      <div
                        key={note.id}
                        className="bg-muted/50 border-border/50 group rounded-lg border p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-muted-foreground flex-1 text-sm whitespace-pre-wrap">
                            {note.note_text}
                          </p>
                          <button
                            onClick={() => deleteNote(note.id)}
                            className="text-muted-foreground shrink-0 cursor-pointer opacity-0 transition-all group-hover:opacity-100 hover:text-red-400"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <p className="text-muted-foreground mt-1.5 text-xs">
                          {new Date(note.created_at).toLocaleDateString(
                            'en-US',
                            {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            }
                          )}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </TabsContent>

              {/* Custom Fields Tab */}
              <TabsContent
                value="custom"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {loadingCustom ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="text-muted-foreground size-5 animate-spin" />
                  </div>
                ) : customFields.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    No custom fields defined. Create them in Settings.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {customFields.map((field) => (
                      <div key={field.id} className="space-y-1.5">
                        <Label className="text-muted-foreground text-xs capitalize">
                          {field.field_name}
                        </Label>
                        <Input
                          value={customValues[field.id] ?? ''}
                          onChange={(e) =>
                            setCustomValues((prev) => ({
                              ...prev,
                              [field.id]: e.target.value,
                            }))
                          }
                          placeholder={`Enter ${field.field_name}...`}
                          className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 text-sm"
                        />
                      </div>
                    ))}
                    <Button
                      onClick={saveCustomFields}
                      disabled={savingCustom}
                      className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                      size="sm"
                    >
                      {savingCustom ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Save className="size-3.5" />
                      )}
                      Save Custom Fields
                    </Button>
                  </div>
                )}
              </TabsContent>

              {/* Deals Tab */}
              <TabsContent
                value="deals"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {loadingDeals ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="text-primary size-5 animate-spin" />
                  </div>
                ) : deals.length === 0 ? (
                  <p className="text-muted-foreground text-xs">No deals yet</p>
                ) : (
                  <div className="space-y-2">
                    {deals.map((deal) => (
                      <div
                        key={deal.id}
                        className="border-border bg-muted/50 rounded-lg border p-3"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-foreground text-sm font-medium">
                            {deal.title}
                          </p>
                          {deal.stage && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                              style={{
                                backgroundColor: `${deal.stage.color}20`,
                                color: deal.stage.color,
                              }}
                            >
                              {deal.stage.name}
                            </span>
                          )}
                        </div>
                        <div className="text-muted-foreground mt-1.5 flex items-center justify-between text-xs">
                          <span className="flex items-center gap-1">
                            <DollarSign className="size-3" />
                            {formatCurrency(
                              deal.value ?? 0,
                              deal.currency || defaultCurrency
                            )}
                          </span>
                          {deal.status && deal.status !== 'open' && (
                            <span
                              className={
                                deal.status === 'won'
                                  ? 'text-primary'
                                  : 'text-red-400'
                              }
                            >
                              {deal.status}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* Follow-ups Tab (migration 054) — manual log merged with the
                  automated ladder's sends. */}
              <TabsContent
                value="followups"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {contactId && (
                  <ContactFollowupsTab
                    contactId={contactId}
                    contactName={contact?.name}
                  />
                )}
              </TabsContent>

              {/* Payments Tab (migration 056) — the student's fee plan,
                  schedule and every payment against it. */}
              <TabsContent
                value="payments"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {contactId && (
                  <StudentPayments
                    contactId={contactId}
                    contactName={contact?.name}
                    onChanged={onUpdated}
                  />
                )}
              </TabsContent>

              {/* Portals Tab (migration 072) — saved student portal logins,
                  server-only data path, audited reveals. */}
              <TabsContent
                value="portals"
                className="flex-1 overflow-y-auto px-4 py-3"
              >
                {contactId && <PortalCredentialsTab contactId={contactId} />}
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
